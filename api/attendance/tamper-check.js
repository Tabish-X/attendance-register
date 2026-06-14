'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withTeacher } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { verifyChecksum } = require('../_lib/checksum');
const { logAudit } = require('../_lib/audit');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  try {
    // Get all subjects owned by this teacher
    const subjectsSnap = await adminDb.collection('subjects')
      .where('teacherUid', '==', req.user.uid).get();

    const tampered = [];

    for (const subDoc of subjectsSnap.docs) {
      const subjectId = subDoc.id;
      const subjectName = subDoc.data().name || 'Unknown';

      const attendanceSnap = await adminDb.collection('attendance')
        .where('subjectId', '==', subjectId).get();

      for (const attDoc of attendanceSnap.docs) {
        const data = attDoc.data();
        if (!data.checksum) continue;

        const records = data.records || {};
        const storedChecksum = data.checksum;

        // Check if HMAC (64-char hex) or legacy plain-text
        const isHmac = /^[a-f0-9]{64}$/i.test(storedChecksum);
        let isTampered = false;
        let changedRolls = [];

        if (isHmac) {
          isTampered = !verifyChecksum(subjectId, data.date, records, storedChecksum);
          if (isTampered) changedRolls = ['Unknown (HMAC mismatch)'];
        } else {
          // Legacy plain-text checksum verification
          const expected = Object.entries(records)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([roll, status]) => `${roll}:${status}`)
            .join('|');

          if (storedChecksum !== expected) {
            isTampered = true;
            try {
              const storedPairs = {};
              storedChecksum.split('|').forEach(pair => {
                const [r, s] = pair.split(':');
                if (r) storedPairs[r] = s;
              });
              const changed = Object.entries(records)
                .filter(([roll, status]) => storedPairs[roll] !== status)
                .map(([roll]) => roll);
              const deletedRolls = Object.keys(storedPairs)
                .filter(r => !records[r]);
              changedRolls = [...new Set([...changed, ...deletedRolls])]
                .sort((a, b) => parseInt(a) - parseInt(b));
            } catch (_) {
              changedRolls = ['Unknown'];
            }
          }
        }

        if (isTampered) {
          tampered.push({
            subjectId,
            subjectName,
            classId: subDoc.data().classId,
            divisionId: subDoc.data().divisionId,
            date: data.date,
            changedRolls: changedRolls.join(', ') || 'Unknown',
          });

          logAudit(req, 'TAMPER_DETECTED', `attendance/${attDoc.id}`,
            { subjectId, date: data.date, changedRolls });
        }
      }
    }

    return sendSuccess(res, { tampered });
  } catch (err) {
    console.error('[tamper-check] Error:', err);
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = withRateLimit(withTeacher(handler), { max: 5, window: 60 });
