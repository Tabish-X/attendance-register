const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString, requireFields } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

async function handler(req, res) {
  // GET — list all classes owned by the authenticated teacher
  if (req.method === 'GET') {
    const snapshot = await adminDb
      .collection('classes')
      .where('teacherUid', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();

    const classes = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return sendSuccess(res, classes);
  }

  // POST — create a new class
  if (req.method === 'POST') {
    const missing = requireFields(req.body, ['name']);
    if (missing) {
      return sendError(res, 400, `Missing required field: ${missing}`);
    }

    const name = sanitizeString(req.body.name, 100);
    if (!name) {
      return sendError(res, 400, 'Class name is required (max 100 characters)');
    }

    const docRef = await adminDb.collection('classes').add({
      teacherUid: req.user.uid,
      name,
      createdAt: FieldValue.serverTimestamp(),
    });

    await logAudit(req, 'CLASS_CREATE', `classes/${docRef.id}`, { name });

    return sendCreated(res, { id: docRef.id });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 30, window: 60 });
