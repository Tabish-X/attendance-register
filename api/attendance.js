'use strict';

const { adminDb, FieldValue } = require('./_lib/firebaseAdmin');
const { withTeacher } = require('./_lib/auth');
const { sendSuccess, sendError } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');
const { validateDate, validateAttendanceRecords } = require('./_lib/validate');
const { generateChecksum, verifyChecksum } = require('./_lib/checksum');
const { logAudit } = require('./_lib/audit');

// ==========================================
// TAMPER CHECK LOGIC
// ==========================================
async function handleTamperCheck(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  try {
    const subjectsSnap = await adminDb.collection('subjects')
      .where('teacherUid', '==', req.user.uid).get();

    const tampered = [];
    const subjectDocs = subjectsSnap.docs;

    const attendanceSnapsList = await Promise.all(
      subjectDocs.map(subDoc =>
        adminDb.collection('attendance').where('subjectId', '==', subDoc.id).get()
      )
    );

    for (let i = 0; i < subjectDocs.length; i++) {
      const subDoc = subjectDocs[i];
      const subjectId = subDoc.id;
      const subjectName = subDoc.data().name || 'Unknown';
      const attendanceSnap = attendanceSnapsList[i];

      for (const attDoc of attendanceSnap.docs) {
        const data = attDoc.data();
        if (!data.checksum) continue;

        const records = data.records || {};
        const storedChecksum = data.checksum;

        const isHmac = /^[a-f0-9]{64}$/i.test(storedChecksum);
        let isTampered = false;
        let changedRolls = [];

        if (isHmac) {
          isTampered = !verifyChecksum(subjectId, data.date, records, storedChecksum);
          if (isTampered) changedRolls = ['Unknown (HMAC mismatch)'];
        } else {
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

// ==========================================
// SESSION DETAIL (WITH ID)
// ==========================================
async function handleSessionDetail(req, res) {
  const sessionId = req.query.id;

  const attDoc = await adminDb.collection('attendance').doc(sessionId).get();
  if (!attDoc.exists) return sendError(res, 404, 'Attendance session not found');

  const attData = attDoc.data();
  const subjectId = attData.subjectId;

  const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
  if (!subDoc.exists || subDoc.data().teacherUid !== req.user.uid) {
    return sendError(res, 403, 'Access denied');
  }

  // PUT — edit session
  if (req.method === 'PUT') {
    const { records } = req.body || {};
    if (!records) return sendError(res, 400, 'records is required');

    const recCheck = validateAttendanceRecords(records);
    if (!recCheck.valid) return sendError(res, 400, recCheck.error);

    const oldRecords = attData.records || {};
    const changes = [];
    for (const [roll, status] of Object.entries(records)) {
      if (oldRecords[roll] !== status) {
        changes.push({ roll, from: oldRecords[roll] || 'None', to: status });
      }
    }
    for (const roll of Object.keys(oldRecords)) {
      if (!records[roll]) {
        changes.push({ roll, from: oldRecords[roll], to: 'Removed' });
      }
    }

    const newChecksum = generateChecksum(subjectId, attData.date, records);

    await adminDb.collection('attendance').doc(sessionId).update({
      records,
      checksum: newChecksum,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'ATTENDANCE_EDIT', `attendance/${sessionId}`, { subjectId, date: attData.date, changes });
    return sendSuccess(res, { updated: true });
  }

  // DELETE — delete session
  if (req.method === 'DELETE') {
    await adminDb.collection('attendance').doc(sessionId).delete();
    logAudit(req, 'ATTENDANCE_DELETE', `attendance/${sessionId}`, { subjectId, date: attData.date });
    return sendSuccess(res, { deleted: true });
  }

  return sendError(res, 405, 'Method not allowed');
}

// ==========================================
// SESSION LIST / SAVE (WITHOUT ID)
// ==========================================
async function handleAttendanceList(req, res) {
  // GET — list sessions or get specific session
  if (req.method === 'GET') {
    const { subjectId, date } = req.query;
    if (!subjectId) return sendError(res, 400, 'subjectId is required');

    const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
    if (!subDoc.exists) return sendError(res, 404, 'Subject not found');
    if (subDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    if (date) {
      const sessionId = `${subjectId}_${date}`;
      const snap = await adminDb.collection('attendance').doc(sessionId).get();
      return sendSuccess(res, { session: snap.exists ? snap.data() : null });
    }

    const snap = await adminDb.collection('attendance')
      .where('subjectId', '==', subjectId).get();
    const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return sendSuccess(res, { sessions });
  }

  // POST — save attendance session
  if (req.method === 'POST') {
    const { subjectId, date, records } = req.body || {};
    if (!subjectId || !date || !records) {
      return sendError(res, 400, 'subjectId, date, and records are required');
    }

    if (!validateDate(date)) {
      return sendError(res, 400, 'Invalid date format. Use YYYY-MM-DD');
    }

    const recCheck = validateAttendanceRecords(records);
    if (!recCheck.valid) return sendError(res, 400, recCheck.error);

    const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
    if (!subDoc.exists) return sendError(res, 404, 'Subject not found');
    if (subDoc.data().teacherUid !== req.user.uid) {
      return sendError(res, 403, 'Access denied');
    }

    const checksum = generateChecksum(subjectId, date, records);
    const sessionId = `${subjectId}_${date}`;

    await adminDb.collection('attendance').doc(sessionId).set({
      subjectId,
      date,
      records,
      checksum,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logAudit(req, 'ATTENDANCE_SAVE', `attendance/${sessionId}`,
      { subjectId, date, rollCount: Object.keys(records).length });

    return sendSuccess(res, { saved: true, sessionId });
  }

  return sendError(res, 405, 'Method not allowed');
}

// Wrap handlers
const tamperCheckHandler = withRateLimit(handleTamperCheck, { max: 5, window: 60 });
const sessionDetailHandler = withRateLimit(handleSessionDetail, { max: 20, window: 60 });
const attendanceListHandler = withRateLimit(handleAttendanceList, { max: 30, window: 60 });

async function mainHandler(req, res) {
  const { action, id } = req.query;

  if (action === 'tamper-check') {
    return tamperCheckHandler(req, res);
  } else if (id) {
    return sessionDetailHandler(req, res);
  } else {
    return attendanceListHandler(req, res);
  }
}

module.exports = withTeacher(mainHandler);
