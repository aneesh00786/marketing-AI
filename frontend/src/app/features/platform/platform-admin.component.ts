import { Component, EventEmitter, HostListener, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { IconComponent } from '../../shared/icon.component';

const SEARCH_DELAY_MS = 300;
type Tab = 'workspaces' | 'users' | 'activity';

const errorText = (e: any): string => e?.error?.error || e?.message || 'Request failed.';

/**
 * Platform admin: every workspace, user and activity. Shown only to the platform admin; the server
 * refuses everyone else. It manages who belongs where and shows who did what, and "Open workspace"
 * takes the admin inside one with full rights.
 */
@Component({
  selector: 'app-platform-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  templateUrl: './platform-admin.component.html',
  styleUrls: ['../command/command-center.component.css', '../mail/mail-ui.css', '../crm/crm-ui.css', './platform-admin.component.css']
})
export class PlatformAdminComponent implements OnInit, OnDestroy {
  @Output() toast = new EventEmitter<string>();
  /** A workspace's data was cleared (the app reloads its counts when it is the current one). */
  @Output() cleared = new EventEmitter<number>();
  /** The new session for a workspace the admin chose to open. */
  @Output() opened = new EventEmitter<any>();

  private base = `${apiRoot()}/api/v1/platform`;
  readonly tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'workspaces', label: 'Workspaces', icon: 'building' },
    { key: 'users', label: 'Users', icon: 'leads' },
    { key: 'activity', label: 'Activity', icon: 'logs' }
  ];
  tab: Tab = 'workspaces';
  q = '';
  loading = false;
  error = '';

  workspaces: any[] = [];
  users: any[] = [];
  roles: string[] = [];
  /** Every user and workspace, for the pickers. Unaffected by the search box. */
  allUsers: any[] = [];
  allWorkspaces: any[] = [];

  detail: any = null;
  assign = { userId: null as number | null, role: 'Member' };
  form: any = null;
  formError = '';
  busy = false;

  /** The user whose workspaces are being managed from the Users tab. */
  managing: any = null;
  manageAdd = { workspaceId: null as number | null, role: 'Member' };

  activity: any[] = [];
  filters = { workspaceId: '', userId: '', from: '', to: '' };
  page = 1;
  hasMore = false;

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadPickers();
    this.load();
  }

  /** Enters a workspace with full rights. The page reloads into it. */
  enter(id: number): void {
    this.http.post<any>(`${this.base}/workspaces/${id}/open`, {}).subscribe({ next: r => this.opened.emit(r), error: e => this.toast.emit(errorText(e)) });
  }

  // ---------- A user's workspaces ----------
  manage(u: any): void {
    this.managing = u;
    this.manageAdd = { workspaceId: null, role: 'Member' };
    if (!this.roles.length || !this.allWorkspaces.length) {
      this.http.get<any>(`${this.base}/workspaces`).subscribe({ next: r => { this.allWorkspaces = r.workspaces; this.roles = r.roles; }, error: e => this.toast.emit(errorText(e)) });
    }
  }

  /** Workspaces this user is not in yet. */
  get addable(): any[] {
    const inside = new Set((this.managing?.workspaces || []).map((w: any) => w.id));
    return this.allWorkspaces.filter(w => !inside.has(w.id) && w.status === 'Active');
  }

  /** The list again, then the user being managed, from the fresh data. */
  private reloadManaged(message: string): void {
    this.toast.emit(message);
    const id = this.managing.id;
    this.manageAdd = { workspaceId: null, role: 'Member' };
    this.http.get<any>(`${this.base}/users`).subscribe({
      next: r => { this.allUsers = r.users; this.users = r.users; this.managing = r.users.find((u: any) => u.id === id) || null; },
      error: e => this.toast.emit(errorText(e))
    });
  }

  addToWorkspace(): void {
    const { workspaceId, role } = this.manageAdd;
    if (!workspaceId) return;
    this.http.post<any>(`${this.base}/workspaces/${workspaceId}/members`, { userId: this.managing.id, role }).subscribe({
      next: () => this.reloadManaged('Workspace assigned.'),
      error: e => this.toast.emit(errorText(e))
    });
  }

  removeFromWorkspace(w: any): void {
    if (!confirm(`Remove ${this.managing.name} from ${w.name}? They lose access straight away.`)) return;
    this.http.delete<any>(`${this.base}/workspaces/${w.id}/members/${this.managing.id}`).subscribe({
      next: () => this.reloadManaged('Workspace removed from this user.'),
      error: e => this.toast.emit(errorText(e))
    });
  }

  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  @HostListener('document:keydown.escape') onEscape(): void { this.form = null; this.managing = null; }

  private loadPickers(): void {
    this.http.get<any>(`${this.base}/users`).subscribe({ next: r => this.allUsers = r.users, error: () => {} });
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.detail = null;
    this.q = '';
    this.load();
  }

  onSearch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), SEARCH_DELAY_MS);
  }

  load(page = 1): void {
    const mine = ++this.seq;
    this.loading = true;
    this.error = '';
    const done = () => { if (mine === this.seq) this.loading = false; };
    const failed = (e: any) => { if (mine !== this.seq) return; this.loading = false; this.error = errorText(e); };
    const q = this.q.trim();
    if (this.tab === 'workspaces') {
      this.http.get<any>(`${this.base}/workspaces`, { params: q ? { q } : {} }).subscribe({
        next: r => { if (mine !== this.seq) return; done(); this.workspaces = r.workspaces; this.roles = r.roles; if (!q) this.allWorkspaces = r.workspaces; },
        error: failed
      });
    } else if (this.tab === 'users') {
      this.http.get<any>(`${this.base}/users`, { params: q ? { q } : {} }).subscribe({
        next: r => { if (mine !== this.seq) return; done(); this.users = r.users; if (!q) this.allUsers = r.users; },
        error: failed
      });
    } else {
      this.page = page;
      const params: Record<string, string> = { page: String(page) };
      for (const [k, v] of Object.entries(this.filters)) if (v) params[k] = String(v);
      this.http.get<any>(`${this.base}/activity`, { params }).subscribe({
        next: r => { if (mine !== this.seq) return; done(); this.activity = r.activity; this.hasMore = r.hasMore; },
        error: failed
      });
    }
  }

  open(id: number): void {
    this.tab = 'workspaces';
    this.http.get<any>(`${this.base}/workspaces/${id}`).subscribe({
      next: r => { this.detail = r; this.roles = r.roles; this.assign = { userId: null, role: 'Member' }; },
      error: e => this.toast.emit(errorText(e))
    });
  }

  back(): void { this.detail = null; this.deleting = null; this.clearing = null; this.load(); }

  /** Users not in this workspace yet, for the assign list. */
  get assignable(): any[] {
    const inside = new Set((this.detail?.members || []).map((m: any) => m.userId));
    return this.allUsers.filter(u => !inside.has(u.id) && u.status === 'Active');
  }

  /** Roles offered for the platform workspace leave out Owner: that is the platform admin. */
  rolesFor(role?: string): string[] {
    if (!this.detail?.workspace.protected) return this.roles;
    return this.roles.filter(r => r !== 'Workspace Owner' || r === role);
  }

  openForm(): void {
    this.formError = '';
    this.form = { name: '', industry: '', ownerUserId: null };
  }

  create(): void {
    if (this.form.name.trim().length < 2) { this.formError = 'Enter a workspace name (at least 2 characters).'; return; }
    if (!this.form.ownerUserId) { this.formError = 'Choose the user this workspace is for.'; return; }
    this.busy = true;
    this.formError = '';
    const { name, industry, ownerUserId } = this.form;
    this.http.post<any>(`${this.base}/workspaces`, { name, industry: industry.trim() || null, ownerUserId }).subscribe({
      next: r => { this.busy = false; this.form = null; this.detail = r; this.roles = r.roles; this.loadPickers(); this.load(); this.toast.emit('Workspace created and assigned.'); },
      error: e => { this.busy = false; this.formError = errorText(e); }
    });
  }

  private applyMembers(r: any, message: string): void {
    this.detail = { ...this.detail, members: r.members };
    this.assign = { userId: null, role: 'Member' };
    this.loadPickers();
    this.toast.emit(message);
  }

  assignUser(): void {
    if (!this.assign.userId) return;
    this.setRole(this.assign.userId, this.assign.role, 'User assigned.');
  }

  setRole(userId: number, role: string, message = 'Role changed.'): void {
    this.http.post<any>(`${this.base}/workspaces/${this.detail.workspace.id}/members`, { userId, role }).subscribe({
      next: r => this.applyMembers(r, message),
      error: e => { this.toast.emit(errorText(e)); this.open(this.detail.workspace.id); }
    });
  }

  remove(m: any): void {
    if (!confirm(`Remove ${m.name} from ${this.detail.workspace.name}? They lose access straight away.`)) return;
    this.http.delete<any>(`${this.base}/workspaces/${this.detail.workspace.id}/members/${m.userId}`).subscribe({
      next: r => this.applyMembers(r, 'User removed.'),
      error: e => this.toast.emit(errorText(e))
    });
  }

  // ---------- Clear data (keeps the workspace) ----------
  clearing: { loading: boolean; busy: boolean; categories: { key: string; label: string; count: number; warn: string | null }[]; picked: Set<string>; name: string; kept: string } | null = null;

  openClear(): void {
    const c = { loading: true, busy: false, categories: [] as any[], picked: new Set<string>(), name: '', kept: '' };
    this.clearing = c;
    this.http.get<any>(`${this.base}/workspaces/${this.detail.workspace.id}/clear-options`).subscribe({
      next: r => { if (this.clearing !== c) return; c.loading = false; c.categories = r.categories || []; c.kept = r.kept || ''; },
      error: e => { this.clearing = null; this.toast.emit(errorText(e)); }
    });
  }

  toggleClear(key: string): void { const p = this.clearing?.picked; if (!p) return; p.has(key) ? p.delete(key) : p.add(key); }
  get clearAllPicked(): boolean { return !!this.clearing?.categories.length && this.clearing.categories.every(c => this.clearing!.picked.has(c.key)); }
  toggleClearAll(): void {
    const c = this.clearing; if (!c) return;
    const all = this.clearAllPicked;
    c.picked = new Set(all ? [] : c.categories.map(x => x.key));
  }
  get clearNameMatches(): boolean {
    return !!this.clearing && this.clearing.name.trim().toLowerCase() === String(this.detail?.workspace.name || '').trim().toLowerCase();
  }
  get clearPickedRecords(): number { return (this.clearing?.categories || []).filter(c => this.clearing!.picked.has(c.key)).reduce((n, c) => n + c.count, 0); }

  confirmClear(): void {
    const c = this.clearing;
    if (!c || !c.picked.size || !this.clearNameMatches || c.busy) return;
    if (!confirm(`Permanently erase the selected data of ${this.detail.workspace.name}? This cannot be undone.`)) return;
    c.busy = true;
    const id = this.detail.workspace.id;
    this.http.post<any>(`${this.base}/workspaces/${id}/clear`, { categories: [...c.picked], confirmName: c.name.trim() }).subscribe({
      next: r => { this.clearing = null; this.toast.emit(`Cleared ${Number(r.total || 0).toLocaleString('en-US')} record(s).`); this.open(id); this.cleared.emit(id); },
      error: e => { c.busy = false; this.toast.emit(errorText(e)); }
    });
  }

  // ---------- Delete / restore a workspace ----------
  /** The open "Delete workspace" confirmation. */
  deleting: { name: string; reason: string; busy: boolean } | null = null;

  get deleteNameMatches(): boolean {
    return !!this.deleting && !!this.detail && this.deleting.name.trim().toLowerCase() === String(this.detail.workspace.name).trim().toLowerCase();
  }

  openDelete(): void { this.deleting = { name: '', reason: '', busy: false }; }

  confirmDelete(): void {
    const d = this.deleting;
    if (!d || !this.deleteNameMatches || d.busy) return;
    d.busy = true;
    const id = this.detail.workspace.id;
    this.http.post<any>(`${this.base}/workspaces/${id}/delete`, { confirmName: d.name.trim(), reason: d.reason.trim() || null }).subscribe({
      next: r => {
        this.deleting = null;
        this.toast.emit(`Workspace deleted. It can be restored until ${new Date(r.purgeAfter).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}; then its data is erased.`);
        this.open(id);
        this.allWorkspaces = [];
      },
      error: e => { d.busy = false; this.toast.emit(errorText(e)); }
    });
  }

  restore(): void {
    const w = this.detail?.workspace;
    if (!w || !confirm(`Restore ${w.name}? Its members can sign in again.`)) return;
    this.http.post<any>(`${this.base}/workspaces/${w.id}/restore`, {}).subscribe({
      next: r => { this.toast.emit(`Workspace restored. ${r.note}`); this.open(w.id); this.allWorkspaces = []; },
      error: e => this.toast.emit(errorText(e))
    });
  }

  showActivity(filter: { workspaceId?: number; userId?: number }): void {
    this.filters = { workspaceId: String(filter.workspaceId || ''), userId: String(filter.userId || ''), from: '', to: '' };
    this.show('activity');
  }

  clearFilters(): void {
    this.filters = { workspaceId: '', userId: '', from: '', to: '' };
    this.load();
  }

  /** "mail.campaign_created" reads as "Mail: campaign created". */
  actionLabel(action: string): string {
    const [area, ...rest] = String(action).split('.');
    const what = rest.join(' ').replace(/_/g, ' ');
    return what ? `${area.charAt(0).toUpperCase()}${area.slice(1)}: ${what}` : area;
  }
}
