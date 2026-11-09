const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/**
 * Video editing with FFmpeg (trim, burned-in subtitles, voice-over / background music, intro and
 * outro title cards). Only when FFmpeg is installed: FFMPEG_PATH, else `ffmpeg` on the PATH.
 * Inputs and outputs are files in the server's media storage; arguments are passed as an array
 * (no shell), and user text only ever reaches FFmpeg inside a subtitles file.
 */
let cached = null;
function binary() { return process.env.FFMPEG_PATH || 'ffmpeg'; }
function available() {
  if (process.env.NODE_ENV === 'test' && process.env.FFMPEG_TEST_AVAILABLE !== '1') return false;
  if (cached !== null) return cached;
  try { cached = spawnSync(binary(), ['-version'], { timeout: 5000 }).status === 0; } catch { cached = false; }
  return cached;
}

let filterList = null;
/** Whether this FFmpeg can burn subtitles into the picture (needs libass). */
function canBurnSubtitles() {
  if (filterList === null) {
    try { filterList = String(spawnSync(binary(), ['-hide_banner', '-filters'], { timeout: 5000 }).stdout || ''); } catch { filterList = ''; }
  }
  return / subtitles /.test(filterList);
}

function run(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(binary(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('Video processing took too long.'), { code: 'FFMPEG_TIMEOUT', status: 504, expose: true })); }, timeoutMs);
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { clearTimeout(t); reject(Object.assign(new Error(`FFmpeg could not start: ${e.message}`), { code: 'FFMPEG_MISSING', status: 501, expose: true })); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`Video processing failed: ${err.trim().split('\n').pop() || `exit ${code}`}`), { code: 'FFMPEG_FAILED', status: 422, expose: true }));
    });
  });
}

const ts = s => {
  const ms = Math.max(0, Math.round(Number(s) * 1000));
  const h = Math.floor(ms / 3600000); const m = Math.floor(ms / 60000) % 60; const sec = Math.floor(ms / 1000) % 60; const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};
