'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  const { classId } = req.query;
  if (!classId) return sendError(res, 400, 'classId is required');

  // Verify teacher owns class
  const classDoc = await adminDb.collection('classes').doc(classId).get();
  if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  try {
    const className = classDoc.data().name;

    // Get all divisions
    const divsSnap = await adminDb.collection('classes').doc(classId)
      .collection('divisions').get();

    const divisions = [];

    for (const divDoc of divsSnap.docs) {
      const divData = divDoc.data();

      // Get subjects for this division
      const subsSnap = await adminDb.collection('subjects')
        .where('classId', '==', classId)
        .where('divisionId', '==', divDoc.id).get();

      const subjects = subsSnap.docs.map(s => ({ id: s.id, name: s.data().name }));

      // Get students
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

      // Get attendance sessions for all subjects in this division
      const sessions = {};
      for (const sub of subjects) {
        const attSnap = await adminDb.collection('attendance')
          .where('subjectId', '==', sub.id).get();
        sessions[sub.id] = attSnap.docs.map(a => ({
          date: a.data().date,
          records: a.data().records || {},
        }));
      }

      // Calculate percentages per student per subject
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

module.exports = withRateLimit(withTeacher(handler), { max: 5, window: 60 });
