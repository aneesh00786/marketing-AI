import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { apiRoot } from '../../core/api-base';
import { ComposeRequestService } from '../../core/compose-request.service';
import { CallService } from '../../shared/calling/call.service';

type Tab = 'overview' | 'timeline' | 'notes';

/**
 * Leads → a lead → Follow-ups. Email and calls are the same as a campaign's "Follow up": ✉ opens
 * Compose, 📞 uses the app's calling (with its optional transcript), and the history is the same
 * emails + calls. Added here: scheduled follow-ups, notes and logged activities. The server checks
 * every action against the lead's access (view-only people see the history, nothing more).
 */
@Component({
  selector: 'app-lead-followups',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['../command/command-center.component.css', './lead-followups.component.css'],
  templateUrl: './lead-followups.component.html'
})
export class LeadFollowupsComponent implements OnInit {
  @Input({ required: true }) lead!: any;
  @Input() members: { userId: number; name: string; role: string }[] = [];
  @Output() close = new EventEmitter<void>();
  @Output() toast = new EventEmitter<string>();

  tab: Tab = 'timeline';
  summary: any = null;
  items: any[] = [];
  notes: any[] = [];
  canAct = false;
  loading = true;
  error = '';
  busy = false;
  filter = { types: '', from: '', to: '' };
  form: 'followup' | 'note' | 'activity' | null = null;
  fu: any = this.blankFollowup();
  note = { category: 'discussion', text: '' };
  act: any = this.blankActivity();
  editing: { id: number; kind: 'followup' | 'note'; text?: string; dueAt?: string; notes?: string } | null = null;

  readonly followupTypes = [['call', '📞 Phone call'], ['email', '✉ Email'], ['meeting', '🤝 Meeting'], ['whatsapp', '💬 WhatsApp'], ['sms', '📱 SMS'], ['general', '📌 General follow-up']];
  readonly activityTypes = [['meeting', '🤝 Meeting'], ['call', '📞 Call (made elsewhere)'], ['email', '✉ Email (sent elsewhere)'], ['whatsapp', '💬 WhatsApp'], ['sms', '📱 SMS'], ['general', '📌 Other']];
  readonly noteCategories = [['feedback', 'Customer feedback'], ['discussion', 'Discussion points'], ['requirements', 'Requirements'], ['objections', 'Objections'], ['internal', 'Internal remark'], ['next_steps', 'Next steps']];
  readonly filters = [['', 'Everything'], ['call', 'Calls'], ['email', 'Emails'], ['followup', 'Follow-ups'], ['note', 'Notes'], ['activity', 'Activities']];
  private base = '';

  constructor(private http: HttpClient, private compose: ComposeRequestService, public calls: CallService) {}

  ngOnInit(): void {
    this.base = `${apiRoot()}/api/v1/leads/${this.lead.id}`;
    this.calls.loadAccess();
    this.reload();
  }

  reload(): void {
    this.loading = true;
    this.http.get<any>(`${this.base}/followup-summary`).subscribe({
      next: r => { this.summary = r; this.canAct = !!r.canAct; },
      error: e => { this.error = e?.error?.error || 'Could not load this lead.'; this.loading = false; }
    });
    this.loadTimeline();
    this.http.get<any>(`${this.base}/notes`).subscribe({ next: r => { this.notes = r.notes || []; }, error: () => { this.notes = []; } });
  }

  loadTimeline(): void {
    const params: any = {};
    if (this.filter.types) params.types = this.filter.types;
    if (this.filter.from) params.from = new Date(`${this.filter.from}T00:00:00`).toISOString();
    if (this.filter.to) params.to = new Date(`${this.filter.to}T23:59:59`).toISOString();
    this.http.get<any>(`${this.base}/timeline`, { params }).subscribe({
      next: r => { this.items = r.items || []; this.canAct = !!r.canAct; this.loading = false; },
      error: e => { this.loading = false; this.error = e?.error?.error || 'Could not load the history.'; }
    });
  }

  get pendingFollowups(): any[] {
    return this.items.filter(i => i.kind === 'followup' && (i.status === 'pending' || i.status === 'overdue'))
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  }

  // ---------------------------------------------------------------- quick actions (existing features)

  get canCall(): boolean { return this.canAct && this.calls.available && String(this.lead.phone || '').replace(/\D/g, '').length >= 7; }

