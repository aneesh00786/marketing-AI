import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LEAD_FIELDS, LeadField, LeadSheetRow, SheetData, autoMap, buildLeadRows, detectHeaderRow, headingsKey, headingsOf } from './lead-sheet';

/**
 * "Match your columns" step of the lead import: which sheet, which row holds the headings, and
 * which lead field each column is. Matches are guessed from the headings and remembered (in this
 * browser) for files with the same headings. Emits the leads built with the current matches.
 */
@Component({
  selector: 'app-lead-import-mapper',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div class="lim">
    <div class="lim-head">
      <b>Map your fields</b>
      <span class="lim-muted">For each Marketech.ai field, choose the column in your file that holds it. We filled in our best guess; check and correct it.</span>
    </div>
    <div class="lim-opts">
      <label *ngIf="sheets.length > 1">Sheet
        <select [ngModel]="sheetIndex" (ngModelChange)="setSheet($event)">
          <option *ngFor="let s of sheets; let i = index" [ngValue]="i">{{ s.name }} ({{ s.cells.length }} rows)</option>
        </select>
      </label>
      <label>Headings are in row
        <select [ngModel]="headerRow" (ngModelChange)="setHeaderRow($event)">
          <option *ngFor="let r of headerChoices" [ngValue]="r">{{ r + 1 }}: {{ rowPreview(r) }}</option>
        </select>
      </label>
      <button type="button" class="lim-link" (click)="resetGuess()">↺ Match automatically again</button>
    </div>

    <div class="lim-table" role="table" aria-label="Field mapping">
      <div class="lim-row lim-th" role="row"><span>Marketech.ai field</span><span>Column in your file</span><span>Example from your file</span></div>
      <div class="lim-row" role="row" *ngFor="let f of singleFields" [class.off]="fieldColumn(f.key) < 0">
        <span class="lim-field">{{ f.label }}<em *ngIf="f.hint" class="lim-hint">{{ f.hint }}</em></span>
        <select [ngModel]="fieldColumn(f.key)" (ngModelChange)="setFieldColumn(f.key, $event)" [attr.aria-label]="'Column for ' + f.label">
          <option [ngValue]="-1">— Not in my file —</option>
          <option *ngFor="let h of headings; let i = index" [ngValue]="i">{{ h }}{{ mapping[i] && mapping[i] !== f.key ? '  (used for ' + labelOf(mapping[i]) + ')' : '' }}</option>
        </select>
        <span class="lim-sample" [title]="sample(fieldColumn(f.key))">{{ fieldColumn(f.key) < 0 ? '—' : (sample(fieldColumn(f.key)) || '(empty)') }}</span>
      </div>
    </div>

    <div class="lim-multi">
      <b>Address details</b> <span class="lim-muted">(added after the address, e.g. city, state, postcode)</span>
      <div class="lim-chips">
        <label *ngFor="let i of chipColumns('city')" class="lim-chip" [class.on]="mapping[i] === 'city'">
          <input type="checkbox" [checked]="mapping[i] === 'city'" (change)="toggleMulti(i, 'city')" /> {{ headings[i] }}
        </label>
      </div>
    </div>
    <div class="lim-multi">
      <b>Notes</b> <span class="lim-muted">(columns added to the lead's notes)</span>
      <div class="lim-chips">
        <label *ngFor="let i of chipColumns('notes')" class="lim-chip" [class.on]="mapping[i] === 'notes'">
          <input type="checkbox" [checked]="mapping[i] === 'notes'" (change)="toggleMulti(i, 'notes')" /> {{ headings[i] }}
        </label>
      </div>
    </div>
    <div class="lim-multi" *ngIf="unmapped.length">
      <label class="lim-check"><input type="checkbox" [(ngModel)]="extraToNotes" (ngModelChange)="emit()" />
        Also keep the {{ unmapped.length }} other column{{ unmapped.length === 1 ? '' : 's' }} in notes:</label>
      <span class="lim-muted">{{ unmappedText }}</span>
    </div>
    <p class="lim-warn" *ngIf="problem" role="alert">⚠ {{ problem }}</p>
  </div>`,
  styles: [`
    .lim { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .lim-head { display: flex; flex-direction: column; gap: 2px; }
    .lim-muted { color: var(--text-muted); font-size: 0.82rem; }
    .lim-opts { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .lim-opts label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: var(--text-muted); max-width: 100%; }
    .lim-check { display: flex; flex-direction: row; align-items: center; gap: 6px; color: var(--text); font-size: 0.85rem; }
    select { background: var(--bg-elev); color: var(--text); border: 1px solid var(--border-strong); border-radius: 8px; padding: 6px 8px; font-size: 0.85rem; max-width: 100%; }
    .lim-opts select { max-width: 320px; }
    .lim-table { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
    .lim-row { display: grid; grid-template-columns: minmax(130px, 0.9fr) minmax(160px, 1.1fr) minmax(120px, 1fr); gap: 10px; align-items: center; padding: 6px 10px; border-top: 1px solid var(--border); font-size: 0.85rem; }
    .lim-row:first-child { border-top: none; }
    .lim-th { position: sticky; top: 0; background: var(--surface); font-weight: 600; font-size: 0.78rem; color: var(--text-muted); }
    .lim-row.off .lim-field, .lim-row.off .lim-sample { opacity: 0.55; }
    .lim-field { font-weight: 600; display: flex; flex-direction: column; }
    .lim-hint { font-style: normal; font-weight: 400; font-size: 0.74rem; color: var(--text-muted); }
    .lim-table { max-height: 380px; }
    .lim-multi { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; }
    .lim-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .lim-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; cursor: pointer; font-size: 0.8rem; }
    .lim-chip.on { border-color: var(--accent); background: var(--accent-soft); }
    .lim-link { background: none; border: none; color: var(--accent-text); cursor: pointer; font-size: 0.82rem; padding: 6px 0; }
    .lim-sample { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lim-warn { margin: 0; color: var(--warning-text); font-size: 0.82rem; }
    @media (max-width: 600px) { .lim-row { grid-template-columns: 1fr; gap: 4px; } .lim-th { display: none; } }
  `]
})
export class LeadImportMapperComponent implements OnChanges {
  @Input({ required: true }) sheets: SheetData[] = [];
  @Output() rowsChange = new EventEmitter<{ rows: LeadSheetRow[]; skippedNoName: number }>();

  readonly fields = LEAD_FIELDS;
  /** Fields filled from one column, in the order shown. */
  readonly singleFields = LEAD_FIELDS.filter(f => f.key !== 'notes' && f.key !== 'city').map(f => ({
    ...f, hint: f.key === 'name' ? 'Or use First name + Last name' : f.key === 'product' ? 'Blank = the product chosen below' : ''
  }));
  sheetIndex = 0;
  headerRow = 0;
  headings: string[] = [];
  mapping: LeadField[] = [];
  extraToNotes = true;
  private static readonly STORE = 'marketech_lead_import_maps';

  ngOnChanges(): void {
    if (!this.sheets.length) return;
    // The first sheet that has recognisable headings, else the first.
    const scored = this.sheets.map((s, i) => ({ i, known: autoMap(headingsOf(s.cells, detectHeaderRow(s.cells))).filter(Boolean).length }));
    this.setSheet(scored.sort((a, b) => b.known - a.known || a.i - b.i)[0].i);
  }

  get cells(): string[][] { return this.sheets[this.sheetIndex]?.cells || []; }
  get headerChoices(): number[] { return Array.from({ length: Math.min(15, this.cells.length) }, (_, i) => i); }

  rowPreview(r: number): string {
    const t = (this.cells[r] || []).filter(Boolean).slice(0, 4).join(' · ');
    return t.length > 50 ? t.slice(0, 50) + '…' : t;
  }

  sample(i: number): string {
    return this.cells.slice(this.headerRow + 1).map(r => r[i]).find(v => v) || '';
  }

  setSheet(i: number): void {
    this.sheetIndex = i;
    this.setHeaderRow(detectHeaderRow(this.cells));
  }

  setHeaderRow(r: number): void {
    this.headerRow = r;
    this.headings = headingsOf(this.cells, r);
    this.mapping = this.remembered() || autoMap(this.headings);
    this.emit();
  }

  labelOf(f: LeadField): string { return LEAD_FIELDS.find(x => x.key === f)?.label || ''; }

  /** The column that fills a field (-1: none). */
  fieldColumn(f: LeadField): number { return this.mapping.indexOf(f); }

  /** Field-first choice: the column now fills this field (and only this one). */
  setFieldColumn(f: LeadField, col: number): void {
    this.mapping = this.mapping.map((m, j) => (j === col ? f : m === f ? '' : m));
    this.remember();
    this.emit();
  }

  /** Columns offered as Notes / Address-detail chips: those not used by a single field. */
  chipColumns(f: LeadField): number[] {
    return this.headings.map((_, i) => i).filter(i => this.mapping[i] === f || !this.mapping[i]);
  }

  toggleMulti(i: number, f: LeadField): void {
    this.setField(i, this.mapping[i] === f ? '' : f);
  }

  get unmapped(): number[] { return this.headings.map((_, i) => i).filter(i => !this.mapping[i]); }
  get unmappedText(): string { return this.unmapped.map(i => this.headings[i]).join(', '); }

  resetGuess(): void {
    this.mapping = autoMap(this.headings);
    this.remember();
    this.emit();
  }

  /** A field that takes one column moves to the column just chosen. */
  setField(i: number, f: LeadField): void {
    const multi = f === 'notes' || f === 'city';
    this.mapping = this.mapping.map((m, j) => (j === i ? f : (!multi && f && m === f ? '' : m)));
    this.remember();
    this.emit();
  }

  get problem(): string {
    const has = (f: LeadField) => this.mapping.includes(f);
    if (!has('name') && !has('firstName') && !has('lastName') && !has('companyName') && !has('email')) {
      return 'Match at least one column to Full name, First name, Company or Email, so each lead has a name.';
    }
    if (!has('email') && !has('phone')) return 'No Email or Phone column is matched: leads will have no way to contact them.';
    return '';
  }

  emit(): void {
    this.rowsChange.emit(buildLeadRows(this.cells, this.headerRow, this.mapping, { extraToNotes: this.extraToNotes }));
  }

  private remembered(): LeadField[] | null {
    try {
      const all = JSON.parse(localStorage.getItem(LeadImportMapperComponent.STORE) || '{}');
      const m = all[headingsKey(this.headings)];
      return Array.isArray(m) && m.length === this.headings.length ? m : null;
    } catch { return null; }
  }

  private remember(): void {
    try {
      const all = JSON.parse(localStorage.getItem(LeadImportMapperComponent.STORE) || '{}');
      all[headingsKey(this.headings)] = this.mapping;
      const keys = Object.keys(all);
      if (keys.length > 30) delete all[keys[0]];
      localStorage.setItem(LeadImportMapperComponent.STORE, JSON.stringify(all));
    } catch { /* storage unavailable: matches are not remembered */ }
  }
}
