'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withStudent } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { validateJoinCode } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * POST /api/students/join — Join a division using a 6-character join code.
 *
 * Body: { joinCode: string }
 * - Student must have myRoll set before joining
 * - Prevents duplicate joins and roll collisions
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  try {
    const { joinCode } = req.body || {};
    const uid = req.user.uid;

    // ── Validate & normalize join code ─────────────────────────────────
    if (!joinCode || typeof joinCode !== 'string') {
      return sendError(res, 400, 'Join code is required.');
    }

    const cleanCode = joinCode.trim().toUpperCase();

    if (!validateJoinCode(cleanCode)) {
      return sendError(
        res,
        400,
        'Invalid join code format. Must be 6 characters using A-Z (no O/I) and 2-9 (no 0/1).'
      );
    }

    // ── Look up join code ──────────────────────────────────────────────
    const codeSnap = await adminDb.collection('joinCodes').doc(cleanCode).get();
    if (!codeSnap.exists) {
      return sendError(
        res,
        404,
        'Join code not found. Please check the code and try again.'
      );
    }

    const { classId, divisionId } = codeSnap.data();
    if (!classId || !divisionId) {
      return sendError(res, 500, 'Internal server error.');
    }

    // ── Get student's roll number ──────────────────────────────────────
    const userSnap = await adminDb.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return sendError(res, 404, 'User profile not found.');
    }

    const myRoll = userSnap.data().myRoll;
    if (!myRoll || myRoll === '') {
      return sendError(res, 400, 'Please set your roll number first.');
    }

    // ── Check not already joined ───────────────────────────────────────
    const existingLinkSnap = await adminDb
      .collection('studentLinks')
      .where('uid', '==', uid)
      .where('classId', '==', classId)
      .where('divisionId', '==', divisionId)
      .limit(1)
      .get();

    if (!existingLinkSnap.empty) {
      return sendError(res, 409, 'You have already joined this division.');
    }

    // ── Check roll not taken by another student ────────────────────────
    const rollTakenSnap = await adminDb
      .collection('studentLinks')
      .where('classId', '==', classId)
      .where('divisionId', '==', divisionId)
      .where('roll', '==', myRoll)
      .limit(1)
      .get();

    if (!rollTakenSnap.empty) {
      const takenDoc = rollTakenSnap.docs[0].data();
      if (takenDoc.uid !== uid) {
        return sendError(
          res,
          409,
          `Roll number ${myRoll} is already taken by another student in this division.`
        );
      }
    }

    // ── Create studentLinks doc ────────────────────────────────────────
    await adminDb.collection('studentLinks').add({
      uid,
      classId,
      divisionId,
      roll: myRoll,
      joinCode: cleanCode,
      createdAt: FieldValue.serverTimestamp(),
    });

    // ── Update student subdoc under division (set uid on matching roll) ─
    const studentSubSnap = await adminDb
      .collection('classes')
      .doc(classId)
      .collection('divisions')
      .doc(divisionId)
      .collection('students')
      .where('roll', '==', myRoll)
      .limit(1)
      .get();

    if (!studentSubSnap.empty) {
      await studentSubSnap.docs[0].ref.update({ uid });
    }

    // ── Update students/{uid}.linkedDivisions (avoid duplicates) ───────
    const studentRef = adminDb.collection('students').doc(uid);
    const studentSnap = await studentRef.get();

    const linkEntry = { classId, divisionId, roll: myRoll };

    if (studentSnap.exists) {
      const currentLinks = studentSnap.data().linkedDivisions || [];
      const alreadyLinked = currentLinks.some(
        (l) => l.classId === classId && l.divisionId === divisionId
      );
      if (!alreadyLinked) {
        await studentRef.update({
          linkedDivisions: FieldValue.arrayUnion(linkEntry),
        });
      }
    }

    // ── Audit log ──────────────────────────────────────────────────────
    await logAudit({
      action: 'STUDENT_JOIN',
      userId: uid,
      userEmail: req.user.email || '',
      userRole: 'student',
      targetResource: `classes/${classId}/divisions/${divisionId}`,
      details: { roll: myRoll, joinCode: cleanCode },
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    });

    return sendSuccess(res);
  } catch (err) {
    console.error('students/join error:', err);
    return sendError(res, 500, 'Internal server error.');
  }
}

module.exports = withRateLimit(withStudent(handler), { max: 10, window: 900 });
