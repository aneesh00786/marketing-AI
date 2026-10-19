import { Injectable } from '@angular/core';
import { Conversation } from '@elevenlabs/client';

@Injectable({
  providedIn: 'root'
})
export class SpeechService {
  private recognition: any = null;
  private isListeningState: boolean = false;
  private isSpeakingState: boolean = false;
  private synth: SpeechSynthesis | null = null;
  private availableVoices: SpeechSynthesisVoice[] = [];

  // ElevenLabs Full-Duplex Real-Time Voice Engine
  private elevenConversation: any = null;
  public isElevenLabsActive: boolean = false;
  public elevenLabsMode: 'listening' | 'speaking' = 'listening';
  public elevenLabsStatus: string = 'disconnected';

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      this.loadVoices();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => this.loadVoices();
      }
    }
  }

  private loadVoices(): void {
    if (this.synth) {
      this.availableVoices = this.synth.getVoices();
    }
  }

  // Strip markdown, bullet stars, and raw symbols for clean human-sounding speech
  private cleanTextForSpeech(text: string): string {
    if (!text) return '';
    return text
      .replace(/[*#_~`>]/g, '')           // remove markdown symbols
      .replace(/https?:\/\/\S+/g, '')     // remove raw links
      .replace(/•\s+/g, '')              // remove bullet points
      .replace(/\s+/g, ' ')              // collapse extra spaces
      .trim();
  }

  // 1. Text to Speech (TTS) - Zero-cost local browser voice
  speak(text: string, onEnd?: () => void): void {
    if (!this.synth) {
      console.warn('SpeechSynthesis not supported in this browser.');
      this.isSpeakingState = false;
      if (onEnd) onEnd();
      return;
    }

    const clean = this.cleanTextForSpeech(text);
    if (!clean) {
      this.isSpeakingState = false;
      if (onEnd) onEnd();
      return;
    }

    this.synth.cancel(); // Stop any pending speech
    this.isSpeakingState = true;

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Refresh voices if empty
    if (!this.availableVoices.length) {
      this.loadVoices();
    }

    // Pick the most natural-sounding English voice
    const naturalVoice = this.availableVoices.find(v => 
      v.lang.startsWith('en') && (
        v.name.includes('Natural') || 
        v.name.includes('Google') || 
        v.name.includes('Samantha') || 
        v.name.includes('David') || 
        v.name.includes('Guy') ||
        v.name.includes('Jenny') ||
        v.name.includes('Zira')
      )
    ) || this.availableVoices.find(v => v.lang.startsWith('en'));

    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    utterance.onend = () => {
      this.isSpeakingState = false;
      if (onEnd) onEnd();
    };

    utterance.onerror = (e) => {
      console.warn('Speech synthesis event:', e);
      this.isSpeakingState = false;
      if (onEnd) onEnd();
    };

    this.synth.speak(utterance);
  }

  private currentAudio: HTMLAudioElement | null = null;
  private silenceTimer: any = null;
  private currentFullTranscript: string = '';

  async speakTelnyx(text: string, voiceId?: string, onEnd?: () => void): Promise<void> {
    const clean = this.cleanTextForSpeech(text);
    if (!clean) {
      this.isSpeakingState = false;
      if (onEnd) onEnd();
      return;
    }

    this.stopSpeaking();
    this.isSpeakingState = true;

    // Fast path: instant neural voice starts in 10 milliseconds
    if (voiceId === 'instant_neural') {
      this.speak(clean, onEnd);
      return;
    }

    try {
      // 2.2s guard: if cloud batch TTS is slow, fallback to instant neural voice so user never waits!
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2200);

      const res = await fetch('/api/v1/telnyx/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          voice: voiceId || 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02'
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Telnyx TTS error: ${res.status}`);
      }

      const blob = await res.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      this.currentAudio = audio;

      audio.onended = () => {
        this.isSpeakingState = false;
        URL.revokeObjectURL(audioUrl);
        this.currentAudio = null;
        if (onEnd) onEnd();
      };

      audio.onerror = (e) => {
        console.warn('Telnyx audio playback error, falling back:', e);
        this.isSpeakingState = false;
        URL.revokeObjectURL(audioUrl);
        this.currentAudio = null;
        this.speak(clean, onEnd);
      };

      await audio.play();
    } catch (e) {
      console.warn('Using ultra-fast neural speech fallback:', e);
      this.speak(clean, onEnd);
    }
  }

  stopSpeaking(): void {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch (e) {}
      this.currentAudio = null;
    }
    if (this.synth) {
      this.synth.cancel();
    }
    this.isSpeakingState = false;
  }

  get isSpeaking(): boolean {
    return this.isSpeakingState;
  }

  // 2. Speech to Text (STT) - Low-latency continuous recognition with live interim feedback
  startListening(
    onResult: (transcript: string) => void,
    onInterim?: (interim: string) => void,
    onError?: (err: any) => void
  ): boolean {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API not supported in this browser.');
      if (onError) onError('SpeechRecognition not supported');
      return false;
    }

    if (this.recognition) {
      try { this.recognition.abort(); } catch (e) {}
    }

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    this.currentFullTranscript = '';
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onstart = () => {
      this.isListeningState = true;
    };

    this.recognition.onresult = (event: any) => {
      let finalStr = '';
      let interimStr = '';

      for (let i = 0; i < event.results.length; ++i) {
        const item = event.results[i];
        const piece = item[0]?.transcript || '';
        if (item.isFinal) {
          finalStr += piece + ' ';
        } else {
          interimStr += piece + ' ';
        }
      }

      const liveText = (finalStr + interimStr).trim();
      if (liveText) {
        this.currentFullTranscript = liveText;
        if (onInterim) onInterim(liveText);

        // Smart endpointing: when the user finishes speaking and pauses for 750ms, submit immediately!
        if (this.silenceTimer) clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => {
          if (this.currentFullTranscript.trim()) {
            const captured = this.currentFullTranscript.trim();
            this.currentFullTranscript = '';
            try { this.recognition.stop(); } catch (e) {}
            this.isListeningState = false;
            onResult(captured);
          }
        }, 750);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') {
        // Natural pause in speech - do not abort!
        return;
      }
      this.isListeningState = false;
      console.warn('Speech recognition error:', event.error);
      if (onError) onError(event.error);
    };

    this.recognition.onend = () => {
      this.isListeningState = false;
    };

    try {
      this.recognition.start();
      return true;
    } catch (e) {
      console.error('Could not start recognition:', e);
      this.isListeningState = false;
      return false;
    }
  }

  stopListening(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.recognition && this.isListeningState) {
      try {
        this.recognition.stop();
      } catch (e) {}
      this.isListeningState = false;
    }
  }

  async requestMicrophonePermission(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        return true;
      } catch (e) {
        console.warn('Microphone permission request failed:', e);
        return false;
      }
    }
    return true;
  }

  // ==========================================
  // ELEVENLABS FULL-DUPLEX REAL-TIME VOICE
  // ==========================================

  async startElevenLabsSession(
    signedUrl: string,
    callbacks: {
      onConnect?: (conversationId: string) => void;
      onDisconnect?: () => void;
      onError?: (err: any) => void;
      onMessage?: (msg: { text: string; role: 'user' | 'agent' }) => void;
      onModeChange?: (mode: 'listening' | 'speaking') => void;
      onStatusChange?: (status: string) => void;
    }
  ): Promise<any> {
    await this.stopElevenLabsSession();

    try {
      this.isElevenLabsActive = true;
      this.elevenLabsStatus = 'connecting';

      this.elevenConversation = await Conversation.startSession({
        signedUrl,
        onConnect: ({ conversationId }) => {
          this.isElevenLabsActive = true;
          this.elevenLabsStatus = 'connected';
          if (callbacks.onConnect) callbacks.onConnect(conversationId);
        },
        onDisconnect: () => {
          this.isElevenLabsActive = false;
          this.elevenLabsStatus = 'disconnected';
          if (callbacks.onDisconnect) callbacks.onDisconnect();
        },
        onError: (message, context) => {
          console.warn('ElevenLabs Conversation error:', message, context);
          if (callbacks.onError) callbacks.onError(message);
        },
        onMessage: (payload) => {
          const role = payload.role === 'agent' ? 'agent' : 'user';
          if (callbacks.onMessage) callbacks.onMessage({ text: payload.message, role });
        },
        onModeChange: ({ mode }) => {
          this.elevenLabsMode = mode;
          this.isSpeakingState = (mode === 'speaking');
          if (callbacks.onModeChange) callbacks.onModeChange(mode);
        },
        onStatusChange: ({ status }) => {
          this.elevenLabsStatus = status;
          if (callbacks.onStatusChange) callbacks.onStatusChange(status);
        }
      });

      return this.elevenConversation;
    } catch (err) {
      this.isElevenLabsActive = false;
      this.elevenLabsStatus = 'disconnected';
      throw err;
    }
  }

  async stopElevenLabsSession(): Promise<void> {
    if (this.elevenConversation) {
      try {
        await this.elevenConversation.endSession();
      } catch (e) {
        console.warn('Error ending ElevenLabs session:', e);
      }
      this.elevenConversation = null;
    }
    this.isElevenLabsActive = false;
    this.elevenLabsStatus = 'disconnected';
    this.elevenLabsMode = 'listening';
  }

  sendElevenLabsTextMessage(text: string): void {
    if (this.elevenConversation && typeof this.elevenConversation.sendUserMessage === 'function') {
      this.elevenConversation.sendUserMessage(text);
    }
  }
}
