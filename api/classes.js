'use strict';

const { adminDb, FieldValue } = require('./_lib/firebaseAdmin');
const { withTeacher } = require('./_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');
const { sanitizeString, requireFields } = require('./_lib/validate');
const { logAudit } = require('./_lib/audit');

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

  // ── DETAIL ENDPOINTS (WITH ID) ──────────────────────────
  if (id) {
    // Verify ownership
    const classDoc = await adminDb.collection('classes').doc(id).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    // PUT — rename class
    if (req.method === 'PUT') {
      const { valid, missing } = requireFields(req.body, ['name']);
      if (!valid) {
        return sendError(res, 400, `Missing required fields: ${missing.join(', ')}`);
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

    // DELETE — delete class cascadingly
    if (req.method === 'DELETE') {
      let deletedDivisions = 0;
      let deletedStudents = 0;
      let deletedSubjects = 0;
      let deletedAttendance = 0;
      let deletedJoinCodes = 0;
      let deletedStudentLinks = 0;

      const divisionsSnap = await adminDb
        .collection('classes')
        .doc(id)
        .collection('divisions')
        .get();

      for (const divDoc of divisionsSnap.docs) {
        const divData = divDoc.data();

        const studentsQuery = adminDb
          .collection('classes')
          .doc(id)
          .collection('divisions')
          .doc(divDoc.id)
          .collection('students');
        deletedStudents += await deleteQueryInBatches(studentsQuery);

        if (divData.joinCode) {
          await adminDb.collection('joinCodes').doc(divData.joinCode).delete();
          deletedJoinCodes++;
        }

        const linksQuery = adminDb
          .collection('studentLinks')
          .where('classId', '==', id)
          .where('divisionId', '==', divDoc.id);
        deletedStudentLinks += await deleteQueryInBatches(linksQuery);

        await divDoc.ref.delete();
        deletedDivisions++;
      }

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

  // ── LIST / CREATE ENDPOINTS (WITHOUT ID) ──────────────────
  // GET — list all classes
  if (req.method === 'GET') {
    const snapshot = await adminDb
      .collection('classes')
      .where('teacherUid', '==', req.user.uid)
      .get();

    const classes = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })).sort((a, b) => {
      const tA = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt).getTime()) : 0;
      const tB = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt).getTime()) : 0;
      return tB - tA; // desc
    });

    return sendSuccess(res, { classes });
  }

  // POST — create new class
  if (req.method === 'POST') {
    const { valid, missing } = requireFields(req.body, ['name']);
    if (!valid) {
      return sendError(res, 400, `Missing required fields: ${missing.join(', ')}`);
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
