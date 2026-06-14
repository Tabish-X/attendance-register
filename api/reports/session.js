'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  const { subjectId, date } = req.query;
  if (!subjectId || !date) {
    return sendError(res, 400, 'subjectId and date are required');
  }

  // Verify teacher owns subject
  const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
  if (!subDoc.exists || subDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  const sessionId = `${subjectId}_${date}`;
  const attSnap = await adminDb.collection('attendance').doc(sessionId).get();
  if (!attSnap.exists) {
    return sendError(res, 404, 'Session not found');
  }

  const attData = attSnap.data();
  const subData = subDoc.data();

  // Get students for this division
  const studentsSnap = await adminDb.collection('classes').doc(subData.classId)
    .collection('divisions').doc(subData.divisionId)
    .collection('students').get();

  const students = [];
  for (const sDoc of studentsSnap.docs) {
    const sData = sDoc.data();
    let name = null;
    if (sData.uid) {
      try {
        const userDoc = await adminDb.collection('users').doc(sData.uid).get();
        if (userDoc.exists) name = userDoc.data().name || null;
      } catch (_) {}
    }
    students.push({
      roll: sData.roll,
      name,
      status: attData.records?.[sData.roll] || null,
    });
  }

  students.sort((a, b) => parseInt(a.roll) - parseInt(b.roll));

  return sendSuccess(res, {
    subjectName: subData.name,
    date: attData.date,
    records: attData.records,
    students,
  });
}

module.exports = withRateLimit(withTeacher(handler), { max: 20, window: 60 });
