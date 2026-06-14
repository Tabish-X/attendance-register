'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { logAudit } = require('../_lib/audit');

async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return sendError(res, 405, 'Method not allowed');
  }

  const divisionId = req.query.id;
  const classId = req.query.classId;

  if (!divisionId || !classId) {
    return sendError(res, 400, 'classId and division id are required');
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

    // Delete join code
    const joinCode = divSnap.data().joinCode;
    if (joinCode) {
      await adminDb.collection('joinCodes').doc(joinCode).delete();
    }

    // Delete students subcollection
    const studentsSnap = await divRef.collection('students').get();
    const batch1 = adminDb.batch();
    studentsSnap.docs.forEach(doc => batch1.delete(doc.ref));
    if (studentsSnap.docs.length) await batch1.commit();

    // Delete related studentLinks
    const linksSnap = await adminDb.collection('studentLinks')
      .where('classId', '==', classId)
      .where('divisionId', '==', divisionId).get();
    const batch2 = adminDb.batch();
    linksSnap.docs.forEach(doc => batch2.delete(doc.ref));
    if (linksSnap.docs.length) await batch2.commit();

    // Delete the division doc
    await divRef.delete();

    logAudit(req, 'DIVISION_DELETE', `classes/${classId}/divisions/${divisionId}`,
      { name: divSnap.data().name });

    return sendSuccess(res, { deleted: true });
  } catch (err) {
    console.error('[divisions/delete] Error:', err);
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = withRateLimit(withTeacher(handler), { max: 20, window: 60 });
