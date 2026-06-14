'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { validateAttendanceRecords } = require('../_lib/validate');
const { generateChecksum } = require('../_lib/checksum');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

async function handler(req, res) {
  const sessionId = req.query.id;
  if (!sessionId) return sendError(res, 400, 'Session id is required');

  // Read the attendance doc
  const attDoc = await adminDb.collection('attendance').doc(sessionId).get();
  if (!attDoc.exists) return sendError(res, 404, 'Attendance session not found');

  const attData = attDoc.data();
  const subjectId = attData.subjectId;

  // Verify teacher owns the subject
  const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
  if (!subDoc.exists || subDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  if (req.method === 'PUT') {
    const { records } = req.body || {};
    if (!records) return sendError(res, 400, 'records is required');

    const recCheck = validateAttendanceRecords(records);
    if (!recCheck.valid) return sendError(res, 400, recCheck.error);

    // Calculate diff for audit
    const oldRecords = attData.records || {};
    const changes = [];
    for (const [roll, status] of Object.entries(records)) {
      if (oldRecords[roll] !== status) {
        changes.push({ roll, from: oldRecords[roll] || 'N/A', to: status });
      }
    }

    // Generate new checksum
    const checksum = generateChecksum(subjectId, attData.date, records);

    await adminDb.collection('attendance').doc(sessionId).update({
      records,
      checksum,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'ATTENDANCE_EDIT', `attendance/${sessionId}`,
      { subjectId, date: attData.date, changesCount: changes.length, changes: changes.slice(0, 20) });

    return sendSuccess(res, { updated: true });
  }

  if (req.method === 'DELETE') {
    await adminDb.collection('attendance').doc(sessionId).delete();

    logAudit(req, 'ATTENDANCE_DELETE', `attendance/${sessionId}`,
      { subjectId, date: attData.date });

    return sendSuccess(res, { deleted: true });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 20, window: 60 });
