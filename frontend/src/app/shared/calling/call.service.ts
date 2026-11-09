import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiRoot } from '../../core/api-base';

export type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ended';

type Track = 'agent' | 'customer';
interface Capture { track: Track; finished: Promise<Blob>; stop: () => void }

const SDK_URL = 'assets/telnyx-webrtc.js';
const CONNECT_TIMEOUT_MS = 20000;
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const AUDIO_BITS_PER_SECOND = 32000;

/**
 * One browser call at a time, placed with Telnyx WebRTC. It stays up while the user moves around
 * the app. The server gives a short-lived token only to users allowed to call, and it checks the
 * number; the Telnyx key never reaches the browser.
 *
 * Every call is logged. Audio is captured only when the caller ticks "Transcribe this call": each
 * side is recorded separately, so the transcript can say who spoke, sent to the server when the
 * call ends, and dropped. It is never saved in the browser.
 */
@Injectable({ providedIn: 'root' })
export class CallService {
  /** The phone icon shows only when this user can call and the server is set up. */
  available = false;
  panelOpen = false;
  state: CallState = 'idle';
  number = '';
  name = '';
  message = '';
  seconds = 0;
  muted = false;
  /** Off for every new call: the caller turns it on after telling the customer. */
  transcribe = false;
  contactId: number | null = null;
  /** A follow-up from a campaign's results: the call is kept with that campaign and person. */
  followUp: { campaignId: number; email: string } | null = null;
  /** A call from a lead (Leads → Follow-ups): kept with that lead and, if any, the follow-up it is for. */
  lead: { leadId: number; followupId?: number | null } | null = null;
  transcriptState: '' | 'saving' | 'saved' | 'failed' = '';
  /** Why the transcript could not be made (shown under the call). */
  transcriptError = '';

  private base = `${apiRoot()}/api/v1/calling`;
  private client: any = null;
  private call: any = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private audio: HTMLAudioElement | null = null;
  private sdk: Promise<void> | null = null;
  private captures: Capture[] = [];
  private callLogId: number | null = null;
  private savedLogs = new Set<number>();

  constructor(private http: HttpClient) {}

  get inCall(): boolean { return ['connecting', 'ringing', 'active'].includes(this.state); }

  loadAccess(): void {
    this.http.get<any>(`${this.base}/status`).subscribe({
      next: r => { this.available = !!(r.canCall && r.configured); },
      error: () => { this.available = false; }
    });
  }

  setAudioElement(el: HTMLAudioElement): void { this.audio = el; }

  /** Opens the panel with the number ready. The call starts only when the user presses Call. */
  prepare(phone: string, name = '', contactId: number | null = null, followUp: { campaignId: number; email: string } | null = null,
    lead: { leadId: number; followupId?: number | null } | null = null): void {
    if (this.inCall) { this.message = 'Finish the current call first.'; return; }
    this.number = phone;
    this.name = name;
    this.contactId = contactId;
    this.followUp = followUp;
    this.lead = lead;
    this.transcribe = false;
    this.transcriptState = '';
    this.state = 'idle';
    this.message = '';
    this.seconds = 0;
    this.panelOpen = true;
  }

  closePanel(): void {
    if (this.inCall) return;
    this.panelOpen = false;
    this.state = 'idle';
    this.message = '';
  }

