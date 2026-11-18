import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiRoot } from '../../core/api-base';
import { AuthStateService } from '../../core/auth-state.service';

/**
 * Members of the current workspace. Everyone sees the list; Owners and Admins invite, change
 * roles and remove (the server enforces every rule; controls are only hidden here). Only Owners
 * see Owner-related controls, and nobody gets controls for their own membership.
 */
/** One group of the permissions panel: a menu item (section) and the permissions that belong to it. */
interface MenuGroup { key: string; title: string; icon: string; module?: string; caps: string[]; tabs?: boolean; crm?: boolean; calls?: boolean; note?: string }

@Component({
  selector: 'app-members',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './members.component.html',
  styleUrls: ['../command/command-center.component.css', './members.component.css']
})
export class MembersComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();

  private base = `${apiRoot()}/api/v1/workspace`;
  data: any = null;
  loading = true;
  error = '';
  busy = '';
  inviteForm = { email: '', role: 'Member' };
  /** Sections chosen for the invitation (all by default). */
  inviteModules = new Set<string>();
  /** The member whose section access is being edited, and the working selection. */
  editing: { userId: number; modules: Set<string> } | null = null;
  // The link of the last invitation created or resent (shown once, for sharing when not emailed).
  lastLink: { email: string; link: string; emailed: boolean; emailError: string | null } | null = null;

  constructor(private http: HttpClient, private auth: AuthStateService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.http.get<any>(`${this.base}/members`).subscribe({
      next: r => {
        const first = !this.data;
        this.data = r; this.loading = false; this.error = '';
        if (first) this.inviteModules = new Set((r.modules || []).map((m: any) => m.key));
      },
      error: e => { this.loading = false; this.error = this.err(e); }
    });
  }

  /** Roles this user may assign: Owners may assign any role, Admins all but Owner. */
  get assignableRoles(): string[] {
    const roles: string[] = this.data?.roles || [];
    return this.data?.canManageOwners ? roles : roles.filter(r => r !== 'Workspace Owner');
  }

  /**
   * "Log in as user" (Owners/Admins): only members with a lower role than yours. The server checks it too
   * (and never allows the platform admin or a session opened this way).
   */
  canLoginAs(m: any): boolean {
    const rank = (r: string) => (r === 'Workspace Owner' ? 3 : r === 'Workspace Admin' ? 2 : 1);
    const me = (this.data?.members || []).find((x: any) => x.isYou);
    return !!this.data?.canManage && !!me && !m.isYou && m.status === 'Active' && rank(m.role) < rank(me.role);
  }

  loginAs(m: any): void {
    const who = m.displayName || m.email;
    if (!confirm(`Log in as ${who}?\n\nYou will be signed out and see Marketech.ai exactly as ${who} does, in this workspace, for up to an hour. Their password is not changed. Everything you do is recorded as done by you on their behalf. Sign out to end it, then sign in as yourself.`)) return;
    this.busy = 'login-as';
    this.http.post<any>(`${this.base}/members/${m.userId}/login-as`, {}).subscribe({
      next: r => { this.auth.setSession(r); window.location.href = '/'; },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  canEdit(m: any): boolean {
    return !!this.data?.canManage && !m.isYou && m.status === 'Active' && (m.role !== 'Workspace Owner' || this.data.canManageOwners);
  }

  /** Owners and Admins always have every section. */
  fullAccess(role: string): boolean {
    return (this.data?.fullAccessRoles || []).includes(role);
  }

  moduleLabel(key: string): string {
    return this.data?.modules?.find((m: any) => m.key === key)?.label || key;
  }

  accessText(v: any): string {
    if (!v || v.fullAccessRole) return 'All sections (role)';
    if (v.all || v.keys.length === this.data?.modules?.length) return 'All sections';
    return v.keys.length ? v.keys.map((k: string) => this.moduleLabel(k)).join(', ') : 'No sections';
  }

  toggle(set: Set<string>, key: string): void {
    set.has(key) ? set.delete(key) : set.add(key);
  }

  editAccess(m: any): void {
    this.editing = this.editing?.userId === m.userId ? null : { userId: m.userId, modules: new Set(m.modules?.keys || []) };
  }

  saveAccess(m: any): void {
    if (!this.editing) return;
    this.busy = 'modules';
    const modules = (this.data.modules || []).map((x: any) => x.key).filter((k: string) => this.editing!.modules.has(k));
    this.http.put<any>(`${this.base}/members/${m.userId}/modules`, { modules }).subscribe({
      next: () => { this.busy = ''; this.editing = null; this.toast.emit(`Section access updated for ${m.displayName || m.email}.`); this.load(); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  // ---------------------------------------------------------------- Permissions (one panel per member)

  /** The member whose permissions are being edited: sections, calls, email grants and CRM access. */
  perm: { userId: number; modules: Set<string>; mailTabs: Set<string>; calls: boolean; crmRole: string | null; grants: Record<string, string> } | null = null;

  editPermissions(m: any): void {
    if (this.perm?.userId === m.userId) { this.perm = null; return; }
    this.perm = { userId: m.userId, modules: new Set(m.modules?.keys || []), mailTabs: new Set(m.mailTabs?.keys || (this.data?.mailTabs || []).map((t: any) => t.key)),
      calls: !!m.callGrant, crmRole: m.crmRole || null, grants: { ...(m.grants || {}) } };
  }

  crmAllowsCalls(role: string | null): boolean { return ['sales', 'support', 'manager'].includes(role || ''); }

  grantOn(m: any, cap: string): boolean {
    const g = this.perm?.grants[cap];
    return g === 'role' || g === 'granted';
  }

  /** Transactional email needs the person to be able to send email in the first place (from the role). */
  grantPossible(cap: string): boolean {
    return cap !== 'mail.send_transactional' || this.perm?.grants['mail.send_transactional'] !== 'not_eligible';
  }

  grantHelp(m: any, cap: string): string {
    const g = this.perm?.grants[cap];
    if (g === 'role') return `Included in the ${m.role} role.`;
    const perf: Record<string, string> = {
      'leads.email': 'Email a lead from the Leads page (their own address), without Mail Center. Opt-outs and the unsubscribe link apply as usual.',
      'mail.configure': 'Open Mail Center → Settings and change the mailbox, marketing approval, tracking and Amazon SES settings. Also opens the Compose send report.',
      'mail.view_all': "See everyone's drafts, sent emails, replies and campaigns in Mail Center, and approve them. Without it, people see only their own mail.",
      'performance.view_team': 'See every member in Team Performance and their individual pages, not only their own.',
      'performance.manage_targets': 'Set and change staff targets (per person or role).',
      'performance.compare': 'Compare staff side by side (with team access).',
      'performance.export': 'Export the team report to Excel (with team access). Everyone can export their own.',
      'performance.view_transcripts': 'Open other people\'s call transcripts (with team access). Everyone can open their own.',
      'performance.configure_scoring': 'Change how the performance score is calculated.',
      'performance.schedule_reports': 'Set up weekly or monthly performance report emails (with team access).'
    };
    if (perf[cap] && g === 'not_eligible') {
      return cap.startsWith('performance.') ? `The ${m.role} role cannot see analytics.` : cap.startsWith('leads.') ? `The ${m.role} role cannot see leads.` : `Not available for the ${m.role} role.`;
    }
    if (perf[cap]) return perf[cap];
    if (g === 'not_eligible') return cap === 'mail.send' ? `The ${m.role} role cannot write email.` : `Needs a role that sends email (Marketing Manager, Approver).`;
    return cap === 'mail.send' ? 'Send email themselves, not only write drafts.' : 'Compose email that can reach people who opted out of marketing.';
  }

  grantIcon(cap: string): string { return cap.startsWith('performance.') ? '📊' : '✉'; }

  /**
   * The permissions panel, one group per menu item in the sidebar's order. A group with a section
   * (module) has its on/off checkbox in the header; the related permissions are listed under it.
   */
  readonly menuGroups: MenuGroup[] = [
    { key: 'products', title: 'Digital Products', icon: '📦', module: 'products', caps: [] },
    { key: 'crm', title: 'CRM', icon: '💼', caps: [], crm: true, note: 'Platform-wide contacts, companies and deals. Sales, Support and Manager can also make calls.' },
    { key: 'leads', title: 'Leads', icon: '👥', module: 'leads', caps: ['leads.email'], calls: true },
    { key: 'appointments', title: 'Demos', icon: '📅', module: 'appointments', caps: [] },
    { key: 'mail', title: 'Mail Center & email campaigns', icon: '✉', module: 'mail', tabs: true, caps: ['mail.send', 'mail.send_transactional', 'mail.view_all', 'mail.configure'] },
    { key: 'social', title: 'Social Media Marketing', icon: '📣', module: 'social', caps: [] },
    { key: 'campaigns', title: 'AI Campaigns', icon: '🎯', module: 'campaigns', caps: [] },
    { key: 'voice', title: 'Mark Voice Center', icon: '🎙', module: 'voice', caps: [] },
    { key: 'perf', title: 'Team Performance', icon: '📊', caps: ['performance.view_team', 'performance.compare', 'performance.export', 'performance.view_transcripts', 'performance.manage_targets', 'performance.configure_scoring', 'performance.schedule_reports'],
      note: 'Everyone can open it and see their own figures. Most of these need “View team performance” first.' }
  ];

  /** Groups shown: sections the server knows, CRM only for the platform admin, plus "Other" for new permissions. */
  get shownMenuGroups(): MenuGroup[] {
    const mods = new Set((this.data?.modules || []).map((x: any) => x.key));
    const known = new Set(this.menuGroups.flatMap(g => g.caps));
    const other = (this.data?.grantable || []).filter((g: any) => !known.has(g.capability)).map((g: any) => g.capability);
    return [
      ...this.menuGroups.filter(g => (g.module ? mods.has(g.module) : true) && (!g.crm || !!this.data?.crmRoles) && (g.module || g.crm || this.groupGrants(g).length)),
      ...(other.length ? [{ key: 'other', title: 'Other', icon: '⚙', caps: other } as MenuGroup] : [])
    ];
  }

  /** The section's description from the server (shown under the group title). */
  moduleDesc(key?: string): string { return key ? (this.data?.modules || []).find((x: any) => x.key === key)?.description || '' : ''; }

  /** Whether a group's section is on (groups without a section are always open). */
  groupOn(m: any, g: any): boolean {
    if (g.crm) return !!this.perm?.crmRole;
    return !g.module || !!m.modules?.fullAccessRole || !!this.perm?.modules.has(g.module);
  }

  /** Ticking a permission or tab of a section that is off also turns the section on (its header checkbox). */
  toggleSub(m: any, g: any, ticking: boolean): void {
    if (!ticking || !this.perm || !g.module || m.modules?.fullAccessRole) return;
    this.perm.modules.add(g.module);
  }

  /** Make calls (Leads): the company phone line; only the platform admin changes it (the server checks). */
  toggleCalls(): void {
    if (!this.perm) return;
    this.perm.calls = !this.perm.calls;
  }

  /**
   * After unticking: a section with nothing left ticked (no tab, no permission) is turned off too.
   * Permissions that come with the role cannot be unticked, so they keep their section on.
   */
  afterUntick(m: any, g: any): void {
    if (!this.perm || !g.module || m.modules?.fullAccessRole || !this.perm.modules.has(g.module)) return;
    const tabsOn = g.tabs ? this.perm.mailTabs.size > 0 : false;
    const grantsOn = this.groupGrants(g).some((x: any) => this.grantOn(m, x.capability))
      || (g.calls && !!this.data?.crmRoles && (this.perm.calls || this.crmAllowsCalls(this.perm.crmRole)));
    const hasSubs = (g.tabs && (this.data?.mailTabs || []).length) || this.groupGrants(g).length || (g.calls && this.data?.crmRoles);
    if (hasSubs && !tabsOn && !grantsOn) this.perm.modules.delete(g.module);
  }

  /** CRM header checkbox: on gives the lowest level (Viewer; the level is chosen below), off removes access. */
  toggleCrm(): void {
    if (!this.perm) return;
    const levels: string[] = this.data?.crmRoles || [];
    this.perm.crmRole = this.perm.crmRole ? null : (levels.includes('viewer') ? 'viewer' : levels[0] || null);
  }

  /** Short titles (the server's labels are longer); falls back to the server label. */
  private readonly shortLabels: Record<string, string> = {
    'leads.email': 'Email leads',
    'mail.send': 'Send email',
    'mail.send_transactional': 'Send transactional email',
    'mail.view_all': 'View all mail',
    'mail.configure': 'Manage mail settings',
    'performance.view_team': 'View team performance',
    'performance.compare': 'Compare staff',
    'performance.export': 'Export team reports',
    'performance.view_transcripts': 'View others’ call transcripts',
    'performance.manage_targets': 'Manage staff targets',
    'performance.configure_scoring': 'Configure scoring',
    'performance.schedule_reports': 'Schedule report emails'
  };
  grantTitle(g: any): string { return this.shortLabels[g.capability] || g.label; }

  /** The grantable permissions of one group, in the group's order. */
  groupGrants(group: { caps: string[] }): any[] {
    const all = this.data?.grantable || [];
    return group.caps.map(c => all.find((g: any) => g.capability === c)).filter(Boolean);
  }

  /** "2 of 4 on" for a group header. */
  groupCount(m: any, group: any): string {
    const gs = this.groupGrants(group);
    return `${gs.filter(g => this.grantOn(m, g.capability)).length} of ${gs.length} on`;
  }

  /** A tag next to a permission: why it cannot be changed here. */
  grantTag(m: any, cap: string): string | null {
    const g = this.perm?.grants[cap];
    if (g === 'role') return 'In role';
    if (g === 'not_eligible' || !this.grantPossible(cap)) return 'Not for this role';
    return null;
  }

  /** Mail Center tabs: shown under Sections while Mail Center is ticked. */
  setAllMailTabs(on: boolean): void {
    if (!this.perm) return;
    this.perm.mailTabs = new Set(on ? (this.data?.mailTabs || []).map((x: any) => x.key) : []);
  }

  /** Chip text for the members list when some Mail Center tabs are off. */
  mailTabsSummary(m: any): string | null {
    const all = this.data?.mailTabs || [];
    if (!m.mailTabs || m.mailTabs.all || m.mailTabs.fullAccessRole || !m.modules?.keys?.includes('mail')) return null;
    const on = all.filter((t: any) => m.mailTabs.keys.includes(t.key)).map((t: any) => t.label);
    return on.length ? `Mail: ${on.join(', ')}` : 'Mail: no limited tabs';
  }

  setAllModules(on: boolean): void {
    if (!this.perm) return;
    this.perm.modules = new Set(on ? (this.data?.modules || []).map((x: any) => x.key) : []);
  }

  toggleGrant(cap: string): void {
    if (!this.perm) return;
    const g = this.perm.grants[cap];
    if (g === 'granted') this.perm.grants[cap] = 'eligible';
    else if (g === 'eligible') {
      if (cap === 'mail.send_transactional' && !confirm('Transactional email can reach contacts who opted out of marketing. Allow it?')) return;
      this.perm.grants[cap] = 'granted';
    }
  }

  /** Saves only what changed, one request per kind (each is checked and audited by the server). */
  async savePermissions(m: any): Promise<void> {
    const p = this.perm;
    if (!p) return;
    this.busy = 'perm';
    const base = `${this.base}/members/${m.userId}`;
    try {
      if (!m.modules?.fullAccessRole) {
        const keys = (this.data.modules || []).map((x: any) => x.key).filter((k: string) => p.modules.has(k));
        const before = (m.modules?.keys || []).join(',');
        // Mail Center tabs (only sent when they changed; all ticked = all tabs).
        const tabKeys = (this.data.mailTabs || []).map((x: any) => x.key).filter((k: string) => p.mailTabs.has(k));
        const tabsBefore = (m.mailTabs?.keys || (this.data.mailTabs || []).map((x: any) => x.key)).join(',');
        const tabsChanged = !!this.data.mailTabs && tabKeys.join(',') !== tabsBefore;
        if (keys.join(',') !== before || tabsChanged) {
          await firstValueFrom(this.http.put<any>(`${base}/modules`, { modules: keys, ...(tabsChanged ? { mailTabs: tabKeys } : {}) }));
        }
      }
      for (const cap of Object.keys(p.grants)) {
        const was = m.grants?.[cap];
        if (was === p.grants[cap] || !['granted', 'eligible'].includes(p.grants[cap])) continue;
        const url = `${base}/grants/${encodeURIComponent(cap)}`;
        await firstValueFrom(p.grants[cap] === 'granted' ? this.http.put<any>(url, {}) : this.http.delete<any>(url));
      }
      if (this.data.crmRoles && (m.crmRole || null) !== p.crmRole && !m.isYou) await firstValueFrom(this.http.put<any>(`${base}/crm`, { role: p.crmRole }));
      if (this.data.crmRoles && !!m.callGrant !== p.calls && !m.isYou) await firstValueFrom(this.http.put<any>(`${base}/calling`, { enabled: p.calls }));
      this.busy = '';
      this.perm = null;
      this.toast.emit(`Permissions saved for ${m.displayName || m.email}.`);
      this.load();
    } catch (e: any) {
      this.busy = '';
      this.toast.emit(this.err(e));
      this.load();
    }
  }

  /** Platform admin only: CRM access (platform-wide data). */
  setCrm(m: any, role: string): void {
    const value = role || null;
    if ((m.crmRole || null) === value) return;
    this.http.put<any>(`${this.base}/members/${m.userId}/crm`, { role: value }).subscribe({
      next: () => { this.toast.emit(value ? `CRM access (${value}) given to ${m.displayName || m.email}.` : `CRM access removed from ${m.displayName || m.email}.`); this.load(); },
      error: e => { this.toast.emit(this.err(e)); this.load(); }
    });
  }

  invite(): void {
    const email = this.inviteForm.email.trim();
    if (!email) return;
    this.busy = 'invite';
    const body: any = { email, role: this.inviteForm.role };
    if (!this.fullAccess(this.inviteForm.role)) body.modules = (this.data.modules || []).map((x: any) => x.key).filter((k: string) => this.inviteModules.has(k));
    this.http.post<any>(`${this.base}/invitations`, body).subscribe({
      next: r => {
        this.busy = '';
        this.lastLink = { email: r.invitation.email, link: r.link, emailed: r.emailed, emailError: r.emailError };
        this.inviteForm.email = '';
        this.toast.emit(r.emailed ? `Invitation emailed to ${r.invitation.email}.` : `Invitation created for ${r.invitation.email}. Share the link below.`);
        this.load();
      },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  resend(inv: any): void {
    this.busy = `resend-${inv.id}`;
    this.http.post<any>(`${this.base}/invitations/${inv.id}/resend`, {}).subscribe({
      next: r => {
        this.busy = '';
        this.lastLink = { email: r.invitation.email, link: r.link, emailed: r.emailed, emailError: r.emailError };
        this.toast.emit(r.emailed ? `Invitation re-sent to ${r.invitation.email}. The earlier link no longer works.` : 'New link created; the earlier link no longer works.');
        this.load();
      },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); }
    });
  }

  cancel(inv: any): void {
    if (!confirm(`Cancel the invitation for ${inv.email}? The link will stop working.`)) return;
    this.http.post<any>(`${this.base}/invitations/${inv.id}/cancel`, {}).subscribe({
      next: () => { this.toast.emit('Invitation cancelled.'); this.load(); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  changeRole(m: any, role: string): void {
    if (role === m.role) return;
    this.http.patch<any>(`${this.base}/members/${m.userId}`, { role }).subscribe({
      next: () => { this.toast.emit(`${m.displayName || m.email} is now ${role}.`); this.load(); },
      error: e => { this.toast.emit(this.err(e)); this.load(); }
    });
  }

  grantHeading(capability: string): string {
    return capability === 'mail.send_transactional' ? 'Transactional email' : capability;
  }

  /** Grant or revoke a per-member permission (the server checks role eligibility and audits it). */
  setGrant(m: any, g: { capability: string; label: string }, on: boolean): void {
    if (on && !confirm(`Allow ${m.displayName || m.email} to send transactional email from Compose? Transactional email can reach contacts who opted out of marketing.`)) { this.load(); return; }
    this.busy = 'grant';
    const url = `${this.base}/members/${m.userId}/grants/${encodeURIComponent(g.capability)}`;
    (on ? this.http.put<any>(url, {}) : this.http.delete<any>(url)).subscribe({
      next: () => { this.busy = ''; this.toast.emit(`${g.label}: ${on ? 'granted to' : 'removed from'} ${m.displayName || m.email}.`); this.load(); },
      error: e => { this.busy = ''; this.toast.emit(this.err(e)); this.load(); }
    });
  }

  remove(m: any): void {
    if (!confirm(`Remove ${m.displayName || m.email} from this workspace? They lose access immediately.`)) return;
    this.http.delete<any>(`${this.base}/members/${m.userId}`).subscribe({
      next: () => { this.toast.emit('Member removed.'); this.load(); },
      error: e => this.toast.emit(this.err(e))
    });
  }

  async copyLink(): Promise<void> {
    if (!this.lastLink) return;
    try { await navigator.clipboard.writeText(this.lastLink.link); this.toast.emit('Invitation link copied.'); } catch { this.toast.emit('Copy failed: select the link and copy it.'); }
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed.';
  }
}
