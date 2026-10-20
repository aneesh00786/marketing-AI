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
      onToolExecuted?: (toolName: string) => void;
    }
  ): Promise<any> {
    await this.stopElevenLabsSession();

    try {
      this.isElevenLabsActive = true;
      this.elevenLabsStatus = 'connecting';

      const getAuthHeader = (): Record<string, string> => {
        const token = (typeof localStorage !== 'undefined')
          ? (localStorage.getItem('roger_token') || localStorage.getItem('tradesage_token'))
          : null;
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
      };

      const clientTools: Record<string, (params: any) => Promise<string>> = {
        get_emails: async (params?: any) => {
          try {
            const res = await fetch('http://localhost:8000/api/tools/get_emails', {
              headers: { ...getAuthHeader() }
            });
            const data = await res.json();
            if (callbacks.onToolExecuted) callbacks.onToolExecuted('emails');
            return data.spoken_summary || `Sir, you have ${data.total_emails || 0} emails in your records.`;
          } catch (e: any) {
            console.error('get_emails client tool error:', e);
            return 'Sir, I could not connect to your email inbox at this moment.';
          }
        },

        get_leads: async (params?: any) => {
          try {
            const res = await fetch('http://localhost:8000/api/v1/leads', {
              headers: { ...getAuthHeader() }
            });
            const data = await res.json();
            const leads = data.leads || [];
            if (callbacks.onToolExecuted) callbacks.onToolExecuted('leads');
            if (leads.length === 0) {
              return 'You currently have no leads in your CRM, sir. You can import leads from Excel or add a new prospect anytime.';
            }
            const top = leads.slice(0, 3).map((l: any, i: number) => 
              `${i + 1}) ${l.name} from ${l.company_name || 'Enterprise'} (AI Score: ${l.ai_score || 85}/100, Interest: ${l.product_interest || 'B2B platform'})`
            ).join('. ');
            return `Sir, you have ${leads.length} active leads in your CRM. Your top prospects: ${top}.`;
          } catch (e: any) {
            console.error('get_leads client tool error:', e);
            return 'Sir, I was unable to retrieve your CRM leads.';
          }
        },

        get_appointments: async (params?: any) => {
          try {
            const res = await fetch('http://localhost:8000/api/appointments', {
              headers: { ...getAuthHeader() }
            });
            const data = await res.json();
            const apps = data.appointments || [];
            if (callbacks.onToolExecuted) callbacks.onToolExecuted('appointments');
            if (apps.length === 0) {
              return 'You have no appointments or demonstrations scheduled on your calendar at this time, sir.';
            }
            const details = apps.slice(0, 3).map((a: any) => `${a.customer_name} for ${a.service} on ${a.date} at ${a.time}`).join('; ');
            return `Sir, you have ${apps.length} upcoming appointments: ${details}.`;
          } catch (e: any) {
            console.error('get_appointments client tool error:', e);
            return 'Sir, I was unable to access your appointments calendar.';
          }
        },

        sync_mailbox: async (params?: any) => {
          try {
            const res = await fetch('http://localhost:8000/api/mail/sync', {
              method: 'POST',
              headers: { ...getAuthHeader() }
            });
            const data = await res.json();
            if (callbacks.onToolExecuted) callbacks.onToolExecuted('emails');
            if (data.success) {
              return `Sir, I have synchronized your mailbox. ${data.fetchedCount > 0 ? `Fetched ${data.fetchedCount} new emails.` : 'All emails are up to date with no new unread messages.'}`;
            }
            return `Mailbox sync reported: ${data.error || 'Please verify your IMAP credentials in Mail Auth Settings.'}`;
          } catch (e: any) {
            return `Could not synchronize mailbox: ${e.message}`;
          }
        },

        get_digital_products: async (params?: any) => {
          try {
            const res = await fetch('http://localhost:8000/api/products', {
              headers: { ...getAuthHeader() }
            });
            const data = await res.json();
            const prods = data.products || [];
            if (callbacks.onToolExecuted) callbacks.onToolExecuted('products');
            if (prods.length === 0) {
              return 'You currently have no products saved in your Digital Products Hub, sir.';
            }
            const summaries = prods.map((p: any) => `${p.name}: ${p.tagline || p.description || ''}`).join('. ');
            return `Sir, you have ${prods.length} registered digital products: ${summaries}.`;
          } catch (e: any) {
            return 'Could not retrieve digital products.';
          }
        },

        draft_email: async (params: { recipient_name: string; recipient_email?: string; topic?: string }) => {
          try {
            const res = await fetch('http://localhost:8000/api/drafts/generate', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getAuthHeader()
              },
              body: JSON.stringify({
                recipientName: params.recipient_name,
                recipientEmail: params.recipient_email || `${params.recipient_name.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.com`,
                goal: params.topic || 'ThriveWoo B2B Platform Demonstration',
                tone: 'Professional'
              })
            });
            const data = await res.json();
            if (callbacks.onToolExecuted) callbacks.onToolExecuted('drafts');
            if (data.success && data.draft) {
              return `Sir, I have drafted the email to ${data.draft.recipient_name} regarding "${data.draft.subject}". It is saved in your Mail Drafts tab ready for your approval and one-click dispatch.`;
            }
            return `Email draft created for ${params.recipient_name}.`;
          } catch (e: any) {
            return `Could not generate email draft: ${e.message}`;
          }
        },

        launch_app: async (params: { app_name: string }) => {
          try {
            const res = await fetch('http://localhost:8000/api/tools/launch_app', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
              body: JSON.stringify({ app_name: params.app_name })
            });
            const data = await res.json();
            return data.message || `Launched ${params.app_name} for you, sir.`;
          } catch (e: any) {
            return `Could not launch ${params.app_name}: ${e.message}`;
          }
        },

        system_control: async (params: { action: string }) => {
          try {
            const res = await fetch('http://localhost:8000/api/tools/system_control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
              body: JSON.stringify({ action: params.action })
            });
            const data = await res.json();
            return data.message || `System action ${params.action} completed.`;
          } catch (e: any) {
            return `Could not execute system control: ${e.message}`;
          }
        },

        get_system_stats: async (params?: any) => {
          try {
            const res = await fetch('http://localhost:8000/api/tools/system_stats', {
              headers: { ...getAuthHeader() }
            });
            const data = await res.json();
            return `System statistics: CPU usage is at ${data.cpu_usage || '15%'}, RAM utilization is at ${data.ram_usage || '45%'}, and battery is ${data.battery || 'normal'}.`;
          } catch (e: any) {
            return 'System statistics currently unavailable.';
          }
        },

        open_website: async (params: { query_or_url: string }) => {
          try {
            const target = params.query_or_url;
            if (typeof window !== 'undefined' && target) {
              const url = target.startsWith('http') ? target : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
              window.open(url, '_blank');
            }
            return `Opened ${params.query_or_url} in your browser, sir.`;
          } catch (e: any) {
            return `Could not open ${params.query_or_url}: ${e.message}`;
          }
        }
      };

      this.elevenConversation = await Conversation.startSession({
        signedUrl,
        clientTools,
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
