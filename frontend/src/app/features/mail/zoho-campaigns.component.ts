import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * Zoho Campaigns connection card: connect, test and disconnect this workspace's Zoho account,
 * which Marketech.ai uses only to deliver campaigns. Emits the status so the campaign screen
 * knows whether sending is possible. The server enforces every permission.
 */
@Component({
  selector: 'app-zoho-campaigns',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './zoho-campaigns.component.html',
  styleUrls: ['../command/command-center.component.css', './zoho-campaigns.component.css']
})
export class ZohoCampaignsComponent implements OnInit {
  /** Result of the OAuth redirect (?zoho=connected|error&reason=...). */
  @Input() oauthResult: { zoho?: string; reason?: string } | null = null;
  @Output() toast = new EventEmitter<string>();
  @Output() statusChange = new EventEmitter<any>();

  private base = `${apiRoot()}/api/v1/mail/zoho`;
  status: any = null;
  busy = '';
  error = '';

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    if (this.oauthResult?.zoho === 'connected') this.toast.emit('Zoho Campaigns connected.');
    if (this.oauthResult?.zoho === 'error') this.error = this.oauthMessage(this.oauthResult.reason);
    this.loadStatus();
  }

  get connected(): boolean { return !!this.status?.connection?.connected; }
  get missingScopes(): string[] { return this.status?.connection?.missingScopes || []; }

  loadStatus(): void {
    this.http.get<any>(`${this.base}/status`).subscribe({
      next: r => { this.status = r; this.statusChange.emit(r); },
      error: e => this.error = this.err(e)
    });
  }

  connect(): void {
    this.busy = 'connect';
    this.http.post<any>(`${this.base}/connect`, {}).subscribe({
      next: r => { window.location.href = r.authorizeUrl; },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  disconnect(): void {
    if (!confirm('Disconnect Zoho Campaigns from this workspace? Campaigns stay in Marketech.ai, but none can be sent until you reconnect.')) return;
    this.busy = 'disconnect';
    this.http.post<any>(`${this.base}/disconnect`, {}).subscribe({
      next: r => { this.busy = ''; this.toast.emit(r.note); this.loadStatus(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  test(): void {
    this.busy = 'test';
    this.http.post<any>(`${this.base}/test`, {}).subscribe({
      next: r => { this.busy = ''; this.error = ''; this.toast.emit(r.message); this.loadStatus(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  private oauthMessage(reason?: string): string {
    switch (reason) {
      case 'denied': return 'Zoho access was not granted.';
      case 'invalid_state': return 'The Zoho sign-in link expired or was already used. Try connecting again.';
      case 'not_allowed': return 'Only Owners and Admins can connect Zoho Campaigns.';
      case 'unknown_region': return 'Your Zoho account\'s data center is not supported.';
      case 'no_refresh_token': return 'Zoho did not grant offline access. Remove Marketech.ai from your Zoho connected apps and connect again.';
      default: return 'Connecting Zoho Campaigns failed. Try again.';
    }
  }

  private err(e: any): string {
    return e?.error?.error || e?.message || 'Request failed.';
  }
}
