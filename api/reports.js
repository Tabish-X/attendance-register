'use strict';

const { adminDb } = require('./_lib/firebaseAdmin');
const { withTeacher } = require('./_lib/auth');
const { sendSuccess, sendError } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');

// ==========================================
// SESSION REPORT LOGIC
// ==========================================
async function handleSessionReport(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const { subjectId, date } = req.query;
  if (!subjectId || !date) {
    return sendError(res, 400, 'subjectId and date are required');
  }

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

// ==========================================
// CLASS REPORT LOGIC
// ==========================================
async function handleClassReport(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const { classId } = req.query;
  if (!classId) return sendError(res, 400, 'classId is required');

  const classDoc = await adminDb.collection('classes').doc(classId).get();
  if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  try {
    const className = classDoc.data().name;

    const divsSnap = await adminDb.collection('classes').doc(classId)
      .collection('divisions').get();

    const divisions = [];

    for (const divDoc of divsSnap.docs) {
      const divData = divDoc.data();

      const subsSnap = await adminDb.collection('subjects')
        .where('classId', '==', classId)
        .where('divisionId', '==', divDoc.id).get();

      const subjects = subsSnap.docs.map(s => ({ id: s.id, name: s.data().name }));

      const studentsSnap = await adminDb.collection('classes').doc(classId)
        .collection('divisions').doc(divDoc.id)
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
        students.push({ roll: sData.roll, name, uid: sData.uid || null });
      }
      students.sort((a, b) => parseInt(a.roll) - parseInt(b.roll));

      const sessions = {};
      for (const sub of subjects) {
        const attSnap = await adminDb.collection('attendance')
          .where('subjectId', '==', sub.id).get();
        sessions[sub.id] = attSnap.docs.map(a => ({
          date: a.data().date,
          records: a.data().records || {},
        }));
      }

      const percentages = {};
      for (const student of students) {
        percentages[student.roll] = {};
        for (const sub of subjects) {
          const subSessions = sessions[sub.id] || [];
          let present = 0, total = 0;
          for (const sess of subSessions) {
            const status = sess.records[student.roll];
            if (status) {
              total++;
              if (status === 'P') present++;
            }
          }
          percentages[student.roll][sub.id] = {
            present, total,
            pct: total > 0 ? parseFloat(((present / total) * 100).toFixed(2)) : 0,
          };
        }
      }

      divisions.push({
        id: divDoc.id,
        name: divData.name,
        subjects,
        students,
        sessions,
        percentages,
      });
    }

    return sendSuccess(res, { className, divisions });
  } catch (err) {
    console.error('[class-report] Error:', err);
    return sendError(res, 500, 'Internal server error');
  }
}

// Wrap sub-handlers with their specific rate limits
const sessionReportHandler = withRateLimit(handleSessionReport, { max: 20, window: 60 });
const classReportHandler = withRateLimit(handleClassReport, { max: 5, window: 60 });

async function mainHandler(req, res) {
  const { action } = req.query;

  if (action === 'session') {
    return sessionReportHandler(req, res);
  } else if (action === 'class-report') {
    return classReportHandler(req, res);
  }

  return sendError(res, 404, 'Not found');
}

module.exports = withTeacher(mainHandler);