/** SubRip text from [{ start, end, text }] (seconds). */
function toSrt(cues) {
  return cues.filter(c => String(c.text || '').trim()).map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${String(c.text).replace(/\r/g, '').trim()}\n`).join('\n');
}

/** Subtitle cues spread evenly over a duration from a script (one sentence per cue). */
function cuesFromScript(script, durationSeconds) {
  const parts = String(script || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean).slice(0, 60);
  if (!parts.length || !durationSeconds) return [];
  const step = durationSeconds / parts.length;
  return parts.map((text, i) => ({ start: Math.round(i * step * 100) / 100, end: Math.round((i + 1) * step * 100) / 100, text: text.slice(0, 120) }));
}

/**
 * One editing pass (FFmpeg filter graph), written to `output` (MP4, H.264/AAC, 30 fps):
 *   main      { path, duration, hasAudio, width, height }  the library video being edited
 *   start/end trim of the main video (seconds)
 *   replace   { start, end, path } a scene (seconds within the trimmed video) replaced by another clip,
 *             stretched or cut to the same length; the original soundtrack continues underneath
 *   intro / outro { path, seconds }  an image card (poster, logo slide) before / after the video
 *   cues      [{ start, end, text }] subtitles, timed on the trimmed video
 *   voice     { path, mode: 'mix' | 'replace' }  voice-over (replace drops the original sound)
 *   music     { path, volume }  background music (looped to the length)
 */
async function compose({ output, main, start = null, end = null, replace = null, intro = null, outro = null, cues = [], voice = null, music = null }) {
  const even = n => Math.max(2, Math.round(Number(n || 0) / 2) * 2);
  const W = even(main.width || 1080); const H = even(main.height || 1920);
  const S = Math.max(0, Number(start) || 0);
  const E = Math.min(Number(end ?? main.duration) || main.duration, main.duration || Infinity);
  if (!(E > S)) throw Object.assign(new Error('The end must be after the start.'), { status: 400, code: 'VALIDATION_ERROR', expose: true });
  const mainDur = E - S;
  const introD = intro ? Number(intro.seconds) || 2 : 0;
  const outroD = outro ? Number(outro.seconds) || 2 : 0;
  const total = Math.round((introD + mainDur + outroD) * 1000) / 1000;
  const norm = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
  const args = []; const f = []; const vparts = []; let n = 0;
  const input = (...a) => { args.push(...a); return n++; };

  const m = input('-i', main.path);
  if (intro) { const i = input('-loop', '1', '-framerate', '30', '-t', String(introD), '-i', intro.path); f.push(`[${i}:v]${norm}[vin]`); vparts.push('[vin]'); }
  if (replace) {
    const rs = Math.max(0, Math.min(mainDur, Number(replace.start) || 0)); const re = Math.max(rs + 0.5, Math.min(mainDur, Number(replace.end) || mainDur));
    const c = input('-i', replace.path);
    f.push(`[${m}:v]trim=start=${S}:end=${S + rs},setpts=PTS-STARTPTS,${norm}[m1]`);
    f.push(`[${c}:v]tpad=stop_mode=clone:stop_duration=${re - rs},trim=duration=${re - rs},setpts=PTS-STARTPTS,${norm}[rc]`);
    f.push(`[${m}:v]trim=start=${S + re}:end=${E},setpts=PTS-STARTPTS,${norm}[m2]`);
    if (rs > 0.05) vparts.push('[m1]');
    vparts.push('[rc]');
    if (mainDur - re > 0.05) vparts.push('[m2]');
  } else {
    f.push(`[${m}:v]trim=start=${S}:end=${E},setpts=PTS-STARTPTS,${norm}[mv]`);
    vparts.push('[mv]');
  }
  if (outro) { const o = input('-loop', '1', '-framerate', '30', '-t', String(outroD), '-i', outro.path); f.push(`[${o}:v]${norm}[vout0]`); vparts.push('[vout0]'); }
  f.push(`${vparts.join('')}concat=n=${vparts.length}:v=1:a=0[vc]`);

  // Subtitles: burned into the picture when FFmpeg has libass; otherwise a subtitle track (players
  // show it; the .srt is also returned for platforms that take caption files, such as YouTube).
  let srt = null; let subtitlesMode = null; let srtInput = null;
  if (cues.length) {
    srt = path.join(path.dirname(output), `.subs-${process.pid}-${Date.now()}.srt`);
    await fs.promises.writeFile(srt, toSrt(cues.map(c => ({ ...c, start: c.start + introD, end: c.end + introD }))), { mode: 0o640 });
    if (canBurnSubtitles()) {
      const esc = srt.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      f.push(`[vc]subtitles=filename='${esc}':force_style='FontSize=18,Outline=2,MarginV=40'[v]`);
      subtitlesMode = 'burned';
    } else {
      f.push('[vc]null[v]');
      srtInput = input('-i', srt);
      subtitlesMode = 'track';
    }
  } else f.push('[vc]null[v]');

  // Sound: the original (if kept), the voice-over and the music, each placed after the intro card.
  const delay = Math.round(introD * 1000);
  const aparts = [];
  if (main.hasAudio && voice?.mode !== 'replace') { f.push(`[${m}:a]atrim=start=${S}:end=${E},asetpts=PTS-STARTPTS,adelay=delays=${delay}:all=1[a0]`); aparts.push('[a0]'); }
  if (voice) { const v = input('-i', voice.path); f.push(`[${v}:a]adelay=delays=${delay}:all=1[a1]`); aparts.push('[a1]'); }
  if (music) { const mu = input('-stream_loop', '-1', '-i', music.path); f.push(`[${mu}:a]atrim=duration=${total},asetpts=PTS-STARTPTS,volume=${Math.max(0, Math.min(1, Number(music.volume ?? 0.3)))}[a2]`); aparts.push('[a2]'); }
  if (aparts.length) f.push(`${aparts.join('')}amix=inputs=${aparts.length}:duration=longest:normalize=0,atrim=duration=${total}[a]`);

  args.push('-filter_complex', f.join(';'), '-map', '[v]', ...(aparts.length ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k'] : ['-an']),
    ...(srtInput !== null ? ['-map', `${srtInput}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng'] : []),
    '-t', String(total), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
  // A damaged input can make FFmpeg spin forever: hard limit by length (at least 2 minutes).
  try { await run(args, Math.max(120000, Math.min(15 * 60000, total * 20000))); } finally { if (srt) await fs.promises.unlink(srt).catch(() => {}); }
  return { duration: total, width: W, height: H, subtitlesMode, srt: cues.length ? toSrt(cues.map(c => ({ ...c, start: c.start + introD, end: c.end + introD }))) : null };
}

/** Kept for callers of the first version: trim, subtitles and a soundtrack. */
async function edit({ input, output, start = null, end = null, cues = [], audio = null, mixAudio = false, main = null }) {
  return compose({ output, main: main || { path: input, duration: end ?? 3600, hasAudio: false }, start, end, cues, voice: audio ? { path: audio, mode: mixAudio ? 'mix' : 'replace' } : null });
}

module.exports = { available, compose, edit, toSrt, cuesFromScript, binary, canBurnSubtitles };
