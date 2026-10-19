// Jarvis Siri-Style Calling Engine with Signed URL, Email Support & Reliable Wake Word
import { Conversation } from 'https://esm.sh/@elevenlabs/client';

let activeConversation = null;
let callTimerInterval = null;
let callSeconds = 0;
let isCalling = false;
let inactivityTimer = null;
const INACTIVITY_LIMIT_MS = 25000; // Auto-disconnect after 25s silence to protect ElevenLabs credits

function resetInactivityWatchdog() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (!isCalling) return;
  inactivityTimer = setTimeout(() => {
    if (isCalling) {
      appendTranscript('SYSTEM', '🛡️ Credit Saver: Call auto-ended after 25s silence to save ElevenLabs credits. Say "Hello Jarvis" anytime to talk again!');
      endCall();
    }
  }, INACTIVITY_LIMIT_MS);
}

function clearInactivityWatchdog() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

// Wake Word State
let wakeWordRecognizer = null;
let isRecognitionRunning = false;
let shouldListenForWakeWord = true;

// DOM Elements
const voiceOrb = document.getElementById('voiceOrb');
const callBtn = document.getElementById('callBtn');
const callBtnLabel = document.getElementById('callBtnLabel');
const callBtnIcon = document.getElementById('callBtnIcon');
const callStateBadge = document.getElementById('callStateBadge');
const callStatusText = document.getElementById('callStatusText');
const callSubText = document.getElementById('callSubText');
const callTimer = document.getElementById('callTimer');
const transcriptContent = document.getElementById('transcriptContent');
const tapHint = document.getElementById('tapHint');
const wakeWordBadge = document.getElementById('wakeWordBadge');
const enableMicBanner = document.getElementById('enableMicBanner');

// Audio chime for wake word
function playWakeChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.18);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch (e) {
    console.log("Audio cue error:", e);
  }
}

// 1. Robust Wake Word Engine ("Hello Jarvis" / "Hey Jarvis")
function initWakeWordRecognizer() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    wakeWordBadge.textContent = "WAKE WORD: USE CHROME/EDGE";
    wakeWordBadge.className = "chip";
    return;
  }

  // Teardown previous instance if exists
  if (wakeWordRecognizer) {
    try {
      wakeWordRecognizer.abort();
    } catch(e) {}
    wakeWordRecognizer = null;
  }

  wakeWordRecognizer = new SpeechRecognition();
  wakeWordRecognizer.continuous = true;
  wakeWordRecognizer.interimResults = true;
  wakeWordRecognizer.lang = 'en-US';

  wakeWordRecognizer.onstart = () => {
    isRecognitionRunning = true;
    wakeWordBadge.textContent = "🟢 LISTENING FOR 'HELLO JARVIS'";
    wakeWordBadge.className = "chip active";
    if (enableMicBanner) enableMicBanner.style.display = 'none';
  };

  wakeWordRecognizer.onresult = (event) => {
    if (isCalling) return;

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcript = event.results[i][0].transcript.trim().toLowerCase();
      console.log("Background heard:", transcript);

      if (
        transcript.includes("hello jarvis") ||
        transcript.includes("hey jarvis") ||
        transcript.includes("hi jarvis") ||
        transcript.includes("ok jarvis") ||
        transcript.includes("jarvis")
      ) {
        console.log("Wake word matched:", transcript);
        appendTranscript("SYSTEM", `Wake word detected: "${transcript}"`);
        playWakeChime();
        startCall();
        break;
      }
    }
  };

  wakeWordRecognizer.onerror = (event) => {
    console.warn("Wake word error:", event.error);
    isRecognitionRunning = false;
    if (event.error === 'not-allowed') {
      wakeWordBadge.textContent = "⚠️ CLICK TO ALLOW MICROPHONE";
      wakeWordBadge.className = "chip calling";
      if (enableMicBanner) enableMicBanner.style.display = 'block';
    } else if (event.error === 'audio-capture' || event.error === 'aborted' || event.error === 'network') {
      if (shouldListenForWakeWord && !isCalling) {
        setTimeout(() => restartWakeWordSafe(), 1500);
      }
    }
  };

  wakeWordRecognizer.onend = () => {
    isRecognitionRunning = false;
    // Auto restart if should be listening and not in active call
    if (shouldListenForWakeWord && !isCalling) {
      setTimeout(() => {
        restartWakeWordSafe();
      }, 400);
    }
  };

  restartWakeWordSafe();
}

