import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * Mail Settings → Campaigns: which service sends this workspace's campaigns (Zoho Campaigns
 * or Amazon SES) and the Amazon SES connection. The secret key can be written but never read back.
 * Owners/Admins (mail.configure) change it; others see it read-only.
 */
@Component({
  selector: 'app-campaign-delivery',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./mail-ui.css', './campaign-delivery.component.css'],
  template: `
<section class="cd" *ngIf="s; else loadingTpl">
  <div class="cd-card">
    <h3>Send campaigns with</h3>
    <p class="mx-desc">The campaign flow stays the same (write → recipients → approve → send). Only the service that delivers it changes.</p>
    <div class="cd-choice" role="radiogroup" aria-label="Campaign sending service">
      <label class="cd-option" [class.on]="s.provider === 'zoho'">
        <input type="radio" name="provider" value="zoho" [checked]="s.provider === 'zoho'" [disabled]="!s.canConfigure || busy" (change)="setProvider('zoho')" />
        <span><b>Zoho Campaigns</b><small>Zoho delivers the campaign; lists are put into Zoho for each send.</small></span>
      </label>
      <label class="cd-option" [class.on]="s.provider === 'ses'">
        <input type="radio" name="provider" value="ses" [checked]="s.provider === 'ses'" [disabled]="!s.canConfigure || busy || !s.ses.configured" (change)="setProvider('ses')" />
        <span><b>Amazon SES</b><small>Marketech.ai sends each email through your Amazon SES account, with delivered, opened, clicked, bounced and complaint reports.{{ s.ses.configured ? '' : ' Set up the connection below first.' }}</small></span>
      </label>
    </div>
  </div>

  <div class="cd-card">
    <h3>Amazon SES connection</h3>
    <p class="mx-desc" *ngIf="s.ses.source === 'server'">Using the server's Amazon SES account (backend .env). Enter keys here to use this workspace's own account instead.</p>
    <form class="cd-form" (submit)="$event.preventDefault(); save()">
      <label>Region <input class="hud-input" name="region" [(ngModel)]="form.region" placeholder="e.g. us-east-1 or ap-south-1" [disabled]="!s.canConfigure" /></label>
      <label>Access key ID <input class="hud-input" name="accessKeyId" [(ngModel)]="form.accessKeyId" [placeholder]="s.ses.accessKeyId || 'AKIA…'" autocomplete="off" [disabled]="!s.canConfigure" /></label>
      <label>Secret access key <input class="hud-input" name="secret" type="password" [(ngModel)]="form.secretAccessKey" [placeholder]="s.ses.hasSecret ? 'Saved — enter a new one to replace it' : ''" autocomplete="new-password" [disabled]="!s.canConfigure" /></label>
      <label>Configuration set (for delivery, bounce and complaint events) <input class="hud-input" name="configurationSet" [(ngModel)]="form.configurationSet" placeholder="e.g. marketech-events" [disabled]="!s.canConfigure" /></label>
      <label>Emails per second (optional; your SES sending rate) <input class="hud-input" name="maxPerSecond" type="number" min="1" max="500" [(ngModel)]="form.maxPerSecond" [disabled]="!s.canConfigure" /></label>
      <p class="muted small">Use an IAM user that may only send with SES (ses:SendEmail, ses:SendRawEmail, ses:GetAccount, ses:GetEmailIdentity). The secret is stored encrypted and never shown again.</p>
      <div class="cd-actions" *ngIf="s.canConfigure">
        <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy">{{ busy ? 'Saving…' : 'Save connection' }}</button>
        <button type="button" class="btn btn-secondary btn-sm" (click)="test()" [disabled]="busy || !s.ses.configured">{{ testing ? 'Testing…' : 'Test connection' }}</button>
        <button type="button" class="btn btn-secondary btn-sm" *ngIf="s.ses.source === 'workspace'" (click)="clearKeys()" [disabled]="busy">Remove keys</button>
      </div>
    </form>
    <p class="cd-result" *ngIf="testResult" [class.ok]="testResult.ok" role="status">{{ testResult.message }}</p>
    <p class="cd-result" *ngIf="!testResult && s.ses.lastError" role="status">Last test: {{ s.ses.lastError }}</p>
    <p class="cd-result" *ngIf="!s.ses.configured && s.canConfigure" role="status">Not set up yet: {{ missing.join(', ') }} {{ missing.length === 1 ? 'is' : 'are' }} missing. Save them, then test the connection.</p>
  </div>

  <div class="cd-card" *ngIf="s.canConfigure || s.provider === 'ses'">
    <h3>Delivery reports (Amazon SNS)</h3>
    <p class="mx-desc">Opens and clicks are tracked by Marketech.ai. Delivered, bounced and complaint reports come from SES through Amazon SNS:</p>
    <ol class="cd-steps">
      <li>In Amazon SNS, create a topic (Standard), e.g. <code>marketech-ses-events</code>.</li>
      <li>Add an HTTPS subscription to that topic with this endpoint:
        <span class="cd-url" *ngIf="s.ses.notificationUrl"><code>{{ s.ses.notificationUrl }}</code> <button type="button" class="btn btn-secondary btn-sm" (click)="copy(s.ses.notificationUrl)">Copy</button></span>
        <span class="muted small" *ngIf="!s.ses.notificationUrl">(shown to Owners and Admins; the server needs a public APP_BASE_URL)</span>
        <span class="cd-result" *ngIf="s.ses.notificationUrl && !publicUrl" role="status">This address is not reachable by Amazon SNS (it must be a public https address). Set up the subscription from your live site, e.g. https://your-domain/…, not from localhost.</span>
        Marketech.ai confirms the subscription by itself.</li>
      <li>In Amazon SES, create a configuration set with an event destination to that SNS topic, publishing <b>Delivery, Bounce, Complaint, Reject and Delivery delay</b> (open and click tracking can stay off), and enter its name above.</li>
    </ol>
    <p class="cd-result" [class.ok]="!!s.ses.snsTopicArn">{{ s.ses.snsTopicArn ? 'Subscription confirmed: ' + s.ses.snsTopicArn : 'No SNS subscription confirmed yet.' }}</p>
  </div>
  <p class="note error" *ngIf="error" role="alert">{{ error }}</p>
</section>
<ng-template #loadingTpl><p class="muted small">{{ error || 'Loading…' }}</p></ng-template>
`
})
export class CampaignDeliveryComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();
  s: any = null;
  form: any = { region: '', accessKeyId: '', secretAccessKey: '', configurationSet: '', maxPerSecond: null };
  busy = false;
  testing = false;
  testResult: { ok: boolean; message: string } | null = null;
  error: string | null = null;
  private base = `${apiRoot()}/api/v1/mail/ses`;

  constructor(private http: HttpClient) {}

  ngOnInit(): void { this.load(); }

  private apply(r: any): void {
    this.s = r;
    this.form = { region: r.ses.region || '', accessKeyId: '', secretAccessKey: '', configurationSet: r.ses.configurationSet || '', maxPerSecond: r.ses.maxPerSecond || null };
  }

  load(): void {
    this.http.get<any>(`${this.base}/settings`).subscribe({ next: r => this.apply(r), error: e => this.error = this.err(e) });
  }

  private put(body: any, done: string): void {
    this.busy = true;
    this.error = null;
    this.http.put<any>(`${this.base}/settings`, body).subscribe({
      next: r => { this.busy = false; this.apply(r); this.toast.emit(done); },
      error: e => { this.busy = false; this.error = this.err(e); this.load(); }
    });
  }

  save(): void {
    const f = this.form;
    const body: any = {};
    if (f.region.trim()) body.region = f.region.trim();
    if (f.accessKeyId.trim()) body.accessKeyId = f.accessKeyId.trim();
    if (f.secretAccessKey.trim()) body.secretAccessKey = f.secretAccessKey.trim();
    body.configurationSet = (f.configurationSet || '').trim();
    body.maxPerSecond = f.maxPerSecond ? Number(f.maxPerSecond) : null;
    this.testResult = null;
    this.put(body, 'Amazon SES connection saved.');
  }

  setProvider(p: 'zoho' | 'ses'): void {
    if (p === 'ses' && !confirm('Send this workspace\'s campaigns with Amazon SES from now on? Campaigns already sent stay as they are.')) { this.load(); return; }
    this.put({ provider: p }, p === 'ses' ? 'Campaigns are now sent with Amazon SES.' : 'Campaigns are now sent with Zoho Campaigns.');
  }

  clearKeys(): void {
    if (!confirm('Remove this workspace\'s Amazon SES keys?')) return;
    this.put({ clearKeys: true }, 'Amazon SES keys removed.');
  }

  test(): void {
    this.testing = this.busy = true;
    this.testResult = null;
    this.http.post<any>(`${this.base}/test`, {}).subscribe({
      next: r => { this.testing = this.busy = false; this.testResult = { ok: !!r.ok && !!r.account?.productionAccess, message: r.message }; },
      error: e => { this.testing = this.busy = false; this.testResult = { ok: false, message: this.err(e) }; }
    });
  }

  copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => this.toast.emit('Copied.'), () => this.toast.emit(text));
  }

  /** What the SES connection still needs (region, access key ID, secret). */
  get missing(): string[] {
    const s = this.s?.ses || {};
    return [!s.region && 'region', !s.accessKeyId && 'access key ID', !s.hasSecret && 'secret access key'].filter(Boolean) as string[];
  }

  /** SNS can only deliver to a public https address (not localhost or a private network). */
  get publicUrl(): boolean {
    try {
      const u = new URL(this.s?.ses?.notificationUrl || '');
      return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i.test(u.hostname);
    } catch { return false; }
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed.'; }
}
