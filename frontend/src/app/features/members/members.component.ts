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
  // The link of the last invitation created or resent (shown once, for sharing when not emailed).
  lastLink: { email: string; link: string; emailed: boolean; emailError: string | null } | null = null;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.http.get<any>(`${this.base}/members`).subscribe({
      next: r => { this.data = r; this.loading = false; this.error = ''; },
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

  invite(): void {
    const email = this.inviteForm.email.trim();
    if (!email) return;
    this.busy = 'invite';
    this.http.post<any>(`${this.base}/invitations`, { email, role: this.inviteForm.role }).subscribe({
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
