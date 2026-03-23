'use strict';

/**
 * In-memory rate limiter per peer (by Ed25519 public key).
 * 60 requests/minute, returns 429 with Retry-After header on exceed.
 */

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60;

function createRateLimiter({ windowMs = DEFAULT_WINDOW_MS, maxRequests = DEFAULT_MAX_REQUESTS } = {}) {
  // Map<publicKey, { count, windowStart }>
  const buckets = new Map();

  // Periodic cleanup of stale buckets (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart > windowMs * 2) {
        buckets.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  return function rateLimiter(req, res, next) {
    // Only rate-limit authenticated requests (those with req.auth)
    if (!req.auth || !req.auth.publicKey) {
      return next();
    }

    const key = req.auth.publicKey;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s.`,
        },
      });
    }

    next();
  };
}

module.exports = { createRateLimiter };
