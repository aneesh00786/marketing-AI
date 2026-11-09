import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/** Country and dial code. Countries sharing a code (US/Canada, Russia/Kazakhstan) are listed once each. */
export const COUNTRY_CODES: { name: string; code: string }[] = [
  ['Afghanistan', '93'], ['Albania', '355'], ['Algeria', '213'], ['Andorra', '376'], ['Angola', '244'], ['Antigua and Barbuda', '1268'], ['Argentina', '54'], ['Armenia', '374'],
  ['Australia', '61'], ['Austria', '43'], ['Azerbaijan', '994'], ['Bahamas', '1242'], ['Bahrain', '973'], ['Bangladesh', '880'], ['Barbados', '1246'], ['Belarus', '375'],
  ['Belgium', '32'], ['Belize', '501'], ['Benin', '229'], ['Bhutan', '975'], ['Bolivia', '591'], ['Bosnia and Herzegovina', '387'], ['Botswana', '267'], ['Brazil', '55'],
  ['Brunei', '673'], ['Bulgaria', '359'], ['Burkina Faso', '226'], ['Burundi', '257'], ['Cambodia', '855'], ['Cameroon', '237'], ['Canada', '1'], ['Cape Verde', '238'],
  ['Central African Republic', '236'], ['Chad', '235'], ['Chile', '56'], ['China', '86'], ['Colombia', '57'], ['Comoros', '269'], ['Congo', '242'], ['Congo (DRC)', '243'],
  ['Costa Rica', '506'], ['Croatia', '385'], ['Cuba', '53'], ['Cyprus', '357'], ['Czechia', '420'], ['Denmark', '45'], ['Djibouti', '253'], ['Dominica', '1767'],
  ['Dominican Republic', '1809'], ['Ecuador', '593'], ['Egypt', '20'], ['El Salvador', '503'], ['Equatorial Guinea', '240'], ['Eritrea', '291'], ['Estonia', '372'], ['Eswatini', '268'],
  ['Ethiopia', '251'], ['Fiji', '679'], ['Finland', '358'], ['France', '33'], ['Gabon', '241'], ['Gambia', '220'], ['Georgia', '995'], ['Germany', '49'],
  ['Ghana', '233'], ['Greece', '30'], ['Grenada', '1473'], ['Guatemala', '502'], ['Guinea', '224'], ['Guinea-Bissau', '245'], ['Guyana', '592'], ['Haiti', '509'],
  ['Honduras', '504'], ['Hong Kong', '852'], ['Hungary', '36'], ['Iceland', '354'], ['India', '91'], ['Indonesia', '62'], ['Iran', '98'], ['Iraq', '964'],
  ['Ireland', '353'], ['Israel', '972'], ['Italy', '39'], ['Ivory Coast', '225'], ['Jamaica', '1876'], ['Japan', '81'], ['Jordan', '962'], ['Kazakhstan', '7'],
  ['Kenya', '254'], ['Kiribati', '686'], ['Kosovo', '383'], ['Kuwait', '965'], ['Kyrgyzstan', '996'], ['Laos', '856'], ['Latvia', '371'], ['Lebanon', '961'],
  ['Lesotho', '266'], ['Liberia', '231'], ['Libya', '218'], ['Liechtenstein', '423'], ['Lithuania', '370'], ['Luxembourg', '352'], ['Macau', '853'], ['Madagascar', '261'],
  ['Malawi', '265'], ['Malaysia', '60'], ['Maldives', '960'], ['Mali', '223'], ['Malta', '356'], ['Marshall Islands', '692'], ['Mauritania', '222'], ['Mauritius', '230'],
  ['Mexico', '52'], ['Micronesia', '691'], ['Moldova', '373'], ['Monaco', '377'], ['Mongolia', '976'], ['Montenegro', '382'], ['Morocco', '212'], ['Mozambique', '258'],
  ['Myanmar', '95'], ['Namibia', '264'], ['Nauru', '674'], ['Nepal', '977'], ['Netherlands', '31'], ['New Zealand', '64'], ['Nicaragua', '505'], ['Niger', '227'],
  ['Nigeria', '234'], ['North Korea', '850'], ['North Macedonia', '389'], ['Norway', '47'], ['Oman', '968'], ['Pakistan', '92'], ['Palau', '680'], ['Palestine', '970'],
  ['Panama', '507'], ['Papua New Guinea', '675'], ['Paraguay', '595'], ['Peru', '51'], ['Philippines', '63'], ['Poland', '48'], ['Portugal', '351'], ['Qatar', '974'],
  ['Romania', '40'], ['Russia', '7'], ['Rwanda', '250'], ['Saint Kitts and Nevis', '1869'], ['Saint Lucia', '1758'], ['Saint Vincent and the Grenadines', '1784'], ['Samoa', '685'], ['San Marino', '378'],
  ['Sao Tome and Principe', '239'], ['Saudi Arabia', '966'], ['Senegal', '221'], ['Serbia', '381'], ['Seychelles', '248'], ['Sierra Leone', '232'], ['Singapore', '65'], ['Slovakia', '421'],
  ['Slovenia', '386'], ['Solomon Islands', '677'], ['Somalia', '252'], ['South Africa', '27'], ['South Korea', '82'], ['South Sudan', '211'], ['Spain', '34'], ['Sri Lanka', '94'],
  ['Sudan', '249'], ['Suriname', '597'], ['Sweden', '46'], ['Switzerland', '41'], ['Syria', '963'], ['Taiwan', '886'], ['Tajikistan', '992'], ['Tanzania', '255'],
  ['Thailand', '66'], ['Timor-Leste', '670'], ['Togo', '228'], ['Tonga', '676'], ['Trinidad and Tobago', '1868'], ['Tunisia', '216'], ['Turkey', '90'], ['Turkmenistan', '993'],
  ['Tuvalu', '688'], ['Uganda', '256'], ['Ukraine', '380'], ['United Arab Emirates', '971'], ['United Kingdom', '44'], ['United States', '1'], ['Uruguay', '598'], ['Uzbekistan', '998'],
  ['Vanuatu', '678'], ['Vatican City', '379'], ['Venezuela', '58'], ['Vietnam', '84'], ['Yemen', '967'], ['Zambia', '260'], ['Zimbabwe', '263']
].map(([name, code]) => ({ name, code }));

