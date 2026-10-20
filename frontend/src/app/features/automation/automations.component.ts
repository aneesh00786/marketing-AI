import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';

type View = 'list' | 'edit' | 'runs';

interface Cond { field: string; op: string; value: any }
interface Step { type: 'wait' | 'check' | 'action'; hours?: number; conditions?: Cond[]; action?: string; params?: any }

/**
 * Rule-based automation workflows: trigger → conditions → wait / check / action steps.
 * Activating is an explicit approval. Actions reuse Leads, Email sequences and Social; nothing
 * is sent or published without the approvals those modules require.
 */
@Component({
  selector: 'app-automations',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './automations.component.html',
  styleUrls: ['../command/command-center.component.css', './automations.component.css']
})
export class AutomationsComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();

  private base = `${apiRoot()}/api/v1/automations`;
  view: View = 'list';
  busy = '';
  error = '';
  meta: any = { triggers: {}, conditionFields: {}, actions: {}, tokens: [] };
  workflows: any[] = [];
  current: any = null;
  runs: any[] = [];

  emailSequences: any[] = [];
  socialCampaigns: any[] = [];
  products: any[] = [];
  leadStatuses: string[] = [];

  form = this.blank();

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<any>(`${this.base}/meta`).subscribe({ next: r => this.meta = r, error: e => this.error = this.err(e) });
    this.http.get<any>(`${apiRoot()}/api/v1/outreach/campaigns`).subscribe({ next: r => this.emailSequences = r.campaigns || [], error: () => {} });
    this.http.get<any>(`${apiRoot()}/api/v1/social/campaigns`).subscribe({ next: r => this.socialCampaigns = r.campaigns || [], error: () => {} });
    this.http.get<any>(`${apiRoot()}/api/v1/products`).subscribe({ next: r => this.products = r.products || [], error: () => {} });
    this.http.get<any>(`${apiRoot()}/api/v1/leads`, { params: { limit: '1' } }).subscribe({ next: r => this.leadStatuses = r.statuses || [], error: () => {} });
    this.load();
  }

  private blank() {
    return { id: null as number | null, name: '', description: '', triggerType: 'lead.created', triggerConfig: {} as any, conditions: [] as Cond[], steps: [] as Step[], exitOnReply: true, maxRunsPerDay: 200 };
  }

  private err(e: any): string { return e?.error?.error || e?.message || 'Request failed'; }
  keys(o: any): string[] { return Object.keys(o || {}); }

  load(): void {
    this.http.get<any>(this.base).subscribe({ next: r => this.workflows = r.workflows || [], error: e => this.error = this.err(e) });
  }

  get leadTrigger(): boolean { return this.meta.triggers[this.form.triggerType]?.subject === 'lead'; }
  triggerOptions(): string[] { return this.meta.triggers[this.form.triggerType]?.config || []; }

  actionsForTrigger(): string[] {
    return this.keys(this.meta.actions).filter(a => this.leadTrigger || this.meta.actions[a].subject !== 'lead');
  }

  // ------------------------------------------------------------ editor
  startNew(): void {
    this.form = this.blank();
    this.form.steps = [{ type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }];
    this.form.triggerConfig = this.emptyConfig(this.form.triggerType);
    this.view = 'edit';
    this.error = '';
  }

  edit(w: any): void {
    this.form = {
      id: w.id, name: w.name, description: w.description || '', triggerType: w.trigger.type, triggerConfig: this.emptyConfig(w.trigger.type, w.trigger.config || {}),
      conditions: (w.conditions || []).map((c: any) => ({ ...c, value: Array.isArray(c.value) ? c.value.join(', ') : c.value })),
      steps: JSON.parse(JSON.stringify(w.steps || [])), exitOnReply: w.exitOnReply, maxRunsPerDay: w.maxRunsPerDay
    };
    this.view = 'edit';
    this.error = '';
  }

  /** Every filter of the chosen trigger starts as "Any" (null) so the selects show it. */
  private emptyConfig(type: string, existing: any = {}): any {
    return Object.fromEntries((this.meta.triggers[type]?.config || []).map((k: string) => [k, existing[k] ?? null]));
  }

  onTriggerChange(): void {
    this.form.triggerConfig = this.emptyConfig(this.form.triggerType);
    if (!this.leadTrigger) {
      this.form.conditions = [];
      this.form.steps = this.form.steps.filter(s => s.type === 'wait' || (s.type === 'action' && this.meta.actions[s.action!]?.subject !== 'lead'));
    }
  }

  addCondition(list: Cond[]): void {
    list.push({ field: 'status', op: 'eq', value: this.leadStatuses[0] || 'New' });
  }

  onConditionField(c: Cond): void {
    const f = this.meta.conditionFields[c.field];
    c.op = f.ops[0];
    c.value = f.type === 'boolean' ? true : (f.type === 'number' || f.type === 'id' ? null : (this.leadStatuses[0] || ''));
  }

  addStep(type: 'wait' | 'check' | 'action'): void {
    if (type === 'wait') this.form.steps.push({ type, hours: 24 });
    if (type === 'check') this.form.steps.push({ type, conditions: [{ field: 'status', op: 'eq', value: this.leadStatuses[0] || 'New' }] });
    if (type === 'action') {
      const first = this.actionsForTrigger()[0];
      this.form.steps.push({ type, action: first, params: this.defaultParams(first) });
    }
  }

  defaultParams(action: string): any {
    switch (action) {
      case 'update_lead_status': return { status: 'Contacted' };
      case 'add_lead_note': return { text: '' };
      case 'enroll_in_sequence': return { emailCampaignId: null };
      case 'stop_sequences': return { emailCampaignId: null };
      case 'create_email_draft': return { subject: '', body: 'Hi {{first_name}},\n\n' };
      case 'create_social_draft': return { platformKey: 'linkedin', caption: '', socialCampaignId: null };
      default: return {};
    }
  }

  onActionChange(s: Step): void { s.params = this.defaultParams(s.action!); }

  move(i: number, d: -1 | 1): void {
    const j = i + d;
    if (j < 0 || j >= this.form.steps.length) return;
    const copy = [...this.form.steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    this.form.steps = copy;
  }

  remove(i: number): void { this.form.steps = this.form.steps.filter((_, x) => x !== i); }

  private normConditions(list: Cond[]): any[] {
    return list.map(c => {
      const f = this.meta.conditionFields[c.field];
      let value: any = c.value;
      if (f.type === 'number' || f.type === 'id') value = Number(c.value);
      if (f.type === 'boolean') value = c.value === true || c.value === 'true';
      if (c.op === 'in') value = String(c.value || '').split(',').map((x: string) => x.trim()).filter(Boolean);
      return { field: c.field, op: c.op, value };
    });
  }

  private payload(): any {
    const cfg: any = {};
    for (const [k, v] of Object.entries(this.form.triggerConfig)) if (v !== null && v !== '' && v !== undefined) cfg[k] = k === 'toStatus' ? v : Number(v);
    const steps = this.form.steps.map(s => {
      if (s.type === 'wait') return { type: 'wait', hours: Number(s.hours) };
      if (s.type === 'check') return { type: 'check', conditions: this.normConditions(s.conditions || []) };
      const params: any = {};
      for (const [k, v] of Object.entries(s.params || {})) {
        if (v === null || v === '' || v === undefined) continue;
        params[k] = /CampaignId$/.test(k) ? Number(v) : v;
      }
      return { type: 'action', action: s.action, params };
    });
    return { name: this.form.name.trim(), description: this.form.description.trim() || null, trigger: { type: this.form.triggerType, config: cfg },
      conditions: this.normConditions(this.form.conditions), steps, exitOnReply: this.form.exitOnReply, maxRunsPerDay: Number(this.form.maxRunsPerDay) };
  }

  save(): void {
    if (!this.form.name.trim()) { this.error = 'Name the workflow.'; return; }
    this.busy = 'save';
    const req = this.form.id ? this.http.put<any>(`${this.base}/${this.form.id}`, this.payload()) : this.http.post<any>(this.base, this.payload());
    req.subscribe({
      next: r => { this.busy = ''; this.toast.emit(this.form.id ? 'Workflow saved as draft. Activate it again to approve the changes.' : 'Workflow saved as draft.'); this.form.id = r.workflow.id; this.view = 'list'; this.load(); },
      error: e => { this.busy = ''; this.error = this.err(e); }
    });
  }

  // ------------------------------------------------------------ lifecycle
  activate(w: any): void {
    const outbound = w.outboundActions.length ? `\n\nOutbound actions:\n• ${w.outboundActions.join('\n• ')}\n(Enrolment only emails through an approved, running sequence; drafts and posts still need approval.)` : '';
    if (!confirm(`Activate "${w.name}"?\n\nIt will run for new events from now on, acting with your permissions (${w.requiredCapabilities.join(', ')}).${outbound}`)) return;
    this.http.post<any>(`${this.base}/${w.id}/activate`, { confirm: true }).subscribe({
      next: () => { this.toast.emit('Workflow activated. It reacts to new events from now on.'); this.load(); },
      error: e => this.error = this.err(e)
    });
  }

  pause(w: any): void {
    this.http.post<any>(`${this.base}/${w.id}/pause`, {}).subscribe({ next: () => { this.toast.emit('Workflow paused. Waiting runs hold until it is active again.'); this.load(); }, error: e => this.error = this.err(e) });
  }

  del(w: any): void {
    if (!confirm(`Delete "${w.name}"?`)) return;
    this.http.delete<any>(`${this.base}/${w.id}`).subscribe({ next: () => { this.toast.emit('Workflow deleted.'); this.load(); }, error: e => this.error = this.err(e) });
  }

  openRuns(w: any): void {
    this.current = w;
    this.view = 'runs';
    this.http.get<any>(`${this.base}/${w.id}/runs`).subscribe({ next: r => this.runs = r.runs || [], error: e => this.error = this.err(e) });
  }

  // ------------------------------------------------------------ labels
  stepLabel(s: any): string {
    if (s.type === 'wait') return `Wait ${s.hours} hour(s)`;
    if (s.type === 'check') return `Check: ${(s.conditions || []).map((c: any) => `${this.meta.conditionFields[c.field]?.label || c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' and ')}`;
    return this.meta.actions[s.action]?.label || s.action;
  }

  totalRuns(w: any): number { return Object.values(w.runs || {}).reduce((a: number, b: any) => a + Number(b), 0); }
  runKeys(w: any): string[] { return Object.keys(w.runs || {}); }
  seqName(id: any): string { return this.emailSequences.find(c => c.id === Number(id))?.name || `#${id}`; }
}
