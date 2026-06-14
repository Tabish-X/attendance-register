'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { validateRollRange } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

async function handler(req, res) {
  const classId = req.query.classId;
  const divisionId = req.query.divisionId;

  if (req.method === 'GET') {
    if (!classId || !divisionId) {
      return sendError(res, 400, 'classId and divisionId are required');
    }

    // Verify ownership
    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const snap = await adminDb.collection('classes').doc(classId)
      .collection('divisions').doc(divisionId)
      .collection('students').get();

    // Fetch names for linked students
    const students = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      let name = null;
      if (data.uid) {
        try {
          const userDoc = await adminDb.collection('users').doc(data.uid).get();
          if (userDoc.exists) name = userDoc.data().name || null;
        } catch (_) {}
      }
      students.push({ id: doc.id, roll: data.roll, uid: data.uid || null, name });
    }

    students.sort((a, b) => parseInt(a.roll) - parseInt(b.roll));
    return sendSuccess(res, { students });
  }

  if (req.method === 'POST') {
    const { classId: cId, divisionId: dId, rolls } = req.body || {};
    if (!cId || !dId || !rolls) {
      return sendError(res, 400, 'classId, divisionId, and rolls are required');
    }

    // Verify ownership
    const classDoc = await adminDb.collection('classes').doc(cId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const result = validateRollRange(rolls);
    if (!result.valid) return sendError(res, 400, result.error);

    // Get existing rolls to skip duplicates
    const existingSnap = await adminDb.collection('classes').doc(cId)
      .collection('divisions').doc(dId)
      .collection('students').get();
    const existingRolls = new Set(existingSnap.docs.map(d => String(d.data().roll)));

    const newRolls = result.rolls.filter(r => !existingRolls.has(r));
    const studentsRef = adminDb.collection('classes').doc(cId)
      .collection('divisions').doc(dId).collection('students');

    // Batch write (Firestore batches max 500)
    let added = 0;
    const batchSize = 400;
    for (let i = 0; i < newRolls.length; i += batchSize) {
      const batch = adminDb.batch();
      const chunk = newRolls.slice(i, i + batchSize);
      for (const roll of chunk) {
        const ref = studentsRef.doc();
        batch.set(ref, {
          roll: String(roll),
          uid: null,
          createdAt: FieldValue.serverTimestamp(),
        });
        added++;
      }
      await batch.commit();
    }

    logAudit(req, 'ROLL_ADD', `classes/${cId}/divisions/${dId}`,
      { added, rolls: newRolls.join(', ') });

    return sendCreated(res, { added });
  }

  if (req.method === 'DELETE') {
    const studentId = req.query.studentId;
    if (!classId || !divisionId || !studentId) {
      return sendError(res, 400, 'classId, divisionId, and studentId are required');
    }

    // Verify ownership
    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    await adminDb.collection('classes').doc(classId)
      .collection('divisions').doc(divisionId)
      .collection('students').doc(studentId).delete();

    return sendSuccess(res, { deleted: true });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 30, window: 60 });
