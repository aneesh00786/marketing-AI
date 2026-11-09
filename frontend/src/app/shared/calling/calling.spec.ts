import { ComponentFixture, TestBed, fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CallButtonComponent } from './call-button.component';
import { CallService } from './call.service';
import { SoftphoneComponent } from './softphone.component';

/** Stands in for the Telnyx SDK: no network, microphone or real call. */
class FakeClient {
  static last: FakeClient;
  handlers: Record<string, (x?: any) => void> = {};
  remoteElement: any = null;
  disconnected = false;
  placed: any = null;
  call = { hangup: jasmine.createSpy('hangup'), muteAudio: jasmine.createSpy('mute'), unmuteAudio: jasmine.createSpy('unmute'), dtmf: jasmine.createSpy('dtmf') };
  constructor(public options: any) { FakeClient.last = this; }
  on(name: string, fn: (x?: any) => void): void { this.handlers[name] = fn; }
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
  newCall(o: any): any { this.placed = o; return this.call; }
  state(s: string): void { this.handlers['telnyx.notification']({ type: 'callUpdate', call: { state: s } }); }
}

describe('Browser calling', () => {
  let http: HttpTestingController;
  let calls: CallService;
  let track: { stop: jasmine.Spy };
  const token = () => http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/calling/token'));
  const SESSION = { token: 'jwt', destination: '+919876543210', callerId: '+61390721221', callerName: 'Acme' };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SoftphoneComponent, CallButtonComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    calls = TestBed.inject(CallService);
    (window as any).TelnyxWebRTC = { TelnyxRTC: FakeClient };
    track = { stop: jasmine.createSpy('stop') };
    spyOn(navigator.mediaDevices, 'getUserMedia').and.resolveTo({ getTracks: () => [track] } as any);
  });
  afterEach(() => { delete (window as any).TelnyxWebRTC; http.verify(); });

  function dial(): void {
    calls.prepare('+91 98765 43210', 'Ann');
    calls.start();
    flushMicrotasks();
    token().flush(SESSION);
    flushMicrotasks();
    FakeClient.last.handlers['telnyx.ready']();
  }

  describe('call button', () => {
    function button(phone: string | null): { f: ComponentFixture<CallButtonComponent>; el: HTMLElement } {
      const f = TestBed.createComponent(CallButtonComponent);
      f.componentRef.setInput('phone', phone);
      f.componentRef.setInput('name', 'Ann');
      f.detectChanges();
      return { f, el: f.nativeElement };
    }

    it('shows only when the user can call and there is a real number', () => {
      expect(button('+91 98765 43210').el.querySelector('button')).withContext('no access').toBeNull();
      calls.available = true;
      expect(button('+91 98765 43210').el.querySelector('button')).toBeTruthy();
      expect(button(null).el.querySelector('button')).toBeNull();
      expect(button('123').el.querySelector('button')).toBeNull();
    });

    it('clicking opens the panel with the number, and does not start the call', () => {
      calls.available = true;
      (button('9876543210').el.querySelector('button') as HTMLButtonElement).click();
      expect([calls.panelOpen, calls.number, calls.name, calls.state]).toEqual([true, '9876543210', 'Ann', 'idle']);
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      http.expectNone(r => r.url.includes('/calling/token'));
    });
  });

  describe('a call', () => {
    it('asks for access once, and only allowed and set-up users get the icon', () => {
      calls.loadAccess();
      http.expectOne(r => r.url.endsWith('/calling/status')).flush({ canCall: true, configured: false });
      expect(calls.available).toBeFalse();
      calls.loadAccess();
      http.expectOne(r => r.url.endsWith('/calling/status')).flush({ canCall: true, configured: true });
      expect(calls.available).toBeTrue();
      calls.loadAccess();
      http.expectOne(r => r.url.endsWith('/calling/status')).flush({}, { status: 500, statusText: 'x' });
      expect(calls.available).toBeFalse();
    });

    it('dials the number the server checked, with the company caller ID', fakeAsync(() => {
      dial();
      expect(FakeClient.last.options).toEqual({ login_token: 'jwt' });
      expect(FakeClient.last.placed).toEqual(jasmine.objectContaining({ destinationNumber: '+919876543210', callerNumber: '+61390721221', callerName: 'Acme', audio: true, video: false }));
      expect(calls.state).toBe('ringing');
      calls.hangup();
      flushMicrotasks();
    }));

    it('follows the call: ringing, connected with a timer, then ended; the microphone is released', fakeAsync(() => {
      dial();
      FakeClient.last.state('ringing');
      expect(calls.message).toBe('Ringing…');
      FakeClient.last.state('active');
      expect(calls.state).toBe('active');
      tick(3000);
      expect(calls.seconds).toBe(3);
      const client = FakeClient.last;
      client.state('hangup');
      expect(calls.state).toBe('ended');
      expect(client.disconnected).toBeTrue();
      expect(track.stop).toHaveBeenCalled();
      tick(5000);
      expect(calls.seconds).withContext('timer stopped').toBe(3);
    }));

    it('hang up, mute and keypad reach the call', fakeAsync(() => {
      dial();
      FakeClient.last.state('active');
      const c = FakeClient.last.call;
      calls.toggleMute();
      expect([c.muteAudio.calls.count(), calls.muted]).toEqual([1, true]);
      calls.toggleMute();
      expect([c.unmuteAudio.calls.count(), calls.muted]).toEqual([1, false]);
      calls.sendDigit('5');
      expect(c.dtmf).toHaveBeenCalledWith('5');
      calls.hangup();
      expect(c.hangup).toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
    }));

    it('a refused microphone is explained, and nothing is requested from the server', fakeAsync(() => {
      (navigator.mediaDevices.getUserMedia as jasmine.Spy).and.rejectWith(new Error('denied'));
      calls.prepare('+919876543210');
      calls.start();
      flushMicrotasks();
      expect(calls.state).toBe('ended');
      expect(calls.message).toContain('Allow microphone');
      http.expectNone(r => r.url.includes('/calling/token'));
    }));

    it('a server refusal shows its reason and releases the microphone', fakeAsync(() => {
      calls.prepare('9876543210');
      calls.start();
      flushMicrotasks();
      token().flush({ error: 'Enter the full number with its country code.' }, { status: 400, statusText: 'x' });
      flushMicrotasks();
      expect(calls.message).toContain('country code');
      expect(track.stop).toHaveBeenCalled();
    }));

    it('gives up if the service never connects', fakeAsync(() => {
      calls.prepare('+919876543210');
      calls.start();
      flushMicrotasks();
      token().flush(SESSION);
      flushMicrotasks();
      tick(20000);
      expect(calls.state).toBe('ended');
      expect(track.stop).toHaveBeenCalled();
    }));

    it('a second call cannot replace one in progress', fakeAsync(() => {
      dial();
      calls.prepare('+15550100100', 'Other');
      expect(calls.number).toBe('+91 98765 43210');
      expect(calls.message).toContain('Finish the current call');
      calls.closePanel();
      expect(calls.panelOpen).withContext('cannot close during a call').toBeTrue();
      calls.hangup();
    }));
  });

  describe('call log and transcript', () => {
    class FakeRecorder {
      static made: FakeRecorder[] = [];
      static isTypeSupported = () => true;
      state = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(public stream: any, public options: any) { FakeRecorder.made.push(this); }
      start(): void { this.state = 'recording'; }
      stop(): void { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.(); }
    }
    let real: any;
    const SESSION_LOG = { ...SESSION, callLogId: 42 };
    const logUrl = (s: string) => http.expectOne(r => r.method === 'POST' && r.url.endsWith(`/api/v1/calling/logs/42${s}`));

    beforeEach(() => { real = (window as any).MediaRecorder; (window as any).MediaRecorder = FakeRecorder; FakeRecorder.made = []; });
    afterEach(() => { (window as any).MediaRecorder = real; });

    function connect(transcribe: boolean): void {
      calls.prepare('+91 98765 43210', 'Ann', 9);
      calls.transcribe = transcribe;
      calls.start();
      flushMicrotasks();
      const req = token();
      expect(req.request.body).toEqual({ to: '+91 98765 43210', name: 'Ann', contactId: 9, transcribe });
      req.flush(SESSION_LOG);
      flushMicrotasks();
      FakeClient.last.handlers['telnyx.ready']();
      (FakeClient.last.call as any).remoteStream = { remote: true };
    }

    it('the box is off for every new call', () => {
      calls.prepare('+919876543210');
      calls.transcribe = true;
      calls.prepare('+919876543211');
      expect(calls.transcribe).toBeFalse();
    });

    it('without the box ticked nothing is recorded; the call is still logged', fakeAsync(() => {
      connect(false);
      FakeClient.last.state('active');
      expect(FakeRecorder.made.length).toBe(0);
      tick(5000);
      calls.hangup();
      flushMicrotasks();
      const end = logUrl('/end');
      expect(end.request.body).toEqual({ durationSeconds: 5, answered: true });
      end.flush({ status: 'none' });
      flushMicrotasks();
      expect(calls.transcriptState).toBe('');
    }));

    it('records each side separately, stops the microphone, and uploads both', fakeAsync(() => {
      connect(true);
      FakeClient.last.state('active');
      expect(FakeRecorder.made.length).toBe(2);
      expect(FakeRecorder.made[1].stream).toEqual({ remote: true });
      tick(3000);
      FakeClient.last.state('hangup');
      FakeClient.last.state('destroy');
      flushMicrotasks();
      expect(FakeRecorder.made.every(r => r.state === 'inactive')).toBeTrue();
      expect(track.stop).toHaveBeenCalled();
      const end = logUrl('/end');
      expect(end.request.body).toEqual({ durationSeconds: 3, answered: true, audioCaptured: true });
      end.flush({ status: 'pending' });
      flushMicrotasks();
      expect(calls.transcriptState).toBe('saving');
      const a = logUrl('/audio/agent');
      expect(a.request.body instanceof Blob).toBeTrue();
      expect(a.request.headers.get('Content-Type')).toBe('audio/webm');
      a.flush({ status: 'pending' });
      flushMicrotasks();
      logUrl('/audio/customer').flush({ status: 'done' });
      flushMicrotasks();
      expect(calls.transcriptState).toBe('saved');
    }));

    it('an unanswered call records nothing and uploads nothing', fakeAsync(() => {
      connect(true);
      FakeClient.last.state('hangup');
      flushMicrotasks();
      expect(FakeRecorder.made.length).toBe(0);
      const end = logUrl('/end');
      expect(end.request.body).toEqual({ durationSeconds: 0, answered: false, audioCaptured: false });
      end.flush({ status: 'none' });
      flushMicrotasks();
      expect(calls.transcriptState).toBe('');
    }));

    it('if a side cannot be captured, the log is told and nothing is uploaded', fakeAsync(() => {
      connect(true);
      (FakeClient.last.call as any).remoteStream = null;
      FakeClient.last.state('active');
      tick(3500); // the customer's audio is looked for a few times
      expect(calls.transcriptError).toContain('did not provide the call audio');
      calls.hangup();
      flushMicrotasks();
      const end = logUrl('/end');
      expect(end.request.body.audioCaptured).toBeFalse();
      end.flush({ status: 'failed' });
      flushMicrotasks();
      expect(calls.transcriptState).toBe('failed');
    }));

    it('a failed upload says so', fakeAsync(() => {
      connect(true);
      FakeClient.last.state('active');
      calls.hangup();
      flushMicrotasks();
      logUrl('/end').flush({ status: 'pending' });
      flushMicrotasks();
      logUrl('/audio/agent').flush({ error: 'Telnyx could not transcribe this call (HTTP 403).' }, { status: 502, statusText: 'x' });
      flushMicrotasks();
      expect(calls.transcriptState).toBe('failed');
      expect(calls.transcriptError).toContain('HTTP 403');
    }));
  });

  describe('panel', () => {
    function panel(): { f: ComponentFixture<SoftphoneComponent>; c: SoftphoneComponent; el: HTMLElement } {
      const f = TestBed.createComponent(SoftphoneComponent);
      f.detectChanges();
      http.expectOne(r => r.url.endsWith('/calling/status')).flush({ canCall: true, configured: true });
      f.detectChanges();
      return { f, c: f.componentInstance, el: f.nativeElement };
    }
    const button = (el: HTMLElement, t: string) => Array.from(el.querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement;

    it('is hidden until a number is chosen, then lets the user check it before calling', fakeAsync(() => {
      const { f, el } = panel();
      expect(el.querySelector('section')).toBeNull();
      calls.prepare('9876543210', 'Ann');
      f.detectChanges();
      tick();
      expect(el.textContent).toContain('Ann');
      expect(el.querySelector('app-crm-phone-input')).toBeTruthy();
      expect(button(el, 'Call')).toBeTruthy();
      expect(calls.state).toBe('idle');
    }));

    it('offers transcription off by default, with a reminder to tell the customer', fakeAsync(() => {
      const { f, el } = panel();
      calls.prepare('+919876543210', 'Ann');
      f.detectChanges();
      tick();
      const box = el.querySelector('.sp-consent input') as HTMLInputElement;
      expect(box.checked).toBeFalse();
      expect(el.textContent).not.toContain('Tell the customer');
      box.click();
      f.detectChanges();
      tick();
      expect(calls.transcribe).toBeTrue();
      expect(el.textContent).toContain('Tell the customer before you start');
    }));

    it('shows the timer, mute, keypad and hang up during a call', fakeAsync(() => {
      const { f, c, el } = panel();
      dial();
      FakeClient.last.state('active');
      f.detectChanges();
      tick(65000);
      f.detectChanges();
      expect(c.time).toBe('01:05');
      expect(el.textContent).toContain('01:05');
      expect(el.querySelector('app-crm-phone-input')).toBeNull();
      button(el, 'Keypad').click();
      f.detectChanges();
      expect(el.querySelectorAll('.sp-keys button').length).toBe(12);
      button(el, 'Hang up').click();
      f.detectChanges();
      expect(button(el, 'Call again')).toBeTruthy();
    }));

    it('signing out ends the call', fakeAsync(() => {
      const { f } = panel();
      dial();
      f.destroy();
      expect(track.stop).toHaveBeenCalled();
      expect([calls.available, calls.panelOpen]).toEqual([false, false]);
    }));
  });
});
