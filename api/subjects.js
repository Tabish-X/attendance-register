'use strict';

const { adminDb, FieldValue } = require('./_lib/firebaseAdmin');
const { withAuth } = require('./_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');
const { sanitizeString, requireFields } = require('./_lib/validate');
const { logAudit } = require('./_lib/audit');

async function handler(req, res) {
  const { id, classId, divisionId } = req.query;

  // ── DETAIL ENDPOINTS (WITH ID) ──────────────────────────
  if (id) {
    // Both PUT and DELETE require teacher role and ownership
    if (req.user.role !== 'teacher') return sendError(res, 403, 'Forbidden');

    const subDoc = await adminDb.collection('subjects').doc(id).get();
    if (!subDoc.exists) return sendError(res, 404, 'Subject not found');
    if (subDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    // PUT — rename subject
    if (req.method === 'PUT') {
      const { name } = req.body || {};
      const cleanName = sanitizeString(name, 100);
      if (!cleanName) return sendError(res, 400, 'Subject name is required');

      await adminDb.collection('subjects').doc(id).update({ name: cleanName });
      return sendSuccess(res, { updated: true });
    }

    // DELETE — delete subject
    if (req.method === 'DELETE') {
      const attSnap = await adminDb.collection('attendance')
        .where('subjectId', '==', id).get();

      let deletedSessions = 0;
      const batchSize = 400;
      const docs = attSnap.docs;
      for (let i = 0; i < docs.length; i += batchSize) {
        const batch = adminDb.batch();
        docs.slice(i, i + batchSize).forEach(d => batch.delete(d.ref));
        await batch.commit();
        deletedSessions += Math.min(batchSize, docs.length - i);
      }

      await adminDb.collection('subjects').doc(id).delete();

      logAudit(req, 'SUBJECT_DELETE', `subjects/${id}`,
        { name: subDoc.data().name, deletedSessions });

      return sendSuccess(res, { deleted: true, deletedSessions });
    }

    return sendError(res, 405, 'Method not allowed');
  }

  // ── LIST / CREATE ENDPOINTS (WITHOUT ID) ──────────────────
  // GET — list subjects
  if (req.method === 'GET') {
    if (classId) {
      // If student, verify link to division or class
      if (req.user.role === 'student') {
        let query = adminDb.collection('studentLinks')
          .where('uid', '==', req.user.uid)
          .where('classId', '==', classId);
        if (divisionId) {
          query = query.where('divisionId', '==', divisionId);
        }
        const linkSnap = await query.limit(1).get();
        if (linkSnap.empty) {
          return sendError(res, 403, 'Access denied: not linked to this class/division');
        }
      } else if (req.user.role === 'teacher') {
        // If teacher, verify class ownership
        const classDoc = await adminDb.collection('classes').doc(classId).get();
        if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
          return sendError(res, 403, 'Access denied');
        }
      } else {
        return sendError(res, 403, 'Forbidden');
      }

      const snap = await adminDb.collection('subjects')
        .where('classId', '==', classId).get();
      const subjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return sendSuccess(res, { subjects });
    }

    // Get all teacher's subjects (requires teacher role)
    if (req.user.role !== 'teacher') return sendError(res, 403, 'Forbidden');

    const snap = await adminDb.collection('subjects')
      .where('teacherUid', '==', req.user.uid).get();
    const subjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return sendSuccess(res, { subjects });
  }

  // POST — create new subject (requires teacher role)
  if (req.method === 'POST') {
    if (req.user.role !== 'teacher') return sendError(res, 403, 'Forbidden');

    const { classId: cId, name } = req.body || {};
    const check = requireFields(req.body, ['classId', 'name']);
    if (!check.valid) return sendError(res, 400, `Missing: ${check.missing.join(', ')}`);

    const cleanName = sanitizeString(name, 100);
    if (!cleanName) return sendError(res, 400, 'Subject name is required');

    // Verify class ownership
    const classDoc = await adminDb.collection('classes').doc(cId).get();
    if (!classDoc.exists || classDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const ref = await adminDb.collection('subjects').add({
      teacherUid: req.user.uid,
      classId: cId,
      name: cleanName,
      createdAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'SUBJECT_CREATE', `subjects/${ref.id}`,
      { name: cleanName, classId: cId });

    return sendCreated(res, { id: ref.id });
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withAuth(handler), { max: 30, window: 60 });
