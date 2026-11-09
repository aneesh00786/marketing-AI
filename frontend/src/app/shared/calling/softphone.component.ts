import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../icon.component';
import { CrmPhoneInputComponent } from '../../features/crm/crm-phone-input.component';
import { CallService } from './call.service';

/** The call panel. It lives in the app shell, so a call continues while the user moves around. */
@Component({
  selector: 'app-softphone',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, CrmPhoneInputComponent],
  template: `
    <audio #remote autoplay></audio>
    <section class="sp" *ngIf="calls.panelOpen" aria-label="Phone call">
      <header class="sp-head">
        <div class="sp-who">
          <b>{{ calls.name || 'Phone call' }}</b>
          <span class="sp-status" [ngClass]="calls.state" role="status">{{ calls.message || 'Ready to call' }}<ng-container *ngIf="calls.state === 'active'"> · {{ time }}</ng-container></span>
        </div>
        <button *ngIf="!calls.inCall" type="button" class="sp-icon" (click)="calls.closePanel()" aria-label="Close"><app-icon name="x" [size]="16"></app-icon></button>
      </header>

      <app-crm-phone-input *ngIf="!calls.inCall" label="Number" [value]="calls.number" (valueChange)="calls.number = $event"></app-crm-phone-input>
      <p class="sp-number" *ngIf="calls.inCall">{{ calls.number }}</p>

      <label class="sp-consent" *ngIf="!calls.inCall">
        <input type="checkbox" [(ngModel)]="calls.transcribe" [ngModelOptions]="{ standalone: true }" />
        <span>Transcribe this call<small *ngIf="calls.transcribe">Tell the customer before you start. Only the text is kept.</small></span>
      </label>
      <p class="sp-note" *ngIf="calls.inCall && calls.transcribe">Transcribing this call. Tell the customer.</p>
      <p class="sp-note" *ngIf="calls.transcriptState === 'saving'" role="status">Saving the transcript…</p>
      <p class="sp-note good" *ngIf="calls.transcriptState === 'saved'" role="status">Transcript saved in CRM → Calls.</p>
      <p class="sp-note bad" *ngIf="calls.transcriptState === 'failed'" role="status">The transcript could not be made: {{ calls.transcriptError || 'unknown reason' }} The call is still in the log.</p>

      <div class="sp-keys" *ngIf="showKeys && calls.state === 'active'" role="group" aria-label="Keypad">
        <button *ngFor="let k of keys" type="button" (click)="calls.sendDigit(k)">{{ k }}</button>
      </div>

      <div class="sp-actions">
        <button *ngIf="!calls.inCall" type="button" class="sp-call" (click)="calls.start()" [disabled]="!calls.number"><app-icon name="phone" [size]="16"></app-icon>{{ calls.state === 'ended' ? 'Call again' : 'Call' }}</button>
        <ng-container *ngIf="calls.inCall">
          <button *ngIf="calls.state === 'active'" type="button" class="sp-secondary" [class.on]="calls.muted" [attr.aria-pressed]="calls.muted" (click)="calls.toggleMute()">{{ calls.muted ? 'Unmute' : 'Mute' }}</button>
          <button *ngIf="calls.state === 'active'" type="button" class="sp-secondary" [class.on]="showKeys" [attr.aria-pressed]="showKeys" (click)="showKeys = !showKeys">Keypad</button>
          <button type="button" class="sp-hangup" (click)="calls.hangup()">Hang up</button>
        </ng-container>
      </div>
    </section>
  `,
  styleUrls: ['../../features/command/command-center.component.css'],
  styles: [`
    :host { display: contents; }
    audio { display: none; }
    .sp { position: fixed; right: 20px; bottom: 20px; z-index: 1100; width: min(320px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--border-strong, var(--border)); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28); }
    .sp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .sp-who { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
    .sp-who b { font-size: 0.95rem; font-weight: 650; }
    .sp-status { font-size: 0.8rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sp-status.active { color: var(--success-text); }
    .sp-status.ended { color: var(--danger-text); }
    .sp-icon { display: inline-flex; padding: 4px; border: none; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; }
    .sp-icon:hover { background: var(--surface-2); color: var(--text); }
    .sp-number { margin: 0; font-size: 1.05rem; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .sp-consent { display: flex; align-items: flex-start; gap: 8px; font-size: 0.84rem; font-weight: 600; cursor: pointer; }
    .sp-consent input { margin-top: 2px; }
    .sp-consent small { display: block; font-weight: 400; color: var(--warning-text); }
    .sp-note { margin: 0; font-size: 0.78rem; color: var(--warning-text); }
    .sp-note.good { color: var(--success-text); }
    .sp-note.bad { color: var(--danger-text); }
    .sp-keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .sp-keys button { padding: 8px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
    .sp-keys button:hover { border-color: var(--accent); }
    .sp-actions { display: flex; gap: 6px; }
    .sp-actions button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 10px; border-radius: 9px; border: 1px solid transparent; font: inherit; font-size: 0.86rem; font-weight: 600; cursor: pointer; }
    .sp-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    .sp-actions button:focus-visible, .sp-keys button:focus-visible, .sp-icon:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .sp-call { background: #15803d; color: #fff; }
    .sp-hangup { background: #b91c1c; color: #fff; }
    .sp-secondary { background: var(--surface-2); border-color: var(--border) !important; color: var(--text); }
    .sp-secondary.on { background: var(--accent-soft); border-color: var(--accent) !important; }
  `]
})
export class SoftphoneComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('remote') remote?: ElementRef<HTMLAudioElement>;
  readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  showKeys = false;

  constructor(public calls: CallService) {}

  get time(): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(Math.floor(this.calls.seconds / 60))}:${pad(this.calls.seconds % 60)}`;
  }

  ngOnInit(): void { this.calls.loadAccess(); }
  ngAfterViewInit(): void { if (this.remote) this.calls.setAudioElement(this.remote.nativeElement); }

  /** Signing out ends any call, and with it the microphone. */
  ngOnDestroy(): void {
    if (this.calls.inCall) this.calls.hangup();
    this.calls.available = false;
    this.calls.closePanel();
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.calls.inCall || this.calls.transcriptState === 'saving') { e.preventDefault(); e.returnValue = ''; }
  }
}