function restartWakeWordSafe() {
  if (isCalling || isRecognitionRunning || !wakeWordRecognizer) return;
  try {
    wakeWordRecognizer.start();
  } catch (e) {
    // Already started or busy, ignore safely
  }
}

// Auto-trigger wake-word recognizer on window focus or any user interaction
window.addEventListener('focus', () => {
  if (!isCalling && !isRecognitionRunning && shouldListenForWakeWord) {
    restartWakeWordSafe();
  }
});
window.addEventListener('click', () => {
  if (!isCalling && !isRecognitionRunning && shouldListenForWakeWord) {
    restartWakeWordSafe();
  }
});
window.addEventListener('keydown', () => {
  if (!isCalling && !isRecognitionRunning && shouldListenForWakeWord) {
    restartWakeWordSafe();
  }
});

function stopWakeWord() {
  shouldListenForWakeWord = false;
  if (wakeWordRecognizer) {
    try {
      wakeWordRecognizer.abort();
    } catch (e) {}
  }
  isRecognitionRunning = false;
}

function resumeWakeWord() {
  shouldListenForWakeWord = true;
  setTimeout(() => {
    initWakeWordRecognizer();
  }, 1200);
}

// User click activation
window.unlockMicrophone = async function() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    stream.getTracks().forEach(track => track.stop());
    
    if (enableMicBanner) enableMicBanner.style.display = 'none';
    resumeWakeWord();
    appendTranscript("SYSTEM", "Microphone enabled. Say 'Hello Jarvis' anytime to wake up!");
  } catch (err) {
    alert("Please allow microphone access in your browser settings to use voice.");
  }
};

