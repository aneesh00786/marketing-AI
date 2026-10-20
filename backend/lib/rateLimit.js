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

module.exports = { rateLimit };
