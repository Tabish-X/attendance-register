'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withStudent } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { sanitizeString } = require('../_lib/validate');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * GET  /api/students/links  — List all divisions the student has joined
 * DELETE /api/students/links?linkId=xxx — Leave a division
 */
async function handler(req, res) {
  const uid = req.user.uid;

  // ═══════════════════════════════════════════════════════════════════════
  //  GET — List student links with enriched class/division names
  // ═══════════════════════════════════════════════════════════════════════
  if (req.method === 'GET') {
    try {
      const linksSnap = await adminDb
        .collection('studentLinks')
        .where('uid', '==', uid)
        .get();

      if (linksSnap.empty) {
        return sendSuccess(res, { links: [] });
      }

      // Fetch class & division names in parallel for each link
      const links = await Promise.all(
        linksSnap.docs.map(async (doc) => {
          const data = doc.data();
          const { classId, divisionId, roll } = data;

          let className = '';
          let divisionName = '';

          try {
            const [classSnap, divSnap] = await Promise.all([
              adminDb.collection('classes').doc(classId).get(),
              adminDb
                .collection('classes')
                .doc(classId)
                .collection('divisions')
                .doc(divisionId)
                .get(),
            ]);

            if (classSnap.exists) className = classSnap.data().name || '';
            if (divSnap.exists) divisionName = divSnap.data().name || '';
          } catch (_) {
            // If class/division was deleted, return empty names gracefully
          }

          return {
            id: doc.id,
            classId,
            divisionId,
            roll,
            className,
            divisionName,
          };
        })
      );

      return sendSuccess(res, { links });
    } catch (err) {
      console.error('students/links GET error:', err);
      return sendError(res, 500, 'Internal server error.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DELETE — Leave a division (remove link)
  // ═══════════════════════════════════════════════════════════════════════
  if (req.method === 'DELETE') {
    try {
      const linkId = sanitizeString(req.query?.linkId || '', 128);
      if (!linkId) {
        return sendError(res, 400, 'linkId query parameter is required.');
      }

      // ── Read & verify ownership ────────────────────────────────────
      const linkRef = adminDb.collection('studentLinks').doc(linkId);
      const linkSnap = await linkRef.get();

      if (!linkSnap.exists) {
        return sendError(res, 404, 'Link not found.');
      }

      const linkData = linkSnap.data();
      if (linkData.uid !== uid) {
        return sendError(res, 403, 'You do not own this link.');
      }

      const { classId, divisionId, roll } = linkData;

      // ── 1. Delete the studentLinks doc ─────────────────────────────
      await linkRef.delete();

      // ── 2. Unlink uid from division student subdoc ─────────────────
      try {
        const studentSubSnap = await adminDb
          .collection('classes')
          .doc(classId)
          .collection('divisions')
          .doc(divisionId)
          .collection('students')
          .where('roll', '==', roll)
          .where('uid', '==', uid)
          .limit(1)
          .get();

        if (!studentSubSnap.empty) {
          await studentSubSnap.docs[0].ref.update({ uid: null });
        }
      } catch (_) {
        // If the class/division was already deleted, continue cleanup
      }

      // ── 3. Remove from students/{uid}.linkedDivisions ──────────────
      try {
        const studentRef = adminDb.collection('students').doc(uid);
        const studentSnap = await studentRef.get();

        if (studentSnap.exists) {
          const currentLinks = studentSnap.data().linkedDivisions || [];
          const updated = currentLinks.filter(
            (l) =>
              !(
                l.classId === classId &&
                l.divisionId === divisionId &&
                l.roll === roll
              )
          );
          await studentRef.update({ linkedDivisions: updated });
        }
      } catch (_) {
        // Best-effort cleanup
      }

      // ── 4. Audit log ──────────────────────────────────────────────
      await logAudit({
        action: 'STUDENT_LEAVE',
        userId: uid,
        userEmail: req.user.email || '',
        userRole: 'student',
        targetResource: `classes/${classId}/divisions/${divisionId}`,
        details: { linkId, roll, classId, divisionId },
        ip:
          req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      });

      return sendSuccess(res, { message: 'Successfully left the division.' });
    } catch (err) {
      console.error('students/links DELETE error:', err);
      return sendError(res, 500, 'Internal server error.');
    }
  }

  return sendError(res, 405, 'Method not allowed');
}

module.exports = withRateLimit(withStudent(handler), { max: 30, window: 60 });