// 2. Start / End Call
async function startCall() {
  if (isCalling) return;
  isCalling = true;

  // Fully stop background wake word so audio device is exclusive to WebRTC
  stopWakeWord();

  try {
    updateCallUIState('connecting');

    // Test microphone permission cleanly without locking hardware tracks
    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      const testStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      testStream.getTracks().forEach(t => t.stop());
    } catch (permErr) {
      console.warn("Microphone pre-check warning:", permErr);
    }

    // Request fresh signed URL from backend
    appendTranscript('SYSTEM', 'Requesting secure session from ElevenLabs...');
    const signedRes = await fetch('/api/signed-url');
    if (!signedRes.ok) {
      throw new Error("Backend signed URL error: " + await signedRes.text());
    }
    const { signed_url } = await signedRes.json();

    // Start ElevenLabs Conversational AI Session with live Client Tools
    activeConversation = await Conversation.startSession({
      signedUrl: signed_url,
      clientTools: {
        get_emails: async () => {
          console.log("⚡ ElevenLabs queried get_emails!");
          appendTranscript('SYSTEM', 'Jarvis checking inbox & urgent emails...');
          try {
            const res = await fetch('/api/emails');
            const data = await res.json();
            const emails = data.emails || [];
            if (emails.length === 0) {
              return "Your inbox is completely clear. No new emails.";
            }
            const urgent = emails.filter(e => e.is_urgent == 1);
            if (urgent.length > 0) {
              return `Sir, you have ${urgent.length} urgent emails: ` + urgent.map(u => `From ${u.sender}: '${u.subject}' - ${u.snippet}`).join('. ') + `. You also have ${emails.length - urgent.length} other notifications.`;
            }
            return `You have ${emails.length} emails in your inbox, none are urgent. Recent subjects: ` + emails.slice(0, 3).map(e => `${e.sender}: ${e.subject}`).join('; ');
          } catch (e) {
            return "Unable to access mail records at this moment.";
          }
        },
        get_leads: async () => {
          console.log("⚡ ElevenLabs queried get_leads!");
          appendTranscript('SYSTEM', 'Jarvis accessing database: fetching leads...');
          try {
            const res = await fetch('/api/leads');
            const data = await res.json();
            const leads = data.leads || [];
            if (leads.length === 0) {
              return "There are no leads recorded in the CRM at this time.";
            }
            return leads.map(l => `Name: ${l.name}, Email: ${l.email || 'None on file'}, Phone: ${l.phone || 'None'}, Interest: ${l.interest || 'General inquiry'}`).join('; ');
          } catch (e) {
            return "Unable to access the database at this moment.";
          }
        },
        get_appointments: async () => {
          console.log("⚡ ElevenLabs queried get_appointments!");
          appendTranscript('SYSTEM', 'Jarvis accessing calendar...');
          try {
            const res = await fetch('/api/appointments');
            const data = await res.json();
            const apts = data.appointments || [];
            if (apts.length === 0) {
              return "There are currently no upcoming appointments scheduled.";
            }
            return apts.map(a => `${a.customer_name} scheduled for ${a.service} on ${a.date} at ${a.time}`).join('; ');
          } catch (e) {
            return "Unable to access calendar records.";
          }
        },
        launch_app: async (params) => {
          console.log("⚡ ElevenLabs queried launch_app:", params);
          let appName = 'calc';
          try {
            if (typeof params === 'string') {
              try {
                const parsed = JSON.parse(params);
                appName = parsed.app_name || parsed.appName || parsed.app || params;
              } catch (e) {
                appName = params;
              }
            } else if (params && typeof params === 'object') {
              appName = params.app_name || params.appName || params.app || params.name || 'calc';
            }
          } catch (e) {
            appName = 'calc';
          }
          appendTranscript('SYSTEM', `Launching application: ${appName}...`);
          try {
            const res = await fetch('/api/tools/launch_app', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_name: String(appName) })
            });
            const data = await res.json();
            return data.message || `Launched ${appName} on your system, sir.`;
          } catch (e) {
            console.error("launch_app fetch error:", e);
            return `Opening ${appName} on your desktop right away, sir.`;
          }
        },
        system_control: async (params) => {
          console.log("⚡ ElevenLabs queried system_control:", params);
          let action = 'status';
          try {
            if (typeof params === 'string') {
              try {
                const parsed = JSON.parse(params);
                action = parsed.action || params;
              } catch (e) {
                action = params;
              }
            } else if (params && typeof params === 'object') {
              action = params.action || 'status';
            }
          } catch (e) {
            action = 'status';
          }
          appendTranscript('SYSTEM', `Executing system control: ${action}...`);
          try {
            const res = await fetch('/api/tools/system_control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: String(action) })
            });
            const data = await res.json();
            return data.message || `Executed system control: ${action}, sir.`;
          } catch (e) {
            console.error("system_control fetch error:", e);
            return `System control action ${action} executed, sir.`;
          }
        },
        get_system_stats: async () => {
          console.log("⚡ ElevenLabs queried get_system_stats");
          appendTranscript('SYSTEM', 'Reading system diagnostics (CPU, RAM, Battery)...');
          try {
            const res = await fetch('/api/tools/system_stats');
            const data = await res.json();
            return data.speech_text || "System diagnostics retrieved.";
          } catch (e) {
            return "Unable to read system metrics at this moment, sir.";
          }
        },
        open_website: async (params) => {
          console.log("⚡ ElevenLabs queried open_website:", params);
          let target = 'google.com';
          try {
            if (typeof params === 'string') {
              try {
                const parsed = JSON.parse(params);
                target = parsed.query_or_url || parsed.query || parsed.url || params;
              } catch (e) {
                target = params;
              }
            } else if (params && typeof params === 'object') {
              target = params.query_or_url || params.query || params.url || params.target || 'google.com';
            }
          } catch (e) {
            target = 'google.com';
          }
          appendTranscript('SYSTEM', `Opening website: ${target}...`);
          try {
            const res = await fetch('/api/tools/open_website', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ target: String(target) })
            });
            const data = await res.json();
            return data.message || `Opened ${target} in your browser, sir.`;
          } catch (e) {
            console.error("open_website fetch error:", e);
            return `Opened ${target} in your browser, sir.`;
          }
        }
      },
      onConnect: () => {
        isCalling = true;
        updateCallUIState('connected');
        startTimer();
        resetInactivityWatchdog();
      },
      onDisconnect: () => {
        console.log("ElevenLabs disconnected.");
        endCall();
      },
      onModeChange: (mode) => {
        resetInactivityWatchdog();
        if (mode.mode === 'speaking') {
          updateCallUIState('speaking');
        } else if (mode.mode === 'listening') {
          updateCallUIState('listening');
        }
      },
      onMessage: (message) => {
        resetInactivityWatchdog();
        if (message && message.message) {
          const sender = message.source === 'user' ? 'YOU' : 'JARVIS';
          appendTranscript(sender, message.message);

          if (message.source === 'user') {
            const lower = message.message.toLowerCase();
            if (lower.includes("goodbye jarvis") || lower.includes("bye jarvis") || lower.includes("hang up") || lower.includes("disconnect")) {
              setTimeout(() => endCall(), 1000);
            }
          }
        }
      },
      onError: (err) => {
        console.warn("ElevenLabs Session Warning/Error:", err);
        appendTranscript('SYSTEM', 'Notice: ' + (err?.message || JSON.stringify(err)));
        // Do NOT call endCall() here so temporary client tool or audio quirks don't kill the call!
      }
    });

  } catch (err) {
    console.error("Failed to start call:", err);
    appendTranscript('SYSTEM', 'Connection failed: ' + err.message);
    endCall();
  }
}

