import { Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../services/api.service';

const STATUS: Record<string, { label: string; tone: string; hint: string }> = {
  queued: { label: 'Queued', tone: 'muted', hint: 'Prepared; the provider has not taken it yet.' },
  accepted: { label: 'Accepted by provider', tone: 'info', hint: 'The mail provider accepted the email. That is not proof of delivery.' },
  unknown: { label: 'Outcome unknown', tone: 'warn', hint: 'The send may or may not have gone through. It is never resent automatically.' },
  deferred: { label: 'Delayed (soft bounce)', tone: 'warn', hint: 'Temporarily refused by the recipient\'s server; the provider may retry.' },
  delivered: { label: 'Delivered', tone: 'ok', hint: 'The recipient\'s mail server accepted the email (inbox placement is not known).' },
  failed: { label: 'Not sent', tone: 'danger', hint: 'The email was not sent.' },
  bounced: { label: 'Bounced', tone: 'danger', hint: 'Permanently refused by the recipient\'s server.' }
};
const EVENT_LABEL: Record<string, string> = {
  queued: 'Queued', accepted: 'Accepted by provider', unknown: 'Send outcome unknown', delivered: 'Delivered',
  soft_bounce: 'Soft bounce', hard_bounce: 'Hard bounce', failed: 'Not sent', opened: 'Open recorded', clicked: 'Link click recorded', complaint: 'Marked as spam'
};

/**
 * Delivery, open and click tracking for one sent email (by email id or draft id). Shows only what
 * the provider or our own tracking actually recorded: missing figures read "Unavailable", "Not
 * tracked" or "Not supported by provider", never 0. Opens are an estimate, not proof of reading.
 */
@Component({
  selector: 'app-email-tracking',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './email-tracking.component.html',
  styleUrls: ['./mail-ui.css', './email-tracking.component.css']
})
export class EmailTrackingComponent implements OnChanges {
  @Input() emailId: number | null = null;
  @Input() draftId: number | null = null;

  t: any = null;
  loading = false;
  error: string | null = null;
  private seq = 0;

  constructor(private api: ApiService) {}

  ngOnChanges(): void { this.load(); }

  load(): void {
    const req = this.emailId ? this.api.getEmailTracking(this.emailId) : this.draftId ? this.api.getDraftTracking(this.draftId) : null;
    if (!req) { this.t = null; return; }
    const mine = ++this.seq;
    this.loading = true;
    this.error = null;
    req.subscribe({
      next: (r: any) => { if (mine !== this.seq) return; this.loading = false; this.t = r.tracking; },
      error: (e: any) => { if (mine !== this.seq) return; this.loading = false; this.t = null; this.error = e?.status === 403 ? 'Your role cannot view email tracking.' : (e?.error?.error || 'Tracking could not be loaded.'); }
    });
  }

  get status() { return STATUS[this.t?.deliveryStatus] || { label: this.t?.deliveryStatus || 'Unknown', tone: 'muted', hint: '' }; }
  eventLabel(type: string): string { return EVENT_LABEL[type] || type; }

  get providerLabel(): string {
    return this.t?.provider === 'zeptomail' ? 'ZeptoMail' : this.t?.provider === 'smtp' ? 'Your SMTP server' : 'Not sent yet';
  }

  /** Delivered timestamp, or why it is not available. */
  get deliveredText(): string | null {
    if (this.t?.deliveredAt) return null;
    switch (this.t?.deliveryReporting) {
      case 'not_supported': return 'Not supported by provider (SMTP servers do not report delivery)';
      case 'webhook_not_connected': return 'Unavailable (ZeptoMail delivery events are not connected)';
      case 'provider_webhook': return 'Not reported yet';
      default: return 'Unavailable';
    }
  }

  modeText(mode: string, kind: 'opens' | 'clicks'): string | null {
    switch (mode) {
      case 'off': return 'Not tracked';
      case 'not_reported': return 'Unavailable (provider events are not connected)';
      default: return null;
    }
  }

  get openNote(): string {
    return this.t?.opens?.mode === 'provider'
      ? 'Estimate. ZeptoMail reports the first open only. Image blocking, caching and privacy features (such as Apple Mail Privacy Protection) make opens unreliable.'
      : 'Estimate. Opens are counted when the email\'s images load, which image blocking, caching and privacy features distort. Repeats within a minute count once.';
  }
}
