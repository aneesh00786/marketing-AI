import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StudioApiService } from './studio-api.service';

/**
 * AI usage this month (Analytics): credits used against the workspace limit, by kind and
 * provider, failed generations (never charged) and the latest generations. Credits are
 * Marketech.ai units; a USD cost is shown only where the provider's price is configured.
 */
@Component({
  selector: 'app-studio-usage',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./social-shared.css', './studio.css'],
  template: `
<section class="st-card" aria-labelledby="su-title">
  <div class="st-result-head">
    <b id="su-title">AI usage {{ u ? '— ' + monthLabel : '' }}</b>
    <button type="button" class="st-link" (click)="load()">Refresh</button>
  </div>
  <p class="st-muted" *ngIf="!u && !error">Loading…</p>
  <p class="st-note bad" *ngIf="error">{{ error }}</p>
  <ng-container *ngIf="u">
    <div class="su-meter" *ngIf="u.creditLimit" role="meter" [attr.aria-valuenow]="u.creditsUsed" aria-valuemin="0" [attr.aria-valuemax]="u.creditLimit" aria-label="AI credits used this month">
      <div [style.width.%]="pct" [class.warn]="pct >= 80"></div>
    </div>
    <p class="su-big"><b>{{ u.creditsUsed | number }}</b> credits used{{ u.creditLimit ? ' of ' + (u.creditLimit | number) + ' (' + (u.creditsLeft | number) + ' left)' : ' (no monthly limit)' }}<span class="st-muted" *ngIf="u.failedThisMonth"> · {{ u.failedThisMonth }} failed, not charged</span></p>
    <table class="st-table" *ngIf="u.byKind.length">
      <thead><tr><th>Type</th><th>Provider</th><th>Generations</th><th>Credits</th><th>Cost</th></tr></thead>
      <tbody>
        <tr *ngFor="let k of u.byKind"><td>{{ kindLabel(k.kind) }}</td><td>{{ k.provider || '—' }}</td><td>{{ k.generations }}</td><td>{{ k.credits | number }}</td><td>{{ k.costUsd === null ? 'Not configured' : ('$' + (k.costUsd | number:'1.2-4')) }}</td></tr>
      </tbody>
    </table>
    <p class="st-muted" *ngIf="!u.byKind.length">No AI content generated this month.</p>
    <p class="st-muted">{{ u.note }}</p>
  </ng-container>
</section>
`,
  styles: [`.su-meter { height: 10px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
    .su-meter div { height: 100%; background: var(--accent); border-radius: 999px; }
    .su-meter div.warn { background: var(--warning-text); }
    .su-big { margin: 0; }`]
})
export class StudioUsageComponent implements OnInit {
  u: any = null;
  error = '';
  constructor(private studio: StudioApiService) {}
  ngOnInit(): void { this.load(); }
  load(): void { this.studio.usage().subscribe({ next: r => { this.u = r.usage; this.error = ''; }, error: e => this.error = e?.error?.error || 'Could not load AI usage.' }); }
  get pct(): number { return this.u?.creditLimit ? Math.min(100, (this.u.creditsUsed / this.u.creditLimit) * 100) : 0; }
  get monthLabel(): string { const d = new Date(`${this.u.month}-01T00:00:00Z`); return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
  kindLabel(k: string): string { return ({ text: 'Posts and text', plan: 'Campaign plans', image: 'Posters and images', carousel: 'Carousels', video: 'Videos', video_edit: 'Video edits', voice: 'Voice-over' } as any)[k] || k; }
}
