/**
 * Provider-independent AI media generation (images, videos, voice-over).
 *
 * Every provider has the same shape, so the Content Studio never names a provider:
 *   { key, kind, label, model(), configured(), capabilities, generate(input) | start(input) + poll(jobId) }
 * Providers are enabled by their API keys on the server (never sent to the browser). Which one is
 * used: AI_IMAGE_PROVIDER / AI_VIDEO_PROVIDER / AI_VOICE_PROVIDER, else the first configured one.
 *
 * Credits are Marketech.ai's own usage units (AI_CREDITS_*); provider prices are not hardcoded:
 * an estimated USD cost is shown only when AI_COST_* is set for that provider.
 * Tests replace providers with setProviderForTests: they never reach a real provider.
 */
const TIMEOUT_MS = () => Number(process.env.AI_MEDIA_TIMEOUT_MS || 120000);

function providerError(message, { code = 'PROVIDER_ERROR', status = 502, retryable = false } = {}) {
  return Object.assign(new Error(message), { code, status, expose: true, retryable });
}

async function call(url, { method = 'POST', headers = {}, body, timeoutMs = TIMEOUT_MS(), binary = false, label }) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw providerError(timeout ? `${label} did not answer in time. Try again.` : `${label} could not be reached. Try again later.`, { code: timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.detail?.message || j.detail || j.message || text; } catch { /* plain text */ }
    msg = String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw providerError(`${label} refused the API key: ${msg}`, { code: 'PROVIDER_AUTH', status: 502 });
    if (res.status === 429) throw providerError(`${label} is busy or the account limit was reached: ${msg}`, { code: 'PROVIDER_RATE_LIMIT', status: 429, retryable: true });
    if (res.status === 400 || res.status === 422) throw providerError(`${label} could not use this request: ${msg}`, { code: 'PROVIDER_REJECTED', status: 400 });
    throw providerError(`${label} failed (HTTP ${res.status}): ${msg}`, { retryable: res.status >= 500 });
  }
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** A provider file URL (provider CDN) downloaded through the SSRF-safe fetcher. */
async function download(url, label) {
  try {
    const r = await require('./safeFetch').safeFetchBuffer(url, { timeoutMs: TIMEOUT_MS(), maxBytes: 600 * 1024 * 1024 });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return r.buffer;
  } catch (err) {
    throw providerError(`${label} finished, but the file could not be downloaded (${err.message}).`, { code: 'PROVIDER_DOWNLOAD', retryable: true });
  }
}

const ASPECTS = ['1:1', '4:5', '9:16', '16:9', '4:3', '3:4'];

// ------------------------------------------------------------------ images

const openaiImage = {
  key: 'openai', kind: 'image', label: 'OpenAI Images',
  model: () => process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  configured: () => !!process.env.OPENAI_API_KEY,
  // gpt-image models take reference images (product photos, logo, style) through the edits endpoint.
  get capabilities() { return { maxVariations: 4, aspects: ['1:1', '4:5', '9:16', '16:9', '4:3', '3:4'], referenceImages: !this.model().startsWith('dall-e'), maxReferenceImages: 4, textInImage: true }; },
  async generate({ prompt, aspect = '1:1', variations = 1, references = [] }) {
    const size = ['16:9', '4:3'].includes(aspect) ? '1536x1024' : ['9:16', '4:5', '3:4'].includes(aspect) ? '1024x1536' : '1024x1024';
    const model = this.model();
    if (references.length) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', String(Math.min(4, variations)));
      form.append('size', size);
      for (const [i, r] of references.slice(0, 4).entries()) form.append('image[]', new Blob([r.buffer], { type: r.mime }), `reference-${i + 1}.${r.mime.split('/')[1] || 'png'}`);
      const d = await call('https://api.openai.com/v1/images/edits', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, label: this.label });
      const images = (d.data || []).filter(x => x.b64_json).map(x => Buffer.from(x.b64_json, 'base64'));
      if (!images.length) throw providerError(`${this.label} returned no image.`, { retryable: true });
      return { images, model, requestId: d.created ? String(d.created) : null };
    }
    const body = { model, prompt, n: Math.min(4, variations), size, ...(model.startsWith('dall-e') ? { response_format: 'b64_json' } : {}) };
    const d = await call('https://api.openai.com/v1/images/generations', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), label: this.label
    });
    const images = [];
    for (const x of d.data || []) {
      if (x.b64_json) images.push(Buffer.from(x.b64_json, 'base64'));
      else if (x.url) images.push(await download(x.url, this.label));
    }
    if (!images.length) throw providerError(`${this.label} returned no image.`, { retryable: true });
    return { images, model, requestId: d.created ? String(d.created) : null };
  }
};

