'use strict';

const { errorResponse } = require('../lib/errors');

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60;

/**
 * Rate limiter middleware. Tracks requests per peer (by Ed25519 public key).
 * Must be placed AFTER auth middleware so req.auth.publicKey is available.
 *
 * @param {{ windowMs?: number, maxRequests?: number }} options
 */
function createRateLimiter({ windowMs = DEFAULT_WINDOW_MS, maxRequests = DEFAULT_MAX_REQUESTS } = {}) {
  // Map<publicKey, { count: number, windowStart: number }>
  const counters = new Map();

  // Periodic cleanup of stale entries (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of counters) {
      if (now - entry.windowStart > windowMs * 2) {
        counters.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  return function rateLimitMiddleware(req, res, next) {
    const publicKey = req.auth && req.auth.publicKey;
    if (!publicKey) {
      return next();
    }

    const now = Date.now();
    let entry = counters.get(publicKey);

    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 1, windowStart: now };
      counters.set(publicKey, entry);
      return next();
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return errorResponse(res, 'rate_limit_exceeded',
        'Rate limit exceeded',
        `Max ${maxRequests} requests per ${windowMs / 1000}s. Retry after ${retryAfterSec}s.`);
    }

    next();
  };
}

module.exports = { createRateLimiter };
