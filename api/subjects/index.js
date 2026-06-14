'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString, requireFields } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

async function handler(req, res) {
  if (req.method === 'GET') {
    const { classId, divisionId } = req.query;

    if (classId && divisionId) {
      // Verify class ownership
      const classDoc = await adminDb.collection('classes').doc(classId).get();
      if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
        return sendError(res, 403, 'Access denied');
      }

      const snap = await adminDb.collection('subjects')
        .where('classId', '==', classId)
        .where('divisionId', '==', divisionId).get();
      const subjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return sendSuccess(res, { subjects });
    }

    // Return all teacher's subjects
    const snap = await adminDb.collection('subjects')
      .where('teacherUid', '==', req.user.uid).get();
    const subjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return sendSuccess(res, { subjects });
  }

  if (req.method === 'POST') {
    const { classId, divisionId, name } = req.body || {};
    const check = requireFields(req.body, ['classId', 'divisionId', 'name']);
    if (!check.valid) return sendError(res, 400, `Missing: ${check.missing.join(', ')}`);

    const cleanName = sanitizeString(name, 100);
    if (!cleanName) return sendError(res, 400, 'Subject name is required');

    // Verify class ownership
    const classDoc = await adminDb.collection('classes').doc(classId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    // Verify division exists
    const divDoc = await adminDb.collection('classes').doc(classId)
      .collection('divisions').doc(divisionId).get();
    if (!divDoc.exists) return sendError(res, 404, 'Division not found');

    const ref = await adminDb.collection('subjects').add({
      teacherUid: req.user.uid,
      classId,
      divisionId,
      name: cleanName,
      createdAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'SUBJECT_CREATE', `subjects/${ref.id}`,
      { name: cleanName, classId, divisionId });

    return sendCreated(res, { id: ref.id });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 30, window: 60 });