  callLead(followupId: number | null = null): void {
    this.calls.prepare(String(this.lead.phone), this.lead.name || '', null, null, { leadId: this.lead.id, followupId });
    this.toast.emit('The call panel is open. Press Call when ready; the call is saved with this lead.');
  }

  emailLead(): void {
    const first = String(this.lead.name || '').trim().split(/\s+/)[0] || 'there';
    this.compose.open({ email: this.lead.email, name: this.lead.name || null, subject: this.lead.productName ? `Following up: ${this.lead.productName}` : 'Following up', body: `Hi ${first},\n\n` });
  }

  // ---------------------------------------------------------------- follow-ups

  private blankFollowup(): any {
    const d = new Date(Date.now() + 24 * 3600000);
    return { title: '', type: 'call', description: '', assignedUserId: null, date: d.toISOString().slice(0, 10), time: '10:00', priority: 'medium', reminderMinutes: 30 };
  }
  private blankActivity(): any {
    const now = new Date();
    return { type: 'meeting', title: '', description: '', durationMinutes: null, date: now.toISOString().slice(0, 10), time: now.toTimeString().slice(0, 5), nextDate: '' };
  }

  open(form: 'followup' | 'note' | 'activity'): void {
    this.form = this.form === form ? null : form;
    if (form === 'followup') this.fu = this.blankFollowup();
    if (form === 'activity') this.act = this.blankActivity();
    if (form === 'note') this.note = { category: 'discussion', text: '' };
  }

  private localIso(date: string, time: string): string { return new Date(`${date}T${time || '09:00'}`).toISOString(); }

  saveFollowup(): void {
    if (!this.fu.title.trim()) { this.error = 'Give the follow-up a title.'; return; }
    this.send('POST', `${this.base}/followups`, {
      title: this.fu.title.trim(), type: this.fu.type, description: this.fu.description.trim() || null, priority: this.fu.priority,
      dueAt: this.localIso(this.fu.date, this.fu.time), reminderMinutes: this.fu.reminderMinutes === null ? null : Number(this.fu.reminderMinutes),
      ...(this.fu.assignedUserId ? { assignedUserId: Number(this.fu.assignedUserId) } : {})
    }, 'Follow-up scheduled.');
  }

  completeFollowup(f: any): void {
    const notes = prompt(`Complete "${f.title}". Completion notes (optional):`, '');
    if (notes === null) return;
    this.send('PATCH', `${this.base}/followups/${f.id}`, { action: 'complete', completionNotes: notes.trim() || null }, 'Follow-up completed.');
  }

  cancelFollowup(f: any): void {
    if (!confirm(`Cancel "${f.title}"?`)) return;
    this.send('PATCH', `${this.base}/followups/${f.id}`, { action: 'cancel' }, 'Follow-up cancelled.');
  }

  startReschedule(f: any): void {
    const d = new Date(f.dueAt);
    this.editing = { id: f.id, kind: 'followup', dueAt: `${d.toISOString().slice(0, 10)}T${d.toTimeString().slice(0, 5)}` };
  }

  saveReschedule(): void {
    if (!this.editing?.dueAt) return;
    const [date, time] = this.editing.dueAt.split('T');
    this.send('PATCH', `${this.base}/followups/${this.editing.id}`, { dueAt: this.localIso(date, time) }, 'Follow-up rescheduled.');
  }

  reassign(f: any, userId: string): void {
    this.send('PATCH', `${this.base}/followups/${f.id}`, { assignedUserId: userId ? Number(userId) : null }, 'Follow-up reassigned.');
  }

  // ---------------------------------------------------------------- notes and activities

  saveNote(): void {
    if (!this.note.text.trim()) return;
    this.send('POST', `${this.base}/activities`, { type: 'note', noteCategory: this.note.category, description: this.note.text.trim() }, 'Note added.');
  }

  editNote(n: any): void { this.editing = { id: n.id, kind: 'note', text: n.description }; }

  saveNoteEdit(): void {
    if (!this.editing?.text?.trim()) return;
    this.send('PATCH', `${this.base}/activities/${this.editing.id}`, { description: this.editing.text.trim() }, 'Note updated.');
  }

  deleteItem(a: any): void {
    if (!confirm(a.type === 'note' ? 'Delete this note?' : 'Delete this activity?')) return;
    this.send('DELETE', `${this.base}/activities/${a.id}`, null, a.type === 'note' ? 'Note deleted.' : 'Activity deleted.');
  }

