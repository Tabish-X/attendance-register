'use strict';

const { sendError } = require('./errors');

/**
 * Extract the client IP address from the request.
 */
function getClientIp(req) {
  const forwarded = req && req.headers ? (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']) : null;
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return (req && req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

/**
 * Firestore-based rate limiter (no external services needed).
 * Uses the `_rateLimits` collection with sliding window approach.
 */
async function checkRateLimit(req, max, windowSeconds) {
  try {
    const { adminDb } = require('./firebaseAdmin');
    const ip = getClientIp(req);
    const path = (req.url || req.path || '/unknown').split('?')[0];
    // Sanitize key for Firestore doc ID (no slashes)
    const key = `${ip}_${path}`.replace(/[\/\.]/g, '_').slice(0, 200);

    const docRef = adminDb.collection('_rateLimits').doc(key);
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    const doc = await docRef.get();

    if (!doc.exists) {
      // First request — create entry
      await docRef.set({ count: 1, windowStart: now, updatedAt: now });
      return { allowed: true, remaining: max - 1 };
    }

    const data = doc.data();
    const elapsed = now - data.windowStart;

    if (elapsed >= windowMs) {
      // Window expired — reset
      await docRef.set({ count: 1, windowStart: now, updatedAt: now });
      return { allowed: true, remaining: max - 1 };
    }

    if (data.count >= max) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((windowMs - elapsed) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    // Increment counter
    await docRef.update({ count: data.count + 1, updatedAt: now });
    return { allowed: true, remaining: max - data.count - 1 };
  } catch (err) {
    // If rate limiting fails, allow the request through
    console.error('[rateLimit] Error:', err.message);
    return { allowed: true, remaining: -1 };
  }
}

/**
 * Rate limiting middleware wrapper.
 *
 * @param {Function} handler - The inner request handler
 * @param {object} options
 * @param {number} options.max - Maximum requests allowed in the window
 * @param {number} options.window - Window size in seconds
 * @returns {Function} Wrapped handler
 */
function withRateLimit(handler, { max = 30, window: windowSeconds = 60 } = {}) {
  return async function rateLimitWrapper(req, res) {
    // Bypass rate limiting for GET requests to avoid database overhead on read operations
    if (req.method === 'GET') {
      return handler(req, res);
    }

    const result = await checkRateLimit(req, max, windowSeconds);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));

    if (!result.allowed) {
      if (result.retryAfter) {
        res.setHeader('Retry-After', result.retryAfter);
      }
      return sendError(res, 429, 'Too many requests. Please try again later.');
    }

    return handler(req, res);
  };
}

module.exports = { withRateLimit, getClientIp };
