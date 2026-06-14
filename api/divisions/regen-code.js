'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
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
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const { classId, divisionId } = req.body || {};
  if (!classId || !divisionId) {
    return sendError(res, 400, 'classId and divisionId are required');
  }

  // Verify class ownership
  const classDoc = await adminDb.collection('classes').doc(classId).get();
  if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  try {
    const divRef = adminDb.collection('classes').doc(classId)
      .collection('divisions').doc(divisionId);
    const divSnap = await divRef.get();

    if (!divSnap.exists) {
      return sendError(res, 404, 'Division not found');
    }

    // Delete old join code
    const oldCode = divSnap.data().joinCode;
    if (oldCode) {
      await adminDb.collection('joinCodes').doc(oldCode).delete();
    }

    // Generate new code
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

module.exports = withRateLimit(withTeacher(handler), { max: 10, window: 60 });