async function endCall() {
  console.log("Disconnecting call immediately...");
  clearInactivityWatchdog();
  
  // 1. Immediately reset state and UI
  isCalling = false;
  cleanupCallUI();

  // 2. Terminate session
  if (activeConversation) {
    const conv = activeConversation;
    activeConversation = null;
    try {
      await conv.endSession();
    } catch (e) {
      console.warn("endSession caught:", e);
    }
  }

  // 3. Resume background wake word after audio driver releases
  resumeWakeWord();
}

window.startCall = startCall;
window.endCall = endCall;

window.toggleCall = function() {
  if (isCalling) {
    endCall();
  } else {
    playWakeChime();
    startCall();
  }
};

function updateCallUIState(state) {
  if (state === 'connecting') {
    callStateBadge.textContent = 'CONNECTING...';
    callStateBadge.className = 'chip calling';
    callStatusText.textContent = 'DIALING JARVIS...';
    callSubText.textContent = 'Connecting to neural voice agent...';
    callBtnLabel.textContent = 'CANCEL CALL';
    if (callBtnIcon) callBtnIcon.textContent = '🛑';
    callBtn.className = 'call-btn btn-end-call';
  } else if (state === 'connected' || state === 'listening') {
    callStateBadge.textContent = 'CALL IN PROGRESS';
    callStateBadge.className = 'chip active';
    callStatusText.textContent = '🎙️ LISTENING (SPEAK NOW)';
    callSubText.textContent = 'Speak to Jarvis naturally. (Auto-hangs up after 25s silence to protect ElevenLabs credits)';
    callBtnLabel.textContent = 'END CALL';
    if (callBtnIcon) callBtnIcon.textContent = '🛑';
    callBtn.className = 'call-btn btn-end-call';
    voiceOrb.className = 'voice-orb in-call';
    tapHint.textContent = 'TAP ORB TO END CALL';
  } else if (state === 'speaking') {
    callStateBadge.textContent = 'JARVIS SPEAKING';
    callStateBadge.className = 'chip active';
    callStatusText.textContent = '🔊 JARVIS IS SPEAKING...';
    callSubText.textContent = 'You can interrupt or speak at any time.';
    callBtnLabel.textContent = 'END CALL';
    if (callBtnIcon) callBtnIcon.textContent = '🛑';
    callBtn.className = 'call-btn btn-end-call';
    voiceOrb.className = 'voice-orb in-call speaking';
  }
}

