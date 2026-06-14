'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withStudent } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  const { subjectId } = req.query;
  if (!subjectId) return sendError(res, 400, 'subjectId is required');

  const uid = req.user.uid;

  // Get subject to find classId/divisionId
  const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
  if (!subDoc.exists) return sendError(res, 404, 'Subject not found');

  const { classId, divisionId } = subDoc.data();

  // Verify student is linked to this division
  const linksSnap = await adminDb.collection('studentLinks')
    .where('uid', '==', uid)
    .where('classId', '==', classId)
    .where('divisionId', '==', divisionId).get();

  if (linksSnap.empty) {
    return sendError(res, 403, 'You are not linked to this division');
  }

  // Get student's roll
  const userDoc = await adminDb.collection('users').doc(uid).get();
  const myRoll = userDoc.exists ? userDoc.data().myRoll : null;
  if (!myRoll) return sendError(res, 400, 'Roll number not set');

  // Get attendance
  const attSnap = await adminDb.collection('attendance')
    .where('subjectId', '==', subjectId).get();

  const records = [];
  for (const attDoc of attSnap.docs) {
    const data = attDoc.data();
    const status = data.records?.[String(myRoll)];
    if (status) {
      records.push({ date: data.date, status });
    }
  }
  records.sort((a, b) => a.date.localeCompare(b.date));

  const present = records.filter(r => r.status === 'P').length;
  const total = records.length;
  const pct = total > 0 ? parseFloat(((present / total) * 100).toFixed(2)) : 0;

  return sendSuccess(res, {
    records,
    overall: { present, total, pct },
  });
}

module.exports = withRateLimit(withStudent(handler), { max: 30, window: 60 });
