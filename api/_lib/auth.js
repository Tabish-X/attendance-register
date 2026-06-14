'use strict';

const { adminAuth, adminDb } = require('./firebaseAdmin');
const { sendError } = require('./errors');

/**
 * Auth middleware wrapper.
 * Extracts and verifies Firebase ID token from the Authorization header,
 * loads the user profile from Firestore, and attaches it to req.user.
 *
 * Rejects with:
 *  - 401 if token is missing or invalid
 *  - 403 if email is not verified
 *  - 403 if user profile is not found (account not fully set up)
 *
 * @param {Function} handler - The inner request handler
 * @returns {Function} Wrapped handler
 */
function withAuth(handler) {
  return async function authWrapper(req, res) {
    try {
      // ── Extract Bearer token ──────────────────────────────────────
      const authHeader = req.headers.authorization || req.headers.Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return sendError(res, 401, 'Missing or malformed Authorization header');
      }

      const token = authHeader.slice(7); // strip "Bearer "
      if (!token) {
        return sendError(res, 401, 'Missing authentication token');
      }

      // ── Verify token ─────────────────────────────────────────────
      let decodedToken;
      try {
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch (err) {
        // Common Firebase Auth error codes
        if (
          err.code === 'auth/id-token-expired' ||
          err.code === 'auth/argument-error'
        ) {
          return sendError(res, 401, 'Authentication token has expired. Please sign in again.');
        }
        return sendError(res, 401, 'Invalid authentication token');
      }

      // ── Check email verification ──────────────────────────────────
      if (!decodedToken.email_verified) {
        return sendError(res, 403, 'Email not verified. Please verify your email before continuing.');
      }

      // ── Load user profile from Firestore ─────────────────────────
      const uid = decodedToken.uid;
      const userDoc = await adminDb.collection('users').doc(uid).get();

      if (!userDoc.exists) {
        // User exists in Firebase Auth but not in Firestore yet.
        // This is expected for first-login migration — let the handler decide
        // what to do by setting a flag.
        req.user = {
          uid,
          email: decodedToken.email,
          role: null,
          profile: null,
          _pendingMigration: true,
        };
      } else {
        const profile = userDoc.data();
        req.user = {
          uid,
          email: decodedToken.email || profile.email,
          role: profile.role,
          profile,
        };
      }

      return handler(req, res);
    } catch (err) {
      console.error('[withAuth] Unexpected error:', err);
      return sendError(res, 500, 'Internal authentication error');
    }
  };
}

/**
 * Teacher role middleware wrapper.
 * Wraps withAuth and additionally checks that the authenticated user
 * has the 'teacher' role.
 *
 * @param {Function} handler - The inner request handler
 * @returns {Function} Wrapped handler
 */
function withTeacher(handler) {
  return withAuth(async function teacherWrapper(req, res) {
    if (!req.user || req.user.role !== 'teacher') {
      return sendError(res, 403, 'Forbidden: teacher role required');
    }
    return handler(req, res);
  });
}

/**
 * Student role middleware wrapper.
 * Wraps withAuth and additionally checks that the authenticated user
 * has the 'student' role.
 *
 * @param {Function} handler - The inner request handler
 * @returns {Function} Wrapped handler
 */
function withStudent(handler) {
  return withAuth(async function studentWrapper(req, res) {
    if (!req.user || req.user.role !== 'student') {
      return sendError(res, 403, 'Forbidden: student role required');
    }
    return handler(req, res);
  });
}

module.exports = { withAuth, withTeacher, withStudent };