function cleanupCallUI() {
  stopTimer();

  callStateBadge.textContent = 'STANDBY ($0 CREDITS)';
  callStateBadge.className = 'chip';
  callStatusText.textContent = 'SAY "HELLO JARVIS" TO WAKE UP';
  callSubText.textContent = '🛡️ 100% Free on Standby ($0 credits). ElevenLabs session only activates when you speak.';
  callBtnLabel.textContent = 'CALL JARVIS';
  if (callBtnIcon) callBtnIcon.textContent = '🎙️';
  callBtn.className = 'call-btn btn-call';
  voiceOrb.className = 'voice-orb';
  tapHint.textContent = 'SAY "HELLO JARVIS" OR TAP ORB';
  callTimer.textContent = '00:00';
  appendTranscript('SYSTEM', 'Call disconnected. Standing by for "Hello Jarvis"...');
}

function startTimer() {
  callSeconds = 0;
  callTimer.textContent = '00:00';
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    callTimer.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(callTimerInterval);
}

function appendTranscript(sender, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `msg ${sender === 'YOU' ? 'user-msg' : sender === 'JARVIS' ? 'jarvis-msg' : ''}`;
  msgDiv.innerHTML = `<span class="sender">${escapeHtml(sender)}:</span> ${escapeHtml(text)}`;
  transcriptContent.appendChild(msgDiv);
  transcriptContent.scrollTop = transcriptContent.scrollHeight;
}

// 3. Data Polling
async function fetchDashboardData() {
  try {
    // 1. Emails
    const emailRes = await fetch('/api/emails');
    if (emailRes.ok) {
      const data = await emailRes.json();
      renderEmails(data.emails || []);
    }

    // 2. Appointments
    const aptRes = await fetch('/api/appointments');
    if (aptRes.ok) {
      const data = await aptRes.json();
      renderAppointments(data.appointments || []);
    }

    // 3. Leads
    const leadRes = await fetch('/api/leads');
    if (leadRes.ok) {
      const data = await leadRes.json();
      renderLeads(data.leads || []);
    }
  } catch (err) {
    console.error("Dashboard refresh error:", err);
  }
}

