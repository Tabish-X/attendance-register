'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');

async function handler(req, res) {
  const subjectId = req.query.id;
  if (!subjectId) return sendError(res, 400, 'Subject id is required');

  // Read subject and verify ownership
  const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
  if (!subDoc.exists) return sendError(res, 404, 'Subject not found');
  if (subDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  if (req.method === 'PUT') {
    const { name } = req.body || {};
    const cleanName = sanitizeString(name, 100);
    if (!cleanName) return sendError(res, 400, 'Subject name is required');

    await adminDb.collection('subjects').doc(subjectId).update({ name: cleanName });
    return sendSuccess(res, { updated: true });
  }

  if (req.method === 'DELETE') {
    // Cascading delete: remove all attendance sessions for this subject
    const attSnap = await adminDb.collection('attendance')
      .where('subjectId', '==', subjectId).get();

    let deletedSessions = 0;
    const batchSize = 400;
    const docs = attSnap.docs;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = adminDb.batch();
      docs.slice(i, i + batchSize).forEach(d => batch.delete(d.ref));
      await batch.commit();
      deletedSessions += Math.min(batchSize, docs.length - i);
    }

    // Delete the subject
    await adminDb.collection('subjects').doc(subjectId).delete();

    logAudit(req, 'SUBJECT_DELETE', `subjects/${subjectId}`,
      { name: subDoc.data().name, deletedSessions });

    return sendSuccess(res, { deleted: true, deletedSessions });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 20, window: 60 });