  private loadSdk(): Promise<void> {
    if ((window as any).TelnyxWebRTC) return Promise.resolve();
    this.sdk ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(SDK_URL, document.baseURI).href;
      script.onload = () => resolve();
      script.onerror = () => { this.sdk = null; reject(new Error('The calling software could not be loaded. Refresh the page and try again.')); };
      document.head.appendChild(script);
    });
    return this.sdk;
  }

  async start(): Promise<void> {
    if (this.inCall) return;
    this.state = 'connecting';
    this.message = 'Waiting for microphone…';
    this.seconds = 0;
    this.muted = false;
    this.transcriptState = '';
    this.transcriptError = '';
    this.callLogId = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot make calls here. Calling needs a secure (https) page.');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error('Allow microphone access in your browser to make calls.');
      });
      this.message = 'Connecting…';
      const session = await firstValueFrom(this.http.post<any>(`${this.base}/token`, {
        to: this.number, name: this.name || undefined, contactId: this.contactId ?? undefined, transcribe: this.transcribe,
        ...(this.followUp ? { campaignId: this.followUp.campaignId, email: this.followUp.email } : {}),
        ...(this.lead ? { leadId: this.lead.leadId, followupId: this.lead.followupId ?? undefined } : {})
      }));
      this.callLogId = session.callLogId ?? null;
      await this.loadSdk();
      this.connect(session);
    } catch (e: any) {
      this.finish('ended', e?.error?.error || e?.message || 'The call could not be started.');
    }
  }

  private connect(session: any): void {
    const client = new (window as any).TelnyxWebRTC.TelnyxRTC({ login_token: session.token });
    this.client = client;
    if (this.audio) client.remoteElement = this.audio;
    this.connectTimer = setTimeout(() => this.finish('ended', 'Could not reach the calling service. Try again.'), CONNECT_TIMEOUT_MS);

    client.on('telnyx.ready', () => {
      // "ready" comes again after a reconnect: one session places one call, never a second one.
      if (this.call || client !== this.client) return;
      this.clearConnectTimer();
      this.state = 'ringing';
      this.message = 'Calling…';
      try {
        this.call = client.newCall({ destinationNumber: session.destination, callerNumber: session.callerId, callerName: session.callerName || undefined, audio: true, video: false });
      } catch (err: any) {
        this.finish('ended', err?.message || 'The call could not be placed.');
      }
    });

    client.on('telnyx.notification', (n: any) => {
      if (n?.type !== 'callUpdate' || !n.call) return;
      // Only this session's current call; late updates from a finished call are ignored.
      if (client !== this.client || !this.inCall) return;
      if (this.call && n.call.id && this.call.id && n.call.id !== this.call.id) return;
      const s = n.call.state;
      if ((s === 'ringing' || s === 'early') && this.state !== 'active') {
        this.state = 'ringing';
        this.message = 'Ringing…';
      } else if (s === 'active' && this.state !== 'active') {
        this.state = 'active';
        this.message = 'Connected';
        this.startTimer();
        if (this.transcribe) this.startCapture();
      } else if (s === 'hangup' || s === 'destroy') {
        this.finish('ended', 'Call ended');
      }
    });

    client.on('telnyx.error', (err: any) => this.finish('ended', err?.message || 'The call service reported an error.'));
    client.connect();
  }

  private startTimer(): void {
    this.seconds = 0;
    this.timer = setInterval(() => this.seconds++, 1000);
  }

  private capture(track: Track, stream: MediaStream): Capture {
    const mimeType = AUDIO_TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] })); });
    recorder.start(1000);
    return { track, finished, stop: () => { if (recorder.state !== 'inactive') recorder.stop(); } };
  }

  /**
   * Starts recording both sides for the transcript. The customer's audio can arrive a moment after
   * the call connects, so it is looked for a few times before giving up (with the reason kept).
   */
  private startCapture(attempt = 0): void {
    if (this.state !== 'active') return;
    const remoteStream = (): MediaStream | null => {
      const s = this.call?.remoteStream || (this.audio?.srcObject as MediaStream | null) || null;
      return s && (typeof s.getAudioTracks !== 'function' || s.getAudioTracks().length) ? s : null;
    };
    const remote = remoteStream();
    if (typeof MediaRecorder === 'undefined') { this.transcriptError = 'This browser cannot record call audio, so the call cannot be transcribed.'; return; }
    if (!this.stream || !remote) {
      if (attempt < 10) { setTimeout(() => this.startCapture(attempt + 1), 300); return; }
      this.transcriptError = 'The browser did not provide the call audio, so nothing could be transcribed.';
      return;
    }
    try {
      this.captures = [this.capture('agent', this.stream), this.capture('customer', remote)];
    } catch (e: any) {
      this.captures = [];
      this.transcriptError = `Recording the call audio failed in this browser (${e?.message || 'unknown error'}).`;
    }
  }

  /** Records how the call went and, if it was captured, sends each side to be transcribed. */
  private async save(logId: number, durationSeconds: number, answered: boolean, wanted: boolean, captures: Capture[]): Promise<void> {
    const audioCaptured = captures.length === 2;
    try {
      const url = `${this.base}/logs/${logId}`;
      await firstValueFrom(this.http.post(`${url}/end`, { durationSeconds, answered, ...(wanted ? { audioCaptured } : {}) }));
      if (!wanted || !answered) return;
      if (!audioCaptured) {
        this.transcriptState = 'failed';
        this.transcriptError ||= 'The call audio was not captured, so nothing could be transcribed.';
        return;
      }
      this.transcriptState = 'saving';
      for (const c of captures) {
        const blob = await c.finished;
        if (!blob.size) throw { transcriptReason: 'No audio was recorded for one side of the call.' };
        await firstValueFrom(this.http.post(`${url}/audio/${c.track}`, blob, { headers: { 'Content-Type': blob.type } }));
      }
      this.transcriptState = 'saved';
    } catch (e: any) {
      if (wanted && answered) {
        this.transcriptState = 'failed';
        this.transcriptError = e?.transcriptReason
          || (e?.status === 413 ? 'The call audio was larger than the web server allows (raise nginx client_max_body_size to 60m).' : '')
          || e?.error?.error || (e?.status === 0 ? 'The audio could not be uploaded (network error).' : `The audio upload failed (HTTP ${e?.status || '?'}).`);
      }
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  /** Ends everything: the call, the connection and the microphone. */
  private finish(state: CallState, message: string): void {
    if (!this.inCall) return; // Telnyx reports the end of a call more than once
    const answered = this.state === 'active';
    const logId = this.callLogId;
    const captures = this.captures;
    this.captures = [];
    captures.forEach(c => c.stop());
    this.clearConnectTimer();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const { call, client, stream } = this;
    this.call = this.client = this.stream = null;
    try { call?.hangup(); } catch { /* already ended */ }
    try { client?.disconnect(); } catch { /* already closed */ }
    stream?.getTracks().forEach(t => t.stop());
    this.muted = false;
    this.state = state;
    this.message = message;
    this.callLogId = null;
    // Each call is saved once, whatever Telnyx reports afterwards.
    if (logId && !this.savedLogs.has(logId)) {
      this.savedLogs.add(logId);
      void this.save(logId, this.seconds, answered, this.transcribe, captures);
    }
  }

  hangup(): void { this.finish('ended', 'Call ended'); }

  toggleMute(): void {
    if (!this.call) return;
    if (this.muted) this.call.unmuteAudio(); else this.call.muteAudio();
    this.muted = !this.muted;
  }

  /** Keypad during a call, for menus such as "press 1". */
  sendDigit(digit: string): void {
    try { this.call?.dtmf(digit); } catch { /* the call has ended */ }
  }
}