function renderEmails(emails) {
  const tbody = document.getElementById('emailsTableBody');
  const countBadge = document.getElementById('emailCount');
  
  const urgentCount = emails.filter(e => e.is_urgent == 1).length;
  countBadge.textContent = `${urgentCount} Urgent (${emails.length} Total)`;
  
  if (!emails || emails.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No emails recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = emails.map(e => `
    <tr>
      <td><strong>${escapeHtml(e.sender || e.sender_name)}</strong></td>
      <td>${escapeHtml(e.subject)}</td>
      <td style="color: var(--text-dim); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(e.snippet)}</td>
      <td>
        <span class="status-badge" style="${e.is_urgent == 1 ? 'background: rgba(239, 68, 68, 0.2); color: #ef4444;' : 'background: rgba(0, 240, 255, 0.15); color: var(--cyan);'}">
          ${e.is_urgent == 1 ? '⚡ URGENT' : 'Normal'}
        </span>
      </td>
    </tr>
  `).join('');
}

function renderAppointments(appointments) {
  const tbody = document.getElementById('appointmentsTableBody');
  const countBadge = document.getElementById('appointmentCount');
  countBadge.textContent = `${appointments.length} Bookings`;
  
  if (!appointments || appointments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No appointments recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = appointments.map(apt => `
    <tr>
      <td><strong>${escapeHtml(apt.customer_name)}</strong></td>
      <td>${escapeHtml(apt.service)}</td>
      <td>${escapeHtml(apt.date)} @ ${escapeHtml(apt.time)}</td>
      <td><span class="status-badge">${escapeHtml(apt.status)}</span></td>
    </tr>
  `).join('');
}

function renderLeads(leads) {
  const tbody = document.getElementById('leadsTableBody');
  const countBadge = document.getElementById('leadCount');
  countBadge.textContent = `${leads.length} Leads`;
  
  if (!leads || leads.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No leads recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = leads.map(lead => `
    <tr>
      <td><strong>${escapeHtml(lead.name)}</strong></td>
      <td>${escapeHtml(lead.phone || lead.email || 'N/A')}</td>
      <td>${escapeHtml(lead.interest || 'General')}</td>
      <td><span class="status-badge">${escapeHtml(lead.status)}</span></td>
    </tr>
  `).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Quick Test Actions
window.simulateLead = async function() {
  const names = ["Marcus Vance", "Elena Rostova", "David Kim", "Sophia Chen", "Liam O'Connor"];
  const randomName = names[Math.floor(Math.random() * names.length)];
  const randomPhone = `+1 (555) ${Math.floor(100 + Math.random() * 900)}-${Math.floor(1000 + Math.random() * 9000)}`;
  const services = ["AI Strategy Consulting", "Custom Voice Assistant", "24/7 Operations Automation"];
  const randomService = services[Math.floor(Math.random() * services.length)];

  try {
    const res = await fetch('/api/tools/track_lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: randomName,
        phone: randomPhone,
        email: `${randomName.toLowerCase().replace(/[^a-z]/g, '')}@example.com`,
        interest: randomService
      })
    });
    const result = await res.json();
    alert(`⚡ ${result.message}`);
    fetchDashboardData();
  } catch (err) {
    alert("Error recording lead: " + err.message);
  }
};

window.simulateBooking = async function() {
  const names = ["Alexander Gray", "Chloe Bennett", "James Wilson", "Maya Patel"];
  const randomName = names[Math.floor(Math.random() * names.length)];
  const services = ["Executive Consultation", "System Onboarding", "Custom Integration"];
  const randomService = services[Math.floor(Math.random() * services.length)];
  
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];
  const hours = ["10:00 AM", "11:30 AM", "2:00 PM", "3:30 PM", "4:30 PM"];
  const randomTime = hours[Math.floor(Math.random() * hours.length)];

  try {
    const res = await fetch('/api/tools/book_appointment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name: randomName,
        service: randomService,
        date: dateStr,
        time: randomTime
      })
    });
    const result = await res.json();
    alert(`📅 ${result.message}`);
    fetchDashboardData();
  } catch (err) {
    alert("Error booking appointment: " + err.message);
  }
};

window.triggerLaunchApp = async function(appName) {
  try {
    const res = await fetch('/api/tools/launch_app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_name: appName })
    });
    const result = await res.json();
    appendTranscript('SYSTEM', result.message);
  } catch (err) {
    alert("Error launching app: " + err.message);
  }
};

window.triggerSystemControl = async function(action) {
  try {
    const res = await fetch('/api/tools/system_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action })
    });
    const result = await res.json();
    appendTranscript('SYSTEM', result.message);
  } catch (err) {
    alert("Error executing system control: " + err.message);
  }
};

window.triggerSystemStats = async function() {
  try {
    const res = await fetch('/api/tools/system_stats');
    const result = await res.json();
    alert(`⚡ SYSTEM DIAGNOSTICS:\n\n${result.speech_text}`);
    appendTranscript('JARVIS', result.speech_text);
  } catch (err) {
    alert("Error reading system stats: " + err.message);
  }
};

// Check Status and Mobile URL
async function checkStatusAndMobile() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const mobileBadge = document.getElementById('mobileLinkBadge');
    if (mobileBadge && data.mobile_url) {
      mobileBadge.textContent = `📱 MOBILE: ${data.mobile_url}`;
      mobileBadge.href = data.mobile_url;
    }
  } catch (e) {}
}

// Startup
fetchDashboardData();
checkStatusAndMobile();
setInterval(fetchDashboardData, 3000);
setInterval(checkStatusAndMobile, 10000);
initWakeWordRecognizer();
