/**
 * Fixed-window in-memory rate limiter.
 * Suitable for a single API process; move to Redis when running multiple instances.
 */
function rateLimit({ windowMs, max, keyFn, message = 'Too many requests. Please try again later.' }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60000));
  sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ success: false, error: message, code: 'RATE_LIMITED' });
    }
    next();
  };
}

/**
 * Per-route limit for AI generation endpoints, counted per workspace member (each route has its
 * own window). Applied after authentication, on top of the workspace AI usage quota.
 */
function aiRouteLimit(name) {
  return rateLimit({
    windowMs: parseInt(process.env.AI_ROUTE_RATE_WINDOW_MS || String(10 * 60 * 1000), 10),
    max: parseInt(process.env.AI_ROUTE_RATE_MAX || '20', 10),
    keyFn: req => `${name}:${req.auth?.workspaceId || 0}:${req.auth?.userId || req.ip}`,
    message: 'Too many AI requests for this feature. Please wait a few minutes and try again.'
  });
}

module.exports = { rateLimit, aiRouteLimit };
