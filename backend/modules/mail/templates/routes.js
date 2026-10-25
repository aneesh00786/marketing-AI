const fs = require('fs');
const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const svc = require('./templateService');
const store = require('./assetStore');
const importer = require('./importer');

/**
 * Email templates: /api/v1/mail/templates (signed-in members), plus the public asset route
 * /api/v1/mail/assets/:publicId used by recipients' mail clients and Zoho to load images.
 */
const templates = express.Router();
const assets = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ success: false, code: 'TOO_LARGE', error: 'The upload is too large.' });
  const status = err.status || err.statusCode || 500;
  if (status < 500 || err.expose) return res.status(status).json({ success: false, error: err.message, code: err.code });
  next(err);
});

// Public, opaque, immutable image/font URLs. Only stored, verified types are served.
assets.get('/:publicId', wrap(async (req, res) => {
  const a = await store.findPublic(req.params.publicId);
  if (!a) return res.status(404).type('text/plain').send('Not found');
  let stat;
  try { stat = await fs.promises.stat(a.path); } catch (e) { return res.status(404).type('text/plain').send('Not found'); }
  res.set({
    'Content-Type': a.mime,
    'Content-Length': String(stat.size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Robots-Tag': 'noindex'
  });
  fs.createReadStream(a.path).on('error', () => res.destroy()).pipe(res);
}));

templates.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

// Raw upload body (.html/.htm or .zip); the limit is the largest allowed upload.
const rawUpload = (req, res, next) => express.raw({ type: () => true, limit: Math.max(importer.limits().zipBytes, importer.limits().htmlBytes) })(req, res, next);

templates.get('/', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.list(req, req.query)) })));
templates.get('/categories', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.categories(req)) })));
templates.post('/import', requireCapability('mail.compose'), rawUpload, wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: 'Send the file as the request body.' });
  res.json({ success: true, ...(await svc.importUpload(req, { buffer: req.body, filename: req.query.filename, entry: req.query.entry })) });
}));
templates.post('/analyze', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.analyze(req, req.body)) })));
templates.post('/assets/cleanup', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await svc.cleanupAssets(req, req.body || {})) })));
templates.post('/', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, template: await svc.create(req, req.body) })));
templates.get('/:id', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, template: await svc.getOne(req, req.params.id) })));
templates.patch('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, template: await svc.update(req, req.params.id, req.body) })));
templates.post('/:id/duplicate', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, template: await svc.duplicate(req, req.params.id) })));
templates.delete('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.remove(req, req.params.id)) })));

module.exports = { templates, assets };