  saveActivity(): void {
    if (!this.act.title.trim() && !this.act.description.trim()) { this.error = 'Add a title or a description.'; return; }
    this.send('POST', `${this.base}/activities`, {
      type: this.act.type, title: this.act.title.trim() || null, description: this.act.description.trim() || null,
      durationMinutes: this.act.durationMinutes ? Number(this.act.durationMinutes) : null,
      activityAt: this.localIso(this.act.date, this.act.time),
      ...(this.act.nextDate ? { nextFollowupAt: this.localIso(this.act.nextDate, '10:00') } : {})
    }, 'Activity logged.');
  }

  private send(method: string, url: string, body: any, done: string): void {
    this.busy = true;
    this.error = '';
    this.http.request<any>(method, url, body ? { body } : {}).subscribe({
      next: () => { this.busy = false; this.form = null; this.editing = null; this.toast.emit(done); this.reload(); },
      error: e => { this.busy = false; this.error = e?.error?.error || 'The change was not saved.'; }
    });
  }

  // ---------------------------------------------------------------- display helpers

  icon(i: any): string {
    if (i.kind === 'call') return '📞';
    if (i.kind === 'email') return i.direction === 'received' ? '📥' : '✉';
    if (i.kind === 'followup') return '📅';
    return ({ note: '📝', meeting: '🤝', call: '📞', email: '✉', whatsapp: '💬', sms: '📱', general: '📌' } as any)[i.type] || '•';
  }

  label(i: any): string {
    if (i.kind === 'call') return i.answered ? 'Call' : 'Call (not answered)';
    if (i.kind === 'email') return i.direction === 'received' ? 'Email received' : 'Email sent';
    if (i.kind === 'followup') return `Follow-up · ${this.typeName(i.type)}`;
    if (i.type === 'note') return `Note${i.noteCategory ? ' · ' + this.noteName(i.noteCategory) : ''}`;
    return this.typeName(i.type);
  }

  typeName(t: string): string { return (this.followupTypes.find(x => x[0] === t)?.[1] || t).replace(/^\S+\s/, ''); }
  noteName(c: string): string { return this.noteCategories.find(x => x[0] === c)?.[1] || c; }
  memberName(id: number | null): string { return this.members.find(m => m.userId === id)?.name || ''; }

  duration(s: number | null): string {
    if (!s && s !== 0) return '';
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  }

  transcriptNote(c: any): string {
    if (!c.transcribed) return 'Not transcribed ("Transcribe this call" was not ticked).';
    return ({ pending: 'Transcribing…', failed: 'The transcript could not be made (the audio is not kept, so it cannot be retried).', none: 'No transcript.' } as any)[c.transcriptStatus] || 'No transcript.';
  }

  copyTranscript(c: any): void {
    const text = (c.conversation || []).map((l: any) => `${l.speaker === 'agent' ? (c.callerName || 'Agent') : (this.lead.name || 'Customer')}: ${l.text}`).join('\n');
    navigator.clipboard?.writeText(text).then(() => this.toast.emit('Transcript copied.'), () => this.toast.emit('Copy failed.'));
  }

  downloadTranscript(c: any): void {
    const text = (c.conversation || []).map((l: any) => `[${Math.floor(l.start / 60)}:${String(Math.floor(l.start % 60)).padStart(2, '0')}] ${l.speaker === 'agent' ? (c.callerName || 'Agent') : (this.lead.name || 'Customer')}: ${l.text}`).join('\n');
    const blob = new Blob([`Call with ${this.lead.name} (${this.lead.phone || ''}) on ${new Date(c.startedAt).toLocaleString()}\nBy ${c.callerName || '—'} · ${this.duration(c.durationSeconds)}\n\n${text}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `call-${this.lead.name || 'lead'}-${String(c.startedAt).slice(0, 10)}.txt`.replace(/[^\w.-]+/g, '-');
    a.click();
    URL.revokeObjectURL(a.href);
  }

  transcriptSearch: Record<number, string> = {};
  shownLines(c: any): any[] {
    const q = (this.transcriptSearch[c.id] || '').trim().toLowerCase();
    return q ? (c.conversation || []).filter((l: any) => String(l.text).toLowerCase().includes(q)) : (c.conversation || []);
  }
}
