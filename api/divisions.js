'use strict';

const { adminDb, FieldValue } = require('./_lib/firebaseAdmin');
const { withTeacher } = require('./_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');
const { sanitizeString, requireFields, validateRollRange } = require('./_lib/validate');
const { logAudit } = require('./_lib/audit');
const crypto = require('crypto');

const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += JOIN_CODE_CHARS[crypto.randomInt(JOIN_CODE_CHARS.length)];
  }
  return code;
}

// ==========================================
// REGEN JOIN CODE
// ==========================================
async function handleRegenCode(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
  
  const { classId, divisionId } = req.body || {};
  if (!classId || !divisionId) {
    return sendError(res, 400, 'classId and divisionId are required');
  }

  const classDoc = await adminDb.collection('classes').doc(classId).get();
  if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  try {
    const divRef = adminDb.collection('classes').doc(classId)
      .collection('divisions').doc(divisionId);
    const divSnap = await divRef.get();

    if (!divSnap.exists) return sendError(res, 404, 'Division not found');

    const oldCode = divSnap.data().joinCode;
    if (oldCode) {
      await adminDb.collection('joinCodes').doc(oldCode).delete();
    }

    const newCode = generateJoinCode();
    await divRef.update({ joinCode: newCode });
    await adminDb.collection('joinCodes').doc(newCode).set({
      classId,
      divisionId,
      createdAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'JOINCODE_REGEN', `classes/${classId}/divisions/${divisionId}`,
      { oldCode, newCode });

    return sendSuccess(res, { joinCode: newCode });
  } catch (err) {
    console.error('[regen-code] Error:', err);
    return sendError(res, 500, 'Internal server error');
  }
}

// ==========================================
// DIVISION STUDENTS MANAGEMENT
// ==========================================
async function handleStudents(req, res) {
  const classId = req.query.classId;
  const divisionId = req.query.divisionId;

  // GET — list students
  if (req.method === 'GET') {
    if (!classId || !divisionId) {
      return sendError(res, 400, 'classId and divisionId are required');
    }

    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const snap = await adminDb.collection('classes').doc(classId)
      .collection('divisions').doc(divisionId)
      .collection('students').get();

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

  // POST — add students to division
  if (req.method === 'POST') {
    const { classId: cId, divisionId: dId, rolls } = req.body || {};
    if (!cId || !dId || !rolls) {
      return sendError(res, 400, 'classId, divisionId, and rolls are required');
    }

    const classDoc = await adminDb.collection('classes').doc(cId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const result = validateRollRange(rolls);
    if (!result.valid) return sendError(res, 400, result.error);

    const existingSnap = await adminDb.collection('classes').doc(cId)
      .collection('divisions').doc(dId)
      .collection('students').get();
    const existingRolls = new Set(existingSnap.docs.map(d => String(d.data().roll)));

    const newRolls = result.rolls.filter(r => !existingRolls.has(r));
    const studentsRef = adminDb.collection('classes').doc(cId)
      .collection('divisions').doc(dId).collection('students');

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

  // DELETE — remove student
  if (req.method === 'DELETE') {
    const studentId = req.query.studentId;
    if (!classId || !divisionId || !studentId) {
      return sendError(res, 400, 'classId, divisionId, and studentId are required');
    }

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

// ==========================================
// MAIN DIVISIONS CRUDS
// ==========================================
async function handleDivisions(req, res) {
  const { id, classId } = req.query;

  // DELETE division (with ID)
  if (id) {
    if (req.method !== 'DELETE') return sendError(res, 405, 'Method not allowed');
    if (!classId) return sendError(res, 400, 'classId is required');

    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    try {
      const divRef = adminDb.collection('classes').doc(classId)
        .collection('divisions').doc(id);
      const divSnap = await divRef.get();

      if (!divSnap.exists) return sendError(res, 404, 'Division not found');

      const joinCode = divSnap.data().joinCode;
      if (joinCode) {
        await adminDb.collection('joinCodes').doc(joinCode).delete();
      }

      const studentsSnap = await divRef.collection('students').get();
      const batch1 = adminDb.batch();
      studentsSnap.docs.forEach(doc => batch1.delete(doc.ref));
      if (studentsSnap.docs.length) await batch1.commit();

      const linksSnap = await adminDb.collection('studentLinks')
        .where('classId', '==', classId)
        .where('divisionId', '==', id).get();
      const batch2 = adminDb.batch();
      linksSnap.docs.forEach(doc => batch2.delete(doc.ref));
      if (linksSnap.docs.length) await batch2.commit();

      await divRef.delete();

      logAudit(req, 'DIVISION_DELETE', `classes/${classId}/divisions/${id}`,
        { name: divSnap.data().name });

      return sendSuccess(res, { deleted: true });
    } catch (err) {
      console.error('[divisions/delete] Error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  }

  // GET — list divisions
  if (req.method === 'GET') {
    if (!classId) return sendError(res, 400, 'classId is required');

    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const snap = await adminDb.collection('classes').doc(classId)
      .collection('divisions').get();
    const divisions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return sendSuccess(res, { divisions });
  }

  // POST — create division
  if (req.method === 'POST') {
    const { classId: cId, name } = req.body || {};
    const check = requireFields(req.body, ['classId', 'name']);
    if (!check.valid) return sendError(res, 400, `Missing: ${check.missing.join(', ')}`);

    const cleanName = sanitizeString(name, 100);
    if (!cleanName) return sendError(res, 400, 'Division name is required');

    const classDoc = await adminDb.collection('classes').doc(cId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const joinCode = generateJoinCode();

    const divRef = await adminDb.collection('classes').doc(cId)
      .collection('divisions').add({
        name: cleanName,
        joinCode,
        createdAt: FieldValue.serverTimestamp(),
      });

    await adminDb.collection('joinCodes').doc(joinCode).set({
      classId: cId,
      divisionId: divRef.id,
      createdAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'DIVISION_CREATE', `classes/${cId}/divisions/${divRef.id}`,
      { name: cleanName, joinCode });

    return sendCreated(res, { id: divRef.id, joinCode });
  }

  return sendError(res, 405, 'Method not allowed');
}

// Wrap sub-handlers with their specific middlewares & rate limits
const regenCodeHandler = withRateLimit(handleRegenCode, { max: 10, window: 60 });
const studentsHandler = withRateLimit(handleStudents, { max: 30, window: 60 });
const divisionsHandler = withRateLimit(handleDivisions, { max: 30, window: 60 });

async function mainHandler(req, res) {
  const { action } = req.query;

  if (action === 'regen-code') {
    return regenCodeHandler(req, res);
  } else if (action === 'students') {
    return studentsHandler(req, res);
  } else {
    return divisionsHandler(req, res);
  }
}

module.exports = withTeacher(mainHandler);
