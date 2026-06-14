'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withStudent } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { logAudit } = require('../_lib/audit');

/**
 * POST /api/students/roll — Set roll number (once only, immutable after set)
 *
 * Body: { roll: number }
 * - roll must be a positive integer 1–9999
 * - Cannot be changed once set
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  try {
    const { roll } = req.body || {};

    // ── Validate roll ──────────────────────────────────────────────────
    const rollNum = Number(roll);
    if (
      roll === undefined ||
      roll === null ||
      !Number.isInteger(rollNum) ||
      rollNum < 1 ||
      rollNum > 9999
    ) {
      return sendError(
        res,
        400,
        'Roll number must be a positive integer between 1 and 9999.'
      );
    }

    const uid = req.user.uid;
    const rollStr = String(rollNum);

    // ── Check if roll already set ──────────────────────────────────────
    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return sendError(res, 404, 'User profile not found.');
    }

    const userData = userSnap.data();
    if (userData.myRoll && userData.myRoll !== '') {
      return sendError(
        res,
        409,
        'Roll number is already set and cannot be changed.'
      );
    }

    // ── Update users/{uid} ─────────────────────────────────────────────
    await userRef.update({ myRoll: rollStr });

    // ── Also update students/{uid} if it exists ────────────────────────
    const studentRef = adminDb.collection('students').doc(uid);
    const studentSnap = await studentRef.get();
    if (studentSnap.exists) {
      await studentRef.update({ myRoll: rollStr });
    }

    // ── Audit log ──────────────────────────────────────────────────────
    await logAudit({
      action: 'ROLL_SET',
      userId: uid,
      userEmail: req.user.email || '',
      userRole: 'student',
      targetResource: `users/${uid}`,
      details: { roll: rollStr },
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    });

    return sendSuccess(res, { roll: rollStr });
  } catch (err) {
    console.error('students/roll error:', err);
    return sendError(res, 500, 'Internal server error.');
  }
}

module.exports = withRateLimit(withStudent(handler), { max: 5, window: 60 });
