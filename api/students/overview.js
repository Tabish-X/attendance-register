'use strict';

const { adminDb } = require('../_lib/firebaseAdmin');
const { withStudent } = require('../_lib/auth');
const { sendSuccess, sendError } = require('../_lib/errors');
const { withRateLimit } = require('../_lib/rateLimit');

async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  const uid = req.user.uid;

  try {
    // Get profile
    const userDoc = await adminDb.collection('users').doc(uid).get();
    const profile = userDoc.exists ? userDoc.data() : {};
    const myRoll = profile.myRoll || null;

    // Get all student links
    const linksSnap = await adminDb.collection('studentLinks')
      .where('uid', '==', uid).get();

    const links = [];
    const subjects = [];

    for (const linkDoc of linksSnap.docs) {
      const linkData = linkDoc.data();
      const { classId, divisionId } = linkData;

      // Get class name
      let className = '';
      try {
        const classDoc = await adminDb.collection('classes').doc(classId).get();
        if (classDoc.exists) className = classDoc.data().name || '';
      } catch (_) {}

      // Get division name
      let divisionName = '';
      try {
        const divDoc = await adminDb.collection('classes').doc(classId)
          .collection('divisions').doc(divisionId).get();
        if (divDoc.exists) divisionName = divDoc.data().name || '';
      } catch (_) {}

      links.push({
        id: linkDoc.id,
        classId,
        divisionId,
        roll: linkData.roll,
        className,
        divisionName,
      });

      // Get all subjects for this division
      const subsSnap = await adminDb.collection('subjects')
        .where('classId', '==', classId)
        .where('divisionId', '==', divisionId).get();

      for (const subDoc of subsSnap.docs) {
        const subData = subDoc.data();

        // Get attendance for this subject filtered by student's roll
        const attSnap = await adminDb.collection('attendance')
          .where('subjectId', '==', subDoc.id).get();

        const records = [];
        for (const attDoc of attSnap.docs) {
          const attData = attDoc.data();
          const status = attData.records?.[String(myRoll || linkData.roll)];
          if (status) {
            records.push({ date: attData.date, status });
          }
        }
        records.sort((a, b) => a.date.localeCompare(b.date));

        // Calculate overall
        const present = records.filter(r => r.status === 'P').length;
        const total = records.length;
        const pct = total > 0 ? parseFloat(((present / total) * 100).toFixed(2)) : 0;

        // Calculate monthly breakdown
        const monthly = {};
        for (const r of records) {
          const month = r.date.slice(0, 7);
          if (!monthly[month]) monthly[month] = { present: 0, total: 0 };
          monthly[month].total++;
          if (r.status === 'P') monthly[month].present++;
        }
        for (const [k, v] of Object.entries(monthly)) {
          v.pct = parseFloat(((v.present / v.total) * 100).toFixed(2));
        }

        subjects.push({
          id: subDoc.id,
          name: subData.name,
          className,
          divisionName,
          classId,
          divisionId,
          overall: { present, total, pct },
          monthly,
          records,
        });
      }
    }

    return sendSuccess(res, {
      profile: {
        name: profile.name || '',
        email: profile.email || req.user.email,
        myRoll,
      },
      links,
      subjects,
    });
  } catch (err) {
    console.error('[overview] Error:', err);
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = withRateLimit(withStudent(handler), { max: 20, window: 60 });