const falFlux = {
  key: 'flux', kind: 'image', label: 'FLUX (fal.ai)',
  model: () => process.env.FAL_FLUX_MODEL || 'fal-ai/flux/schnell',
  configured: () => !!process.env.FAL_KEY,
  capabilities: { maxVariations: 4, aspects: ['1:1', '9:16', '16:9', '4:3', '3:4'], referenceImages: false, textInImage: false },
  async generate({ prompt, aspect = '1:1', variations = 1 }) {
    const image_size = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3', '4:5': 'portrait_4_3' }[aspect] || 'square_hd';
    const model = this.model();
    const d = await call(`https://fal.run/${model}`, {
      headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_size, num_images: Math.min(4, variations) }), label: this.label
    });
    const images = [];
    for (const x of d.images || []) if (x.url) images.push(await download(x.url, this.label));
    if (!images.length) throw providerError(`${this.label} returned no image.`, { retryable: true });
    return { images, model, requestId: d.request_id || null };
  }
};

// ------------------------------------------------------------------ video (asynchronous)

const RUNWAY_BASE = 'https://api.dev.runwayml.com';
const runway = {
  key: 'runway', kind: 'video', label: 'Runway',
  model: () => process.env.RUNWAY_VIDEO_MODEL || 'gen4_turbo',
  configured: () => !!process.env.RUNWAY_API_KEY,
  // Runway's gen4 models animate a starting image: text-to-video runs as poster image -> video.
  capabilities: { textToVideo: false, imageToVideo: true, durations: [5, 10], aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'], audio: false },
  headers() { return { Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' }; },
  async start({ prompt, imageDataUri, aspect = '16:9', durationSeconds = 5 }) {
    if (!imageDataUri) throw providerError('Runway needs a starting image for the video.', { code: 'CAPABILITY', status: 400 });
    const ratio = { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960', '4:3': '1104:832', '3:4': '832:1104' }[aspect] || '1280:720';
    const d = await call(`${RUNWAY_BASE}/v1/image_to_video`, {
      headers: this.headers(), label: this.label,
      body: JSON.stringify({ model: this.model(), promptImage: imageDataUri, promptText: String(prompt || '').slice(0, 1000), ratio, duration: durationSeconds >= 10 ? 10 : 5 })
    });
    if (!d.id) throw providerError('Runway did not return a job id.', { retryable: true });
    return { jobId: d.id, model: this.model() };
  },
  async poll(jobId) {
    const d = await call(`${RUNWAY_BASE}/v1/tasks/${encodeURIComponent(jobId)}`, { method: 'GET', headers: this.headers(), label: this.label });
    if (d.status === 'SUCCEEDED') return { status: 'completed', video: await download((d.output || [])[0], this.label) };
    if (d.status === 'FAILED' || d.status === 'CANCELLED') return { status: 'failed', error: d.failure || d.failureCode || 'Runway could not create the video.' };
    return { status: 'processing', progress: typeof d.progress === 'number' ? d.progress : null };
  }
};

// ------------------------------------------------------------------ voice

const elevenlabs = {
  key: 'elevenlabs', kind: 'voice', label: 'ElevenLabs',
  model: () => process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
  configured: () => !!process.env.ELEVENLABS_API_KEY,
  capabilities: { maxChars: 5000 },
  async generate({ text, voiceId }) {
    const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8EZOHo';
    const audio = await call(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: String(text).slice(0, 5000), model_id: this.model() }), binary: true, label: this.label
    });
    return { audio, model: this.model() };
  }
};

// ------------------------------------------------------------------ registry

const PROVIDERS = { image: [openaiImage, falFlux], video: [runway], voice: [elevenlabs] };
const overrides = {};
/** Tests: replace the provider of a kind (null restores the real ones). */
function setProviderForTests(kind, provider) { overrides[kind] = provider; }

const ENV_PICK = { image: 'AI_IMAGE_PROVIDER', video: 'AI_VIDEO_PROVIDER', voice: 'AI_VOICE_PROVIDER' };
/** The provider used for a kind, or null when none is configured. */
function providerFor(kind) {
  if (overrides[kind]) return overrides[kind];
  const list = PROVIDERS[kind] || [];
  const wanted = process.env[ENV_PICK[kind]];
  return list.find(p => p.key === wanted && p.configured()) || list.find(p => p.configured()) || null;
}

/** What can be generated here (shown in the Studio; no keys). */
function capabilities() {
  const out = {};
  for (const kind of Object.keys(PROVIDERS)) {
    const p = providerFor(kind);
    out[kind] = p ? { available: true, provider: p.key, label: p.label, model: p.model(), ...p.capabilities }
      : { available: false, reason: { image: 'Add OPENAI_API_KEY or FAL_KEY on the server to generate images.', video: 'Add RUNWAY_API_KEY on the server to generate videos.', voice: 'Add ELEVENLABS_API_KEY on the server for AI voice-over.' }[kind] };
  }
  out.videoEditing = require('./videoTools').available()
    ? { available: true } : { available: false, reason: 'Install FFmpeg on the server (or set FFMPEG_PATH) to trim videos, add subtitles and voice-over.' };
  return out;
}

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
/**
 * Credits and (when configured) estimated USD for one generation. Credits are internal units:
 * AI_CREDITS_TEXT (1), AI_CREDITS_IMAGE (per image, 5), AI_CREDITS_VIDEO_SECOND (10), AI_CREDITS_VOICE (2).
 * USD only from AI_COST_<KIND>_<PROVIDER>_USD (per text request / image / video second / voice request).
 */
function estimate(kind, { provider = null, variations = 1, durationSeconds = 5, slides = 0 } = {}) {
  const e = process.env;
  let credits; let units;
  if (kind === 'text' || kind === 'plan') { credits = num(e.AI_CREDITS_TEXT, 1); units = 1; }
  else if (kind === 'image') { units = Math.max(1, variations); credits = num(e.AI_CREDITS_IMAGE, 5) * units; }
  else if (kind === 'carousel') { units = Math.max(0, slides); credits = num(e.AI_CREDITS_TEXT, 1) + num(e.AI_CREDITS_IMAGE, 5) * units; }
  else if (kind === 'video') { units = Math.max(1, durationSeconds); credits = num(e.AI_CREDITS_VIDEO_SECOND, 10) * units; }
  else if (kind === 'voice') { units = 1; credits = num(e.AI_CREDITS_VOICE, 2); }
  else { credits = 1; units = 1; }
  const priceKey = provider ? `AI_COST_${kind.toUpperCase()}_${provider.toUpperCase()}_USD` : null;
  const unitPrice = priceKey && e[priceKey] !== undefined && e[priceKey] !== '' ? Number(e[priceKey]) : null;
  return { credits, costUsd: Number.isFinite(unitPrice) ? Math.round(unitPrice * units * 10000) / 10000 : null };
}

module.exports = { providerFor, capabilities, estimate, setProviderForTests, providerError, ASPECTS, PROVIDERS };
