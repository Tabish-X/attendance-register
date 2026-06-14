'use strict';

const { adminDb, adminAuth } = require('../_lib/firebaseAdmin');
const { withAuth } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');
const { logAudit } = require('../_lib/audit');
const { FieldValue } = require('firebase-admin/firestore');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const uid = req.user.uid;

  try {
    // Check if profile already exists in users
    const userSnap = await adminDb.collection('users').doc(uid).get();

    if (!userSnap.exists) {
      // First verified login — migrate from pendingUsers to users
      const pendingSnap = await adminDb.collection('pendingUsers').doc(uid).get();
      if (pendingSnap.exists) {
        const profileData = pendingSnap.data();

        // 1. Save to users collection
        await adminDb.collection('users').doc(uid).set(profileData);

        // 2. Save to role-specific collection
        const roleCollection = profileData.role === 'teacher' ? 'teachers' : 'students';
        await adminDb.collection(roleCollection).doc(uid).set(profileData);

        // 3. Remove from pending
        await adminDb.collection('pendingUsers').doc(uid).delete();

        return sendSuccess(res, {
          role: profileData.role,
          name: profileData.name || '',
          email: profileData.email || req.user.email,
        });
      }

      return sendError(res, 404, 'Account not found. Please sign up first.');
    }

    const profile = userSnap.data();

    // For teachers, run tamper check
    let tampered = [];
    if (profile.role === 'teacher') {
      try {
        tampered = await runTamperCheck(uid);
      } catch (err) {
        console.error('[login-check] Tamper check error:', err.message);
      }
    }

    return sendSuccess(res, {
      role: profile.role,
      name: profile.name || '',
      email: profile.email || req.user.email,
      tampered,
    });
  } catch (err) {
    console.error('[login-check] Error:', err);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * Run tamper check across all subjects owned by a teacher.
 * Supports both legacy plain-text checksums and new HMAC-SHA256 checksums.
 */
async function runTamperCheck(teacherUid) {
  const { verifyChecksum } = require('../_lib/checksum');

  const subjectsSnap = await adminDb.collection('subjects')
    .where('teacherUid', '==', teacherUid).get();

  const tampered = [];

  for (const subDoc of subjectsSnap.docs) {
    const subjectId = subDoc.id;
    const attendanceSnap = await adminDb.collection('attendance')
      .where('subjectId', '==', subjectId).get();

    for (const attDoc of attendanceSnap.docs) {
      const data = attDoc.data();
      if (!data.checksum) continue;

      const records = data.records || {};
      const storedChecksum = data.checksum;

      // Determine if legacy or HMAC checksum
      const isHmac = /^[a-f0-9]{64}$/i.test(storedChecksum);

      let isTampered = false;
      let changedRolls = [];

      if (isHmac) {
        // HMAC-SHA256 — can only detect tampering, not which rolls
        isTampered = !verifyChecksum(subjectId, data.date, records, storedChecksum);
        if (isTampered) changedRolls = ['Unknown (HMAC mismatch)'];
      } else {
        // Legacy plain-text checksum
        const expected = Object.entries(records)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([roll, status]) => `${roll}:${status}`)
          .join('|');

        if (storedChecksum !== expected) {
          isTampered = true;
          // Parse old checksum to find specific changed rolls
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
          subjectName: subDoc.data().name || 'Unknown',
          date: data.date,
          changedRolls: changedRolls.join(', ') || 'Unknown',
        });

        // Log tamper detection
        logAudit({ user: { uid: teacherUid, email: '', role: 'teacher' } },
          'TAMPER_DETECTED', `attendance/${attDoc.id}`,
          { subjectId, date: data.date, changedRolls });
      }
    }
  }

  return tampered;
}

module.exports = withRateLimit(withAuth(handler), { max: 20, window: 900 });
