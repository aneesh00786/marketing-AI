/**
 * Minimal, structurally valid media files built in memory for tests: enough of each format for
 * content detection and header parsing (dimensions, duration, codecs, frame rate).
 */
function jpeg(width, height, { padBytes = 0 } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(padBytes, 0x11), Buffer.from([0xff, 0xd9])]);
}

function png(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(16)]);
}

function webp(width, height) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function u32(...vals) {
  const b = Buffer.alloc(vals.length * 4);
  vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
}

function tkhd(width, height, rotated) {
  const b = Buffer.alloc(84);
  // version 0; matrix at 40, size at 76 (16.16 fixed)
  const m = rotated ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  m.forEach((v, i) => b.writeInt32BE(v, 40 + i * 4));
  b.writeUInt32BE(width * 65536, 76);
  b.writeUInt32BE(height * 65536, 80);
  return box('tkhd', b);
}

function track({ handler, format, width = 0, height = 0, rotated = false, timescale, duration, samples, delta }) {
  const mdhd = box('mdhd', u32(0, 0, 0, timescale, duration, 0));
  const hdlr = box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(13));
  const entry = box(format, Buffer.alloc(8));
  const stsd = box('stsd', u32(0, 1), entry);
  const stts = box('stts', u32(0, 1, samples, delta));
  const stbl = box('stbl', stsd, stts);
  return box('trak', tkhd(width, height, rotated), box('mdia', mdhd, hdlr, box('minf', stbl)));
}

/** MP4/MOV with a video track (and optionally AAC audio). */
function mp4({ width = 1080, height = 1920, seconds = 10, fps = 30, codec = 'avc1', audio = 'mp4a', rotated = false, brand = 'isom', mdatBytes = 2048 } = {}) {
  const ts = 600;
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, Math.round(seconds * 1000)), Buffer.alloc(80));
  const tracks = [track({ handler: 'vide', format: codec, width, height, rotated, timescale: ts, duration: seconds * ts, samples: Math.round(seconds * fps), delta: Math.round(ts / fps) })];
  if (audio) tracks.push(track({ handler: 'soun', format: audio, timescale: 48000, duration: seconds * 48000, samples: seconds * 47, delta: 1024 }));
  const ftyp = box('ftyp', Buffer.from(brand.padEnd(4), 'latin1'), u32(0), Buffer.from('isommp41', 'latin1'));
  return Buffer.concat([ftyp, box('moov', mvhd, ...tracks), box('mdat', Buffer.alloc(mdatBytes, 1))]);
}

module.exports = { jpeg, png, webp, mp4 };
