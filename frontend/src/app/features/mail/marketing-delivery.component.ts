import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

/**
 * Whether this workspace can send marketing email (Mail Drafts, marketing Compose, AI Campaigns
 * sequences, Product Emails): only through an SMTP mailbox an Owner/Admin has approved for
 * marketing, never ZeptoMail. Owners/Admins (mail.configure) approve or withdraw it here; the server
 * enforces the role, the explicit confirmation and the provider rules, and audits each change.
 */
@Component({
  selector: 'app-marketing-delivery',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './marketing-delivery.component.html',
  styleUrls: ['../command/command-center.component.css', './mail-ui.css', './marketing-delivery.component.css']
})
export class MarketingDeliveryComponent implements OnInit, OnChanges {
  @Output() toast = new EventEmitter<string>();
  /** Changes after the mail settings are saved (a new SMTP account clears the approval): reload. */
  @Input() refreshKey: unknown = null;

  status: { allowed: boolean; code: string | null; reason: string | null; provider: string | null; approvedAt: string | null } | null = null;
  loading = false;
  error: string | null = null;
  caps: Set<string> | null = null;
  confirmed = false;
  busy = false;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
    this.api.getMe().subscribe({
      next: (me: any) => { this.caps = Array.isArray(me?.capabilities) ? new Set(me.capabilities) : null; },
      error: () => { this.caps = null; }
    });
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['refreshKey'] && !ch['refreshKey'].firstChange) { this.confirmed = false; this.load(); }
  }

  get canConfigure(): boolean { return !!this.caps?.has('mail.configure'); }

  load(): void {
    this.loading = true;
    this.error = null;
    this.api.getMarketingDelivery().subscribe({
      next: (r: any) => { this.loading = false; this.status = r?.marketing || null; },
      error: (e: any) => { this.loading = false; this.error = e?.error?.error || 'Marketing email status could not be loaded.'; }
    });
  }

  approve(): void {
    if (!this.confirmed || this.busy) return;
    this.busy = true;
    this.api.setMarketingApproval(true, 'Confirmed in Mail Center').subscribe({
      next: (r: any) => { this.busy = false; this.confirmed = false; this.status = r.marketing; this.toast.emit('This SMTP mailbox is approved for marketing email.'); },
      error: (e: any) => { this.busy = false; this.toast.emit(e?.error?.error || 'The mailbox was not approved.'); this.load(); }
    });
  }

  withdraw(): void {
    if (this.busy || !confirm('Withdraw marketing approval? Mail Drafts, marketing Compose emails, AI Campaigns sequences and Product Emails will stop sending until it is approved again.')) return;
    this.busy = true;
    this.api.setMarketingApproval(false).subscribe({
      next: (r: any) => { this.busy = false; this.status = r.marketing; this.toast.emit('Marketing approval withdrawn.'); },
      error: (e: any) => { this.busy = false; this.toast.emit(e?.error?.error || 'Approval was not withdrawn.'); }
    });
  }
}
