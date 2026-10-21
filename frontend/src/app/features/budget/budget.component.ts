import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

/**
 * Budget & ROI for Command Center campaigns. Budget (plan), Actual (provider-synced or entered
 * with evidence), Plan-to-date (even pacing) and Forecast (run-rate) are always labelled and
 * never mixed. ROI appears only from actual spend and recorded revenue.
 */
@Component({
  selector: 'app-budget',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './budget.component.html',
  styleUrls: ['../command/command-center.component.css', './budget.component.css']
})
export class BudgetComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();

  private base = `${apiRoot()}/api/v1/budgets`;
  readonly currencies = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'AUD', 'CAD', 'SGD'];
  view: 'list' | 'detail' = 'list';
  error = '';
  busy = '';
  budgets: any[] = [];
  withoutBudget: any[] = [];
  b: any = null;
  metaAccounts: any[] = [];

  setup: any = null;
  spendForm = { date: new Date().toISOString().slice(0, 10), amount: null as number | null, description: '', evidenceRef: '' };
  revenueForm = { date: new Date().toISOString().slice(0, 10), amount: null as number | null, description: '', evidenceRef: '' };
  sourceForm = { socialAccountId: null as number | null, adAccountId: '', campaignIds: '' };
  editForm: any = null;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.load();
    this.http.get<any>(`${apiRoot()}/api/v1/social/accounts`).subscribe({ next: r => this.metaAccounts = (r.accounts || []).filter((a: any) => a.providerKey === 'meta'), error: () => {} });
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed'; }

  load(): void {
    this.http.get<any>(this.base).subscribe({ next: r => { this.budgets = r.budgets || []; this.withoutBudget = r.programsWithoutBudget || []; }, error: e => this.error = this.err(e) });
  }

  open(id: number): void {
    this.view = 'detail';
    this.error = '';
    this.http.get<any>(`${this.base}/${id}`).subscribe({ next: r => this.b = r.budget, error: e => this.error = this.err(e) });
  }

  back(): void { this.view = 'list'; this.b = null; this.editForm = null; this.load(); }

  startSetup(p: any): void {
    const today = new Date().toISOString().slice(0, 10);
    this.setup = { programId: p.id, name: p.name, amount: p.plannedBudget?.amount ?? null, currency: p.plannedBudget?.currency || 'USD',
      periodStart: p.startDate || today, periodEnd: p.endDate || new Date(Date.now() + 29 * 86400000).toISOString().slice(0, 10), thresholds: '50, 80, 100', hint: !!p.plannedBudget };
  }

  private thresholds(text: string): number[] {
    return String(text || '').split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0);
  }

  saveSetup(): void {
    const s = this.setup;
    if (s.amount === null || s.amount === '' || Number(s.amount) < 0) { this.error = 'Enter the budget amount.'; return; }
    this.busy = 'setup';
    this.http.post<any>(this.base, { programId: s.programId, amount: Number(s.amount), currency: s.currency, periodStart: s.periodStart, periodEnd: s.periodEnd, alertThresholds: this.thresholds(s.thresholds) }).subscribe({
      next: r => { this.busy = ''; this.setup = null; this.toast.emit('Budget set up. Record or sync actual spend to track pacing.'); this.open(r.budget.id); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  startEdit(): void {
    this.editForm = { amount: this.b.amount, periodStart: this.b.periodStart, periodEnd: this.b.periodEnd, thresholds: this.b.alertThresholds.join(', ') };
  }

  saveEdit(): void {
    const f = this.editForm;
    this.http.patch<any>(`${this.base}/${this.b.id}`, { amount: Number(f.amount), periodStart: f.periodStart, periodEnd: f.periodEnd, alertThresholds: this.thresholds(f.thresholds) }).subscribe({
      next: r => { this.b = r.budget; this.editForm = null; this.toast.emit('Budget updated.'); },
      error: e => this.error = this.err(e)
    });
  }

  addSpend(): void {
    const f = this.spendForm;
    if (!f.amount || !f.description.trim()) { this.error = 'Enter the amount and what the spend was for.'; return; }
    this.http.post<any>(`${this.base}/${this.b.id}/spend`, { date: f.date, amount: Number(f.amount), currency: this.b.currency, description: f.description.trim(), evidenceRef: f.evidenceRef.trim() || null }).subscribe({
      next: r => { this.b = r.budget; this.spendForm = { ...this.spendForm, amount: null, description: '', evidenceRef: '' }; this.toast.emit('Actual spend recorded.'); },
      error: e => this.error = this.err(e)
    });
  }

  addRevenue(): void {
    const f = this.revenueForm;
    if (!f.amount || !f.description.trim()) { this.error = 'Enter the amount and what the revenue is (e.g. the deal won).'; return; }
    this.http.post<any>(`${this.base}/${this.b.id}/revenue`, { date: f.date, amount: Number(f.amount), currency: this.b.currency, description: f.description.trim(), evidenceRef: f.evidenceRef.trim() || null }).subscribe({
      next: r => { this.b = r.budget; this.revenueForm = { ...this.revenueForm, amount: null, description: '', evidenceRef: '' }; this.toast.emit('Revenue recorded.'); },
      error: e => this.error = this.err(e)
    });
  }

  voidEntry(kind: 'spend' | 'revenue', e: any): void {
    const reason = prompt(`Why void this ${kind} entry of ${e.amount} ${e.currency}? (kept in the history)`);
    if (!reason || reason.trim().length < 3) return;
    this.http.post<any>(`${this.base}/${this.b.id}/${kind}/${e.id}/void`, { reason: reason.trim() }).subscribe({ next: r => { this.b = r.budget; this.toast.emit('Entry voided.'); }, error: x => this.error = this.err(x) });
  }

  connectSource(): void {
    const f = this.sourceForm;
    if (!f.socialAccountId || !f.adAccountId.trim()) { this.error = 'Choose the Meta connection and enter the ad account id.'; return; }
    const campaignIds = f.campaignIds.split(',').map(x => x.trim()).filter(Boolean);
    this.http.post<any>(`${this.base}/${this.b.id}/sources`, { provider: 'meta_ads', socialAccountId: Number(f.socialAccountId), adAccountId: f.adAccountId.trim(), ...(campaignIds.length ? { campaignIds } : {}) }).subscribe({
      next: r => { this.b = r.budget; this.sourceForm = { socialAccountId: null, adAccountId: '', campaignIds: '' }; this.toast.emit('Ad account linked. Sync to import actual spend.'); },
      error: e => this.error = this.err(e)
    });
  }

  sync(s: any): void {
    this.busy = `sync${s.id}`;
    this.http.post<any>(`${this.base}/${this.b.id}/sources/${s.id}/sync`, {}).subscribe({
      next: r => { this.busy = ''; this.b = r.budget; this.toast.emit(`Imported ${r.synced} day(s) of actual spend.`); },
      error: e => { this.busy = ''; this.error = this.err(e); this.open(this.b.id); }
    });
  }

  ack(a: any): void {
    this.http.post<any>(`${this.base}/${this.b.id}/alerts/${a.id}/acknowledge`, {}).subscribe({ next: () => this.open(this.b.id), error: e => this.error = this.err(e) });
  }

  // ------------------------------------------------------------ display
  money(v: any, cur: string): string {
    if (v === null || v === undefined) return '—';
    return `${Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`;
  }

  pct(v: any): string { return v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(0)}%`; }

  pacingLabel(p: any): string {
    return ({ over: 'Over pace', under: 'Under pace', on_track: 'On pace', no_data: 'No actual spend yet', not_started: 'Not started' } as any)[p?.status] || '—';
  }

  // Simple cumulative chart: actual (solid) vs. even-pacing plan (dashed).
  chart(): { plan: string; actual: string; budgetY: number; w: number; h: number } | null {
    const d = this.b?.daily || [];
    if (!d.length) return null;
    const w = 640; const h = 180; const pad = 8;
    const max = Math.max(this.b.amount, ...d.map((x: any) => x.actualCumulative || 0), 1) * 1.1;
    const x = (i: number) => pad + (i / Math.max(d.length - 1, 1)) * (w - 2 * pad);
    const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
    const plan = d.map((p: any, i: number) => `${x(i)},${y(p.planCumulative)}`).join(' ');
    const actual = d.filter((p: any) => p.actualCumulative !== null).map((p: any, i: number) => `${x(i)},${y(p.actualCumulative)}`).join(' ');
    return { plan, actual, budgetY: y(this.b.amount), w, h };
  }
}