/** No country is assumed: the person entering a number chooses its code (or types it, e.g. +61 …). */
const DEFAULT_CODE = '';

export const PHONE_MESSAGE = 'Enter the phone number with its country code, like +61 412 345 678.';

/** '' when the value is empty or a complete international number (+ code, 7–15 digits); otherwise why not. */
export function phoneProblem(value: string | null | undefined): string {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (!/^\+[1-9][\d\s().-]*$/.test(v)) return PHONE_MESSAGE;
  const digits = v.replace(/\D/g, '').length;
  return digits < 7 || digits > 15 ? 'Enter a complete phone number with its country code.' : '';
}

/** Splits a saved number into its dial code and the rest. The longest matching code wins (+1868 before +1). */
export function splitPhone(value: string | null | undefined): { code: string; number: string } {
  const text = String(value || '').trim();
  if (!text.startsWith('+')) return { code: DEFAULT_CODE, number: text };
  const spaced = /^\+(\d{1,4})[\s-]+(.*)$/.exec(text);
  if (spaced && COUNTRY_CODES.some(c => c.code === spaced[1])) return { code: spaced[1], number: spaced[2] };
  const digits = text.slice(1);
  const hit = COUNTRY_CODES.filter(c => digits.startsWith(c.code)).sort((a, b) => b.code.length - a.code.length)[0];
  return hit ? { code: hit.code, number: digits.slice(hit.code.length).trim() } : { code: DEFAULT_CODE, number: digits };
}

