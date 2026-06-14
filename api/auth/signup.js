'use strict';

const { adminAuth, adminDb, FieldValue } = require('../_lib/firebaseAdmin');
const { sendError, sendCreated } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString, validateEmail, requireFields } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');

/**
 * POST /api/auth/signup
 *
 * Creates a new user account. No auth required (user doesn't have one yet).
 *
 * Body: { email, password, name, role, teacherCode? }
 *
 * Flow:
 *  1. Validate all inputs (including teacher code if role=teacher)
 *  2. Create user in Firebase Auth via Admin SDK
 *  3. Write to pendingUsers/{uid}
 *  4. Return success — frontend then signs in and sends verification email
 *
 * Ghost-account handling:
 *  If email already in use, check if the existing account is unverified.
 *  If unverified and in pendingUsers with the same role, delete and recreate.
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  // ── Validate required fields ──────────────────────────────────────
  const { valid, missing } = requireFields(req.body, ['email', 'password', 'name', 'role']);
  if (!valid) {
    return sendError(res, 400, `Missing required fields: ${missing.join(', ')}`);
  }

  // ── Sanitize and validate inputs ──────────────────────────────────
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password; // don't sanitize passwords (they can have special chars)
  const name = sanitizeString(req.body.name, 100);
  const role = (req.body.role || '').trim().toLowerCase();
  const teacherCode = (req.body.teacherCode || '').trim();

  if (!validateEmail(email)) {
    return sendError(res, 400, 'Invalid email address');
  }

  if (typeof password !== 'string' || password.length < 6) {
    return sendError(res, 400, 'Password must be at least 6 characters');
  }

  if (password.length > 128) {
    return sendError(res, 400, 'Password must not exceed 128 characters');
  }

  if (!name || name.length < 1) {
    return sendError(res, 400, 'Name is required and must be 1-100 characters');
  }

  if (role !== 'teacher' && role !== 'student') {
    return sendError(res, 400, 'Role must be "teacher" or "student"');
  }

  // ── Teacher code verification ─────────────────────────────────────
  if (role === 'teacher') {
    const serverCode = process.env.TEACHER_SIGNUP_CODE;
    if (!serverCode) {
      console.error('[signup] TEACHER_SIGNUP_CODE env var is not set');
      return sendError(res, 500, 'Teacher registration is currently unavailable');
    }
    if (teacherCode !== serverCode) {
      return sendError(res, 403, 'Invalid teacher access code');
    }
  }

  // ── Create user in Firebase Auth ──────────────────────────────────
  let userRecord;
  try {
    userRecord = await adminAuth.createUser({
      email,
      password,
      displayName: name,
    });
  } catch (err) {
    // Handle "email already in use" — check for ghost/unverified account
    if (err.code === 'auth/email-already-exists') {
      return await handleExistingEmail(req, res, email, password, name, role);
    }

    if (err.code === 'auth/invalid-email') {
      return sendError(res, 400, 'Invalid email address');
    }

    if (err.code === 'auth/invalid-password') {
      return sendError(res, 400, 'Password does not meet requirements (minimum 6 characters)');
    }

    console.error('[signup] Firebase Auth createUser error:', err.code, err.message);
    return sendError(res, 500, 'Failed to create account. Please try again later.');
  }

  // ── Write to pendingUsers ─────────────────────────────────────────
  try {
    await adminDb.collection('pendingUsers').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      role,
      name,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // If Firestore write fails, clean up the Auth user to avoid orphans
    console.error('[signup] Failed to write pendingUsers doc:', err.message);
    try {
      await adminAuth.deleteUser(userRecord.uid);
    } catch (delErr) {
      console.error('[signup] Failed to clean up Auth user after Firestore error:', delErr.message);
    }
    return sendError(res, 500, 'Failed to create account. Please try again later.');
  }

  // ── Audit log (teacher signups only, fire-and-forget) ─────────────
  if (role === 'teacher') {
    // Create a minimal req.user for audit logging since no auth middleware ran
    req.user = { uid: userRecord.uid, email, role };
    logAudit(req, 'TEACHER_SIGNUP', `pendingUsers/${userRecord.uid}`, { name });
  }

  return sendCreated(res, {
    message: 'Account created. Please check your email for verification.',
    uid: userRecord.uid,
  });
}

/**
 * Handle the case where the email already exists in Firebase Auth.
 * If the existing account is unverified and matches the role in pendingUsers,
 * delete it and recreate.
 */
async function handleExistingEmail(req, res, email, password, name, role) {
  try {
    const existingUser = await adminAuth.getUserByEmail(email);

    // Only allow ghost-account cleanup if the existing account is unverified
    if (existingUser.emailVerified) {
      return sendError(res, 409, 'An account with this email already exists');
    }

    // Check if there's a matching pendingUsers doc
    const pendingDoc = await adminDb.collection('pendingUsers').doc(existingUser.uid).get();

    if (!pendingDoc.exists) {
      // Unverified but no pending doc — might be partially created
      // Allow cleanup only if no profile exists in users collection either
      const userDoc = await adminDb.collection('users').doc(existingUser.uid).get();
      if (userDoc.exists) {
        return sendError(res, 409, 'An account with this email already exists');
      }
    } else {
      // If pending doc exists but role doesn't match, reject
      const pendingData = pendingDoc.data();
      if (pendingData.role !== role) {
        return sendError(res, 409, 'An account with this email already exists with a different role');
      }
    }

    // Delete the ghost account and its pending doc
    await adminAuth.deleteUser(existingUser.uid);
    if (pendingDoc && pendingDoc.exists) {
      await adminDb.collection('pendingUsers').doc(existingUser.uid).delete();
    }

    // Now recreate
    const newUser = await adminAuth.createUser({
      email,
      password,
      displayName: name,
    });

    await adminDb.collection('pendingUsers').doc(newUser.uid).set({
      uid: newUser.uid,
      email,
      role,
      name,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (role === 'teacher') {
      req.user = { uid: newUser.uid, email, role };
      logAudit(req, 'TEACHER_SIGNUP', `pendingUsers/${newUser.uid}`, {
        name,
        note: 'Replaced unverified ghost account',
      });
    }

    return sendCreated(res, {
      message: 'Account created. Please check your email for verification.',
      uid: newUser.uid,
    });
  } catch (err) {
    console.error('[signup] Ghost account handling error:', err.message);
    return sendError(res, 409, 'An account with this email already exists');
  }
}

module.exports = withRateLimit(handler, { max: 5, window: 900 });
