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
  transcriptState: '' | 'saving' | 'saved' | 'failed' = '';

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
  prepare(phone: string, name = '', contactId: number | null = null, followUp: { campaignId: number; email: string } | null = null): void {
    if (this.inCall) { this.message = 'Finish the current call first.'; return; }
    this.number = phone;
    this.name = name;
    this.contactId = contactId;
    this.followUp = followUp;
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
    this.callLogId = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot make calls here. Calling needs a secure (https) page.');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error('Allow microphone access in your browser to make calls.');
      });
      this.message = 'Connecting…';
      const session = await firstValueFrom(this.http.post<any>(`${this.base}/token`, {
        to: this.number, name: this.name || undefined, contactId: this.contactId ?? undefined, transcribe: this.transcribe,
        ...(this.followUp ? { campaignId: this.followUp.campaignId, email: this.followUp.email } : {})
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
      const s = n.call.state;
      if (s === 'ringing' || s === 'early') {
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

  private startCapture(): void {
    const remote: MediaStream | null = this.call?.remoteStream || (this.audio?.srcObject as MediaStream | null) || null;
    if (typeof MediaRecorder === 'undefined' || !this.stream || !remote) return;
    try {
      this.captures = [this.capture('agent', this.stream), this.capture('customer', remote)];
    } catch {
      this.captures = [];
    }
  }

  /** Records how the call went and, if it was captured, sends each side to be transcribed. */
  private async save(logId: number, durationSeconds: number, answered: boolean, wanted: boolean, captures: Capture[]): Promise<void> {
    const audioCaptured = captures.length === 2;
    try {
      const url = `${this.base}/logs/${logId}`;
      await firstValueFrom(this.http.post(`${url}/end`, { durationSeconds, answered, ...(wanted ? { audioCaptured } : {}) }));
      if (!wanted || !answered) return;
      if (!audioCaptured) { this.transcriptState = 'failed'; return; }
      this.transcriptState = 'saving';
      for (const c of captures) {
        const blob = await c.finished;
        await firstValueFrom(this.http.post(`${url}/audio/${c.track}`, blob, { headers: { 'Content-Type': blob.type } }));
      }
      this.transcriptState = 'saved';
    } catch {
      if (wanted && answered) this.transcriptState = 'failed';
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
    if (logId) void this.save(logId, this.seconds, answered, this.transcribe, captures);
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
