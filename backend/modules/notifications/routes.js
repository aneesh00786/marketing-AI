const express = require('express');
const svc = require('./notificationService');

/** The bell: GET the current notifications; mark one or all as read. Each person sees only their own. */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use((req, res, next) => (req.auth?.userId && req.auth?.workspaceId ? next() : res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' })));
router.get('/', wrap(async (req, res) => res.json({ success: true, ...(await svc.list(req)) })));
router.post('/read-all', wrap(async (req, res) => res.json({ success: true, ...(await svc.markAllRead(req)) })));
router.post('/:id/read', wrap(async (req, res) => res.json({ success: true, ...(await svc.markRead(req, req.params.id)) })));
module.exports = router;
