const express = require('express');
const svc = require('./performanceService');

/**
 * Team performance. Mounted at /api/v1/performance. Owners/Admins see every member of the workspace;
 * anyone else sees only their own figures (checked in performanceService).
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use((req, res, next) => (req.auth?.userId ? next() : res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' })));

router.get('/', wrap(async (req, res) => res.json({ success: true, ...(await svc.report(req, req.query)) })));
router.get('/members/:userId/day', wrap(async (req, res) => res.json({ success: true, ...(await svc.memberDay(req, req.params.userId, req.query)) })));
router.get('/members/:userId/records/:kind', wrap(async (req, res) => res.json({ success: true, ...(await svc.memberRecords(req, req.params.userId, req.params.kind, req.query)) })));
router.get('/targets', wrap(async (req, res) => res.json({ success: true, ...(await svc.listTargets(req, req.query)) })));
router.post('/targets', express.json(), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveTarget(req, null, req.body)) })));
router.put('/targets/:id', express.json(), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveTarget(req, req.params.id, req.body)) })));
router.delete('/targets/:id', wrap(async (req, res) => res.json({ success: true, ...(await svc.removeTarget(req, req.params.id)) })));
router.get('/schedules', wrap(async (req, res) => res.json({ success: true, ...(await svc.listSchedules(req)) })));
router.post('/schedules', express.json(), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveSchedule(req, null, req.body)) })));
router.put('/schedules/:id', express.json(), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveSchedule(req, req.params.id, req.body)) })));
router.delete('/schedules/:id', wrap(async (req, res) => res.json({ success: true, ...(await svc.removeSchedule(req, req.params.id)) })));
router.get('/schedules/:id/preview', wrap(async (req, res) => res.json({ success: true, ...(await svc.previewSchedule(req, req.params.id)) })));
router.post('/schedules/:id/send-test', wrap(async (req, res) => res.json({ success: true, ...(await svc.testSchedule(req, req.params.id)) })));
router.get('/scoring', wrap(async (req, res) => res.json({ success: true, ...(await svc.getScoring(req)) })));
router.put('/scoring', express.json(), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveScoring(req, req.body)) })));
router.get('/compare', wrap(async (req, res) => res.json({ success: true, ...(await svc.compare(req, req.query)) })));
router.get('/drill', wrap(async (req, res) => res.json({ success: true, ...(await svc.drill(req, req.query)) })));
router.get('/export', wrap(async (req, res) => res.json({ success: true, ...(await svc.exportReport(req, req.query)) })));
router.get('/calls/:id', wrap(async (req, res) => res.json({ success: true, ...(await svc.callTranscript(req, req.params.id)) })));
router.get('/members/:userId', wrap(async (req, res) => res.json({ success: true, ...(await svc.memberDetail(req, req.params.userId, req.query)) })));

module.exports = router;
