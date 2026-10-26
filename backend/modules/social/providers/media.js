const fs = require('fs');

/**
 * Media handed to provider adapters: { kind, mime, url, filePath, sizeBytes, width, height,
 * durationSeconds, altText, title, thumbnailUrl }. filePath is set for uploaded files (read
 * lazily, never fully buffered); url is the public download URL used by platforms that fetch.
 */
async function openBlob(media, start, end) {
  const blob = await fs.openAsBlob(media.filePath, { type: media.mime || 'application/octet-stream' });
  return start === undefined ? blob : blob.slice(start, end);
}

module.exports = { openBlob };
