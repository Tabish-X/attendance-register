'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { validateDate, validateAttendanceRecords } = require('../_lib/validate');
const { generateChecksum } = require('../_lib/checksum');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

async function handler(req, res) {
  if (req.method === 'GET') {
    const { subjectId, date } = req.query;
    if (!subjectId) return sendError(res, 400, 'subjectId is required');

    // Verify teacher owns this subject
    const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
    if (!subDoc.exists) return sendError(res, 404, 'Subject not found');
    if (subDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    if (date) {
      // Single session
      const sessionId = `${subjectId}_${date}`;
      const snap = await adminDb.collection('attendance').doc(sessionId).get();
      return sendSuccess(res, { session: snap.exists ? snap.data() : null });
    }

    // All sessions for subject
    const snap = await adminDb.collection('attendance')
      .where('subjectId', '==', subjectId).get();
    const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return sendSuccess(res, { sessions });
  }

  if (req.method === 'POST') {
    const { subjectId, date, records } = req.body || {};
    if (!subjectId || !date || !records) {
      return sendError(res, 400, 'subjectId, date, and records are required');
    }

    // Validate date
    if (!validateDate(date)) {
      return sendError(res, 400, 'Invalid date format. Use YYYY-MM-DD');
    }

    // Validate records
    const recCheck = validateAttendanceRecords(records);
    if (!recCheck.valid) return sendError(res, 400, recCheck.error);

    // Verify teacher owns this subject
    const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
    if (!subDoc.exists) return sendError(res, 404, 'Subject not found');
    if (subDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    // Generate cryptographic checksum
    const checksum = generateChecksum(subjectId, date, records);
    const sessionId = `${subjectId}_${date}`;

    await adminDb.collection('attendance').doc(sessionId).set({
      subjectId,
      date,
      records,
      checksum,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'ATTENDANCE_SAVE', `attendance/${sessionId}`,
      { subjectId, date, rollCount: Object.keys(records).length });

    return sendSuccess(res, { saved: true, sessionId });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 30, window: 60 });