/** A country code and a number, saved together as one value such as "+91 98765 43210". */
@Component({
  selector: 'app-crm-phone-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <fieldset class="cp" [class.cp-bad]="showProblem">
      <legend *ngIf="label">{{ label }}</legend>
      <div class="cp-row">
        <div class="cp-code">
          <!-- Closed, the box shows the code; open, the list shows countries, and typing a name finds one. -->
          <select class="hud-input" [ngModel]="code" (ngModelChange)="code = $event; emit()" [ngModelOptions]="{ standalone: true }" [attr.aria-label]="(label || 'Phone') + ' country code'">
            <option value="" disabled>Choose the country code</option>
            <option *ngFor="let c of countries; trackBy: trackCountry" [value]="c.code">{{ c.name }} (+{{ c.code }})</option>
          </select>
          <span class="cp-shown" [class.cp-none]="!code" aria-hidden="true">{{ code ? '+' + code : 'Code' }}</span>
          <svg class="cp-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <input class="hud-input" type="tel" inputmode="tel" maxlength="30" [ngModel]="number" (ngModelChange)="number = $event; emit()" [ngModelOptions]="{ standalone: true }" [placeholder]="placeholder" [attr.aria-label]="(label || 'Phone') + ' number'" />
      </div>
      <small class="cp-msg" *ngIf="showProblem" role="alert">{{ number && !code ? 'Choose the country code for this number (or type it, like +61 412 345 678).' : problem }}</small>
    </fieldset>
  `,
  styleUrls: ['../command/command-center.component.css'],
  styles: [`
    :host { display: block; min-width: 0; }
    .cp { border: 0; margin: 0; padding: 0; min-width: 0; }
    .cp legend { padding: 0; margin-bottom: 4px; font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }
    .cp-row { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 6px; }
    .cp-code { position: relative; min-width: 0; }
    .cp-code select { color: transparent; }
    .cp-code select option { color: var(--text); background: var(--surface); }
    .cp-arrow { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--text); }
    .cp-none { color: var(--text-muted) !important; }
    .cp-bad .hud-input { border-color: var(--danger-text, #b91c1c); }
    .cp-msg { display: block; margin-top: 4px; color: var(--danger-text, #b91c1c); font-size: 0.78rem; }
    .cp-shown { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--text); font-size: 0.9rem; font-variant-numeric: tabular-nums; }
  `]
})
export class CrmPhoneInputComponent implements OnChanges {
  @Input() value: string | null = '';
  @Input() label = 'Phone';
  @Input() placeholder = 'Phone number';
  @Output() valueChange = new EventEmitter<string>();

  readonly countries = COUNTRY_CODES;
  code = DEFAULT_CODE;
  number = '';
  private emitted: string | null = null;

  ngOnChanges(): void {
    if (this.value === this.emitted) return;
    const parts = splitPhone(this.value);
    this.code = parts.code;
    this.number = parts.number;
  }

  trackCountry(_: number, c: { name: string }): string { return c.name; }

  /** The value as it will be saved; why it cannot be saved yet ('' when fine). */
  get problem(): string { return phoneProblem(this.emitted ?? ''); }
  get showProblem(): boolean { return !!this.number.trim() && !!this.problem; }

  emit(): void {
    let number = this.number.trim();
    // Typed with its code ("+61 412…", "0061 412…"): the code moves to the picker.
    if (/^(\+|00)[1-9]/.test(number)) {
      const parts = splitPhone('+' + number.replace(/^(\+|00)/, ''));
      if (parts.code) { this.code = parts.code; number = parts.number; this.number = number; }
    }
    // Without a code the number is passed on as typed, so the form sees it is not complete.
    this.emitted = number ? (this.code ? `+${this.code} ${number}` : number) : '';
    this.valueChange.emit(this.emitted);
  }
}
