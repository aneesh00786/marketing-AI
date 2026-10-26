const fs = require('fs');

/**
 * Identifies an uploaded media file from its content (never its name or declared type) and
 * reads the facts platform rules need. Only headers are read, through a file handle, so large
 * videos are never loaded into memory.
 *
 * Images: JPEG, PNG, WebP (static). Videos: ISO base media files (MP4, MOV) — duration from
 * mvhd, display size from tkhd (90°/270° rotation swaps width and height), codecs from stsd,
 * frame rate from stts. Anything else is rejected.
 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const VIDEO_CODECS = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', mp4v: 'mpeg4', apcn: 'prores', apch: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores' };
const AUDIO_CODECS = { mp4a: 'aac', 'ac-3': 'ac3', 'ec-3': 'eac3', Opus: 'opus', '.mp3': 'mp3', lpcm: 'pcm', sowt: 'pcm', twos: 'pcm', alac: 'alac' };
const QT_BRANDS = new Set(['qt  ']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'MSNV', 'dash', 'mmp4', '3gp4', '3gp5', '3gp6', 'f4v ']);

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function fail(reason) {
  return { ok: false, reason };
}

// ---------- Images ----------

async function probeJpeg(fh, size) {
  let pos = 2;
  while (pos + 4 <= size) {
    const head = await readAt(fh, pos, 4);
    if (head.length < 4 || head[0] !== 0xff) return fail('the JPEG structure is damaged');
    const marker = head[1];
    if (marker === 0xff) { pos += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = head.readUInt16BE(2);
    if (len < 2) return fail('the JPEG structure is damaged');
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      const sof = await readAt(fh, pos + 4, 6);
      if (sof.length < 6) return fail('the JPEG structure is damaged');
      const height = sof.readUInt16BE(1);
      const width = sof.readUInt16BE(3);
      const components = sof[5];
      if (!width || !height) return fail('the JPEG has no dimensions');
      return { ok: true, kind: 'image', mime: 'image/jpeg', format: 'jpeg', width, height, colorComponents: components, progressive: marker === 0xc2 };
    }
    pos += 2 + len;
  }
  return fail('no image frame was found in the JPEG');
}

function probePng(head) {
  if (head.length < 24 || head.subarray(12, 16).toString('latin1') !== 'IHDR') return fail('the PNG structure is damaged');
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (!width || !height) return fail('the PNG has no dimensions');
  return { ok: true, kind: 'image', mime: 'image/png', format: 'png', width, height };
}

function probeWebp(head) {
  const chunk = head.subarray(12, 16).toString('latin1');
  let width;
  let height;
  if (chunk === 'VP8 ' && head.length >= 30) {
    width = head.readUInt16LE(26) & 0x3fff;
    height = head.readUInt16LE(28) & 0x3fff;
  } else if (chunk === 'VP8L' && head.length >= 25) {
    const b = head.readUInt32LE(21);
    width = (b & 0x3fff) + 1;
    height = ((b >> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X' && head.length >= 30) {
    if (head[20] & 0x02) return fail('animated WebP files are not supported');
    width = 1 + head.readUIntLE(24, 3);
    height = 1 + head.readUIntLE(27, 3);
  } else {
    return fail('the WebP structure is not recognised');
  }
  if (!width || !height) return fail('the WebP has no dimensions');
  return { ok: true, kind: 'image', mime: 'image/webp', format: 'webp', width, height };
}

// ---------- ISO base media (MP4 / MOV) ----------

/** Iterates the boxes inside buf[start, end). */
function* boxes(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function child(buf, box, type) {
  for (const b of boxes(buf, box.start, box.end)) if (b.type === type) return b;
  return null;
}

function fixed16(buf, at) {
  return buf.readInt32BE(at) / 65536;
}

function parseTrack(buf, trak) {
  const out = {};
  const tkhd = child(buf, trak, 'tkhd');
  if (tkhd) {
    const v = buf[tkhd.start];
    const matrixAt = tkhd.start + (v === 1 ? 52 : 40);
    const sizeAt = tkhd.start + (v === 1 ? 88 : 76);
    if (sizeAt + 8 <= tkhd.end) {
      out.width = Math.round(fixed16(buf, sizeAt));
      out.height = Math.round(fixed16(buf, sizeAt + 4));
      const a = fixed16(buf, matrixAt);
      const d = fixed16(buf, matrixAt + 16);
      out.rotated = Math.abs(a) < 0.01 && Math.abs(d) < 0.01;
    }
  }
  const mdia = child(buf, trak, 'mdia');
  if (!mdia) return out;
  const hdlr = child(buf, mdia, 'hdlr');
  if (hdlr && hdlr.start + 12 <= hdlr.end) out.handler = buf.subarray(hdlr.start + 8, hdlr.start + 12).toString('latin1');
  const mdhd = child(buf, mdia, 'mdhd');
  if (mdhd) {
    const v = buf[mdhd.start];
    out.timescale = buf.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
    out.duration = v === 1 ? Number(buf.readBigUInt64BE(mdhd.start + 24)) : buf.readUInt32BE(mdhd.start + 16);
  }
  const stbl = child(buf, child(buf, mdia, 'minf') || { start: 0, end: 0 }, 'stbl');
  if (!stbl) return out;
  const stsd = child(buf, stbl, 'stsd');
  if (stsd && stsd.start + 16 <= stsd.end) out.sampleFormat = buf.subarray(stsd.start + 12, stsd.start + 16).toString('latin1');
  const stts = child(buf, stbl, 'stts');
  if (stts && stts.start + 8 <= stts.end) {
    const count = buf.readUInt32BE(stts.start + 4);
    let samples = 0;
    let ticks = 0;
    for (let i = 0; i < count && stts.start + 16 + i * 8 <= stts.end; i++) {
      const n = buf.readUInt32BE(stts.start + 8 + i * 8);
      samples += n;
      ticks += n * buf.readUInt32BE(stts.start + 12 + i * 8);
    }
    if (samples && ticks && out.timescale) out.frameRate = Math.round((samples * out.timescale / ticks) * 1000) / 1000;
  }
  return out;
}

async function probeIsoMedia(fh, size, head) {
  const brand = head.subarray(8, 12).toString('latin1');
  const isMov = QT_BRANDS.has(brand);
  if (!isMov && !MP4_BRANDS.has(brand)) return fail(`the video container brand "${brand.trim()}" is not supported; upload an MP4 or MOV file`);

  // Walk top-level boxes to find moov (it may be at the end of the file) and mdat.
  let pos = 0;
  let moov = null;
  let hasMdat = false;
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) break;
    let boxSize = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    let header = 8;
    if (boxSize === 1) {
      if (h.length < 16) break;
      boxSize = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - pos;
    }
    if (boxSize < header) return fail('the video structure is damaged');
    if (type === 'mdat' && boxSize > header) hasMdat = true;
    if (type === 'moov') moov = { pos, size: boxSize, header };
    pos += boxSize;
  }
  if (!moov) return fail('the video has no index (moov box); re-export it as a standard MP4');
  if (!hasMdat) return fail('the video contains no media data');
  if (moov.size > MAX_MOOV_BYTES) return fail('the video index is too large to inspect');
  const buf = await readAt(fh, moov.pos, moov.size);
  if (buf.length < moov.size) return fail('the video is truncated');
  const root = { start: moov.header, end: buf.length };

  let durationSeconds = null;
  const mvhd = child(buf, root, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.start];
    const timescale = buf.readUInt32BE(mvhd.start + (v === 1 ? 20 : 12));
    const duration = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
    if (timescale) durationSeconds = Math.round((duration / timescale) * 100) / 100;
  }

  let video = null;
  let audio = null;
  for (const b of boxes(buf, root.start, root.end)) {
    if (b.type !== 'trak') continue;
    const t = parseTrack(buf, b);
    if (t.handler === 'vide' && !video) video = t;
    if (t.handler === 'soun' && !audio) audio = t;
  }
  if (!video) return fail('the file has no video track');
  if (!durationSeconds && video.timescale && video.duration) durationSeconds = Math.round((video.duration / video.timescale) * 100) / 100;
  const width = video.rotated ? video.height : video.width;
  const height = video.rotated ? video.width : video.height;
  return {
    ok: true,
    kind: 'video',
    mime: isMov ? 'video/quicktime' : 'video/mp4',
    format: isMov ? 'mov' : 'mp4',
    width: width || null,
    height: height || null,
    durationSeconds,
    videoCodec: VIDEO_CODECS[video.sampleFormat] || (video.sampleFormat ? video.sampleFormat.trim() : null),
    audioCodec: audio ? (AUDIO_CODECS[audio.sampleFormat] || (audio.sampleFormat ? audio.sampleFormat.trim() : null)) : null,
    hasAudio: !!audio,
    frameRate: video.frameRate || null
  };
}

/** Probes a file on disk. Returns { ok: true, kind, mime, ... } or { ok: false, reason }. */
async function probeFile(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 16) return fail('the file is empty or too small');
    const head = await readAt(fh, 0, 64);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return await probeJpeg(fh, size);
    if (head.readUInt32BE(0) === 0x89504e47) return probePng(head);
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return probeWebp(head);
    if (head.subarray(4, 8).toString('latin1') === 'ftyp') return await probeIsoMedia(fh, size, head);
    if (/^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return fail('GIF files are not supported; upload JPEG, PNG or WebP');
    return fail('unsupported file type; upload JPEG, PNG or WebP images, or MP4/MOV videos');
  } finally {
    await fh.close();
  }
}

module.exports = { probeFile };
