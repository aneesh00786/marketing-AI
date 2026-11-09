import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * Members of the current workspace. Everyone sees the list; Owners and Admins invite, change
 * roles and remove (the server enforces every rule; controls are only hidden here). Only Owners
 * see Owner-related controls, and nobody gets controls for their own membership.
 */
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

  constructor(private http: HttpClient) {}

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
