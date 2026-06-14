const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString, requireFields } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * Delete all documents in a collection/query in chunked batches.
 * Firestore batches are limited to 500 operations.
 */
async function deleteQueryInBatches(query) {
  let totalDeleted = 0;
  let snapshot = await query.limit(450).get();

  while (!snapshot.empty) {
    const batch = adminDb.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    totalDeleted += snapshot.size;
    snapshot = await query.limit(450).get();
  }

  return totalDeleted;
}

async function handler(req, res) {
  const { id } = req.query;
  if (!id) {
    return sendError(res, 400, 'Missing class ID');
  }

  // Verify ownership
  const classDoc = await adminDb.collection('classes').doc(id).get();
  if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  // PUT — rename a class
  if (req.method === 'PUT') {
    const missing = requireFields(req.body, ['name']);
    if (missing) {
      return sendError(res, 400, `Missing required field: ${missing}`);
    }

    const name = sanitizeString(req.body.name, 100);
    if (!name) {
      return sendError(res, 400, 'Class name is required (max 100 characters)');
    }

    await adminDb.collection('classes').doc(id).update({
      name,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await logAudit(req, 'CLASS_UPDATE', `classes/${id}`, { name });

    return sendSuccess(res, { message: 'Class updated' });
  }

  // DELETE — cascading delete of class + all child data
  if (req.method === 'DELETE') {
    let deletedDivisions = 0;
    let deletedStudents = 0;
    let deletedSubjects = 0;
    let deletedAttendance = 0;
    let deletedJoinCodes = 0;
    let deletedStudentLinks = 0;

    // ── Step 1: Delete all divisions and their child data ──
    const divisionsSnap = await adminDb
      .collection('classes')
      .doc(id)
      .collection('divisions')
      .get();

    for (const divDoc of divisionsSnap.docs) {
      const divData = divDoc.data();

      // Delete students subcollection
      const studentsQuery = adminDb
        .collection('classes')
        .doc(id)
        .collection('divisions')
        .doc(divDoc.id)
        .collection('students');
      deletedStudents += await deleteQueryInBatches(studentsQuery);

      // Delete joinCode lookup doc
      if (divData.joinCode) {
        await adminDb.collection('joinCodes').doc(divData.joinCode).delete();
        deletedJoinCodes++;
      }

      // Delete studentLinks referencing this class + division
      const linksQuery = adminDb
        .collection('studentLinks')
        .where('classId', '==', id)
        .where('divisionId', '==', divDoc.id);
      deletedStudentLinks += await deleteQueryInBatches(linksQuery);

      // Delete the division doc itself
      await divDoc.ref.delete();
      deletedDivisions++;
    }

    // ── Step 2: Delete all subjects + their attendance ──
    const subjectsSnap = await adminDb
      .collection('subjects')
      .where('classId', '==', id)
      .get();

    for (const subDoc of subjectsSnap.docs) {
      const attQuery = adminDb
        .collection('attendance')
        .where('subjectId', '==', subDoc.id);
      deletedAttendance += await deleteQueryInBatches(attQuery);

      await subDoc.ref.delete();
      deletedSubjects++;
    }

    // ── Step 3: Delete the class doc ──
    await adminDb.collection('classes').doc(id).delete();

    const details = {
      deletedDivisions,
      deletedStudents,
      deletedSubjects,
      deletedAttendance,
      deletedJoinCodes,
      deletedStudentLinks,
    };

    await logAudit(req, 'CLASS_DELETE', `classes/${id}`, details);

    return sendSuccess(res, {
      message: 'Class and all related data deleted',
      ...details,
    });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withTeacher(handler), { max: 20, window: 60 });
