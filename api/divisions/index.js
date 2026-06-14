'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString, requireFields } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += JOIN_CODE_CHARS[crypto.randomInt(JOIN_CODE_CHARS.length)];
  }
  return code;
}

async function handler(req, res) {
  if (req.method === 'GET') {
    const classId = req.query.classId;
    if (!classId) return sendError(res, 400, 'classId is required');

    // Verify ownership
    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const snap = await adminDb.collection('classes').doc(classId)
      .collection('divisions').get();
    const divisions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return sendSuccess(res, { divisions });
  }

  if (req.method === 'POST') {
    const { classId, name } = req.body || {};
    const check = requireFields(req.body, ['classId', 'name']);
    if (!check.valid) return sendError(res, 400, `Missing: ${check.missing.join(', ')}`);

    const cleanName = sanitizeString(name, 100);
    if (!cleanName) return sendError(res, 400, 'Division name is required');

    // Verify ownership
    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const joinCode = generateJoinCode();

    const divRef = await adminDb.collection('classes').doc(classId)
      .collection('divisions').add({
        name: cleanName,
        joinCode,
        createdAt: FieldValue.serverTimestamp(),
      });

    // Store join code for fast lookup
    await adminDb.collection('joinCodes').doc(joinCode).set({
      classId,
      divisionId: divRef.id,
      createdAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'DIVISION_CREATE', `classes/${classId}/divisions/${divRef.id}`,
      { name: cleanName, joinCode });

    return sendCreated(res, { id: divRef.id, joinCode });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 30, window: 60 });
