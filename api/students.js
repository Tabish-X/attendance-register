'use strict';

const { adminDb, FieldValue } = require('./_lib/firebaseAdmin');
const { withStudent } = require('./_lib/auth');
const { sendSuccess, sendError, sendCreated } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');
const { sanitizeString, validateJoinCode } = require('./_lib/validate');
const { logAudit } = require('./_lib/audit');

// ==========================================
// ROLL SET LOGIC
// ==========================================
async function handleRoll(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  try {
    const { roll } = req.body || {};
    const rollNum = Number(roll);
    if (
      roll === undefined ||
      roll === null ||
      !Number.isInteger(rollNum) ||
      rollNum < 1 ||
      rollNum > 9999
    ) {
      return sendError(res, 400, 'Roll number must be a positive integer between 1 and 9999.');
    }

    const uid = req.user.uid;
    const rollStr = String(rollNum);

    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) return sendError(res, 404, 'User profile not found.');

    const userData = userSnap.data();
    if (userData.myRoll && userData.myRoll !== '') {
      return sendError(res, 409, 'Roll number is already set and cannot be changed.');
    }

    await userRef.update({ myRoll: rollStr });

    const studentRef = adminDb.collection('students').doc(uid);
    const studentSnap = await studentRef.get();
    if (studentSnap.exists) {
      await studentRef.update({ myRoll: rollStr });
    }

    await logAudit({
      action: 'ROLL_SET',
      userId: uid,
      userEmail: req.user.email || '',
      userRole: 'student',
      targetResource: `users/${uid}`,
      details: { roll: rollStr },
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    });

    return sendSuccess(res, { roll: rollStr });
  } catch (err) {
    console.error('students/roll error:', err);
    return sendError(res, 500, 'Internal server error.');
  }
}

// ==========================================
// JOIN DIVISION LOGIC
// ==========================================
async function handleJoin(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');

  try {
    const { joinCode } = req.body || {};
    const uid = req.user.uid;

    if (!joinCode || typeof joinCode !== 'string') {
      return sendError(res, 400, 'Join code is required.');
    }

    const cleanCode = joinCode.trim().toUpperCase();

    if (!validateJoinCode(cleanCode)) {
      return sendError(res, 400, 'Invalid join code format.');
    }

    const codeSnap = await adminDb.collection('joinCodes').doc(cleanCode).get();
    if (!codeSnap.exists) {
      return sendError(res, 404, 'Join code not found. Please check the code and try again.');
    }

    const { classId, divisionId } = codeSnap.data();
    if (!classId || !divisionId) return sendError(res, 500, 'Internal server error.');

    const userSnap = await adminDb.collection('users').doc(uid).get();
    if (!userSnap.exists) return sendError(res, 404, 'User profile not found.');

    const myRoll = userSnap.data().myRoll;
    if (!myRoll || myRoll === '') return sendError(res, 400, 'Please set your roll number first.');

    const existingLinkSnap = await adminDb.collection('studentLinks')
      .where('uid', '==', uid)
      .where('classId', '==', classId)
      .where('divisionId', '==', divisionId)
      .limit(1).get();

    if (!existingLinkSnap.empty) return sendError(res, 409, 'You have already joined this division.');

    const rollTakenSnap = await adminDb.collection('studentLinks')
      .where('classId', '==', classId)
      .where('divisionId', '==', divisionId)
      .where('roll', '==', myRoll)
      .limit(1).get();

    if (!rollTakenSnap.empty) {
      const takenDoc = rollTakenSnap.docs[0].data();
      if (takenDoc.uid !== uid) {
        return sendError(res, 409, `Roll number ${myRoll} is already taken by another student in this division.`);
      }
    }

    await adminDb.collection('studentLinks').add({
      uid,
      classId,
      divisionId,
      roll: myRoll,
      joinCode: cleanCode,
      createdAt: FieldValue.serverTimestamp(),
    });

    const studentSubSnap = await adminDb.collection('classes')
      .doc(classId)
      .collection('divisions')
      .doc(divisionId)
      .collection('students')
      .where('roll', '==', myRoll)
      .limit(1).get();

    if (!studentSubSnap.empty) {
      await studentSubSnap.docs[0].ref.update({ uid });
    }

    const studentRef = adminDb.collection('students').doc(uid);
    const studentSnap = await studentRef.get();
    const linkEntry = { classId, divisionId, roll: myRoll };

    if (studentSnap.exists) {
      const currentLinks = studentSnap.data().linkedDivisions || [];
      const alreadyLinked = currentLinks.some(l => l.classId === classId && l.divisionId === divisionId);
      if (!alreadyLinked) {
        await studentRef.update({
          linkedDivisions: FieldValue.arrayUnion(linkEntry),
        });
      }
    }

    await logAudit({
      action: 'STUDENT_JOIN',
      userId: uid,
      userEmail: req.user.email || '',
      userRole: 'student',
      targetResource: `classes/${classId}/divisions/${divisionId}`,
      details: { roll: myRoll, joinCode: cleanCode },
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    });

    return sendSuccess(res);
  } catch (err) {
    console.error('students/join error:', err);
    return sendError(res, 500, 'Internal server error.');
  }
}

// ==========================================
// STUDENT LINKS LOGIC
// ==========================================
async function handleLinks(req, res) {
  const uid = req.user.uid;

  // GET student links
  if (req.method === 'GET') {
    try {
      const linksSnap = await adminDb.collection('studentLinks')
        .where('uid', '==', uid).get();

      if (linksSnap.empty) return sendSuccess(res, { links: [] });

      const links = await Promise.all(
        linksSnap.docs.map(async (doc) => {
          const data = doc.data();
          const { classId, divisionId, roll } = data;
          let className = '';
          let divisionName = '';

          try {
            const [classSnap, divSnap] = await Promise.all([
              adminDb.collection('classes').doc(classId).get(),
              adminDb.collection('classes').doc(classId).collection('divisions').doc(divisionId).get(),
            ]);

            if (classSnap.exists) className = classSnap.data().name || '';
            if (divSnap.exists) divisionName = divSnap.data().name || '';
          } catch (_) {}

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

  // DELETE student link (leave division)
  if (req.method === 'DELETE') {
    try {
      const linkId = sanitizeString(req.query?.linkId || '', 128);
      if (!linkId) return sendError(res, 400, 'linkId query parameter is required.');

      const linkRef = adminDb.collection('studentLinks').doc(linkId);
      const linkSnap = await linkRef.get();

      if (!linkSnap.exists) return sendError(res, 404, 'Link not found.');

      const linkData = linkSnap.data();
      if (linkData.uid !== uid) return sendError(res, 403, 'You do not own this link.');

      const { classId, divisionId, roll } = linkData;

      await linkRef.delete();

      try {
        const studentSubSnap = await adminDb.collection('classes')
          .doc(classId).collection('divisions').doc(divisionId)
          .collection('students').where('roll', '==', roll)
          .where('uid', '==', uid).limit(1).get();

        if (!studentSubSnap.empty) {
          await studentSubSnap.docs[0].ref.update({ uid: null });
        }
      } catch (_) {}

      try {
        const studentRef = adminDb.collection('students').doc(uid);
        const studentSnap = await studentRef.get();

        if (studentSnap.exists) {
          const currentLinks = studentSnap.data().linkedDivisions || [];
          const updated = currentLinks.filter(l => !(l.classId === classId && l.divisionId === divisionId && l.roll === roll));
          await studentRef.update({ linkedDivisions: updated });
        }
      } catch (_) {}

      await logAudit({
        action: 'STUDENT_LEAVE',
        userId: uid,
        userEmail: req.user.email || '',
        userRole: 'student',
        targetResource: `classes/${classId}/divisions/${divisionId}`,
        details: { linkId, roll, classId, divisionId },
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      });

      return sendSuccess(res, { message: 'Successfully left the division.' });
    } catch (err) {
      console.error('students/links DELETE error:', err);
      return sendError(res, 500, 'Internal server error.');
    }
  }

  return sendError(res, 405, 'Method not allowed');
}

// ==========================================
// OVERVIEW LOGIC
// ==========================================
async function handleOverview(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const uid = req.user.uid;

  try {
    const [userDoc, linksSnap] = await Promise.all([
      adminDb.collection('users').doc(uid).get(),
      adminDb.collection('studentLinks').where('uid', '==', uid).get(),
    ]);

    const profile = userDoc.exists ? userDoc.data() : {};
    const myRoll = profile.myRoll || null;
    const linksData = linksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Phase 2: Fetch classes, divisions, and subjects in parallel for all links
    const linkDetails = await Promise.all(
      linksData.map(async (link) => {
        const { classId, divisionId } = link;
        const [classDoc, divDoc, subsSnap] = await Promise.all([
          adminDb.collection('classes').doc(classId).get(),
          adminDb.collection('classes').doc(classId).collection('divisions').doc(divisionId).get(),
          adminDb.collection('subjects').where('classId', '==', classId).get(),
        ]);

        const className = classDoc.exists ? classDoc.data().name || '' : '';
        const divisionName = divDoc.exists ? divDoc.data().name || '' : '';

        return {
          link,
          className,
          divisionName,
          subjects: subsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
        };
      })
    );

    // Phase 3: Flatten subjects and fetch all attendance sessions in parallel
    const allSubjects = [];
    linkDetails.forEach((detail) => {
      detail.subjects.forEach((sub) => {
        allSubjects.push({
          sub,
          roll: myRoll || detail.link.roll,
          divisionId: detail.link.divisionId,
          className: detail.className,
          divisionName: detail.divisionName,
        });
      });
    });

    const attendanceSnaps = await Promise.all(
      allSubjects.map((item) =>
        adminDb.collection('attendance')
          .where('subjectId', '==', item.sub.id)
          .where('divisionId', '==', item.divisionId)
          .get()
      )
    );

    const subjects = allSubjects.map((item, idx) => {
      const { sub, roll, className, divisionName } = item;
      const attSnap = attendanceSnaps[idx];

      const records = [];
      for (const attDoc of attSnap.docs) {
        const attData = attDoc.data();
        const status = attData.records?.[String(roll)];
        if (status) {
          records.push({ date: attData.date, status });
        }
      }
      records.sort((a, b) => a.date.localeCompare(b.date));

      const present = records.filter(r => r.status === 'P').length;
      const total = records.length;
      const pct = total > 0 ? parseFloat(((present / total) * 100).toFixed(2)) : 0;

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

      return {
        id: sub.id,
        name: sub.name,
        className,
        divisionName,
        classId: sub.classId,
        divisionId: sub.divisionId,
        overall: { present, total, pct },
        monthly,
        records,
      };
    });

    const links = linkDetails.map((detail) => ({
      id: detail.link.id,
      classId: detail.link.classId,
      divisionId: detail.link.divisionId,
      roll: detail.link.roll,
      className: detail.className,
      divisionName: detail.divisionName,
    }));

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

// ==========================================
// SUBJECT ATTENDANCE LOGIC
// ==========================================
async function handleSubjectAttendance(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const { subjectId } = req.query;
  if (!subjectId) return sendError(res, 400, 'subjectId is required');

  const uid = req.user.uid;

  const subDoc = await adminDb.collection('subjects').doc(subjectId).get();
  if (!subDoc.exists) return sendError(res, 404, 'Subject not found');

  const { classId } = subDoc.data();

  const linksSnap = await adminDb.collection('studentLinks')
    .where('uid', '==', uid)
    .where('classId', '==', classId).get();

  if (linksSnap.empty) return sendError(res, 403, 'You are not linked to this class');

  const studentLink = linksSnap.docs[0].data();
  const divisionId = studentLink.divisionId;

  const userDoc = await adminDb.collection('users').doc(uid).get();
  const myRoll = userDoc.exists ? userDoc.data().myRoll : null;
  if (!myRoll) return sendError(res, 400, 'Roll number not set');

  const attSnap = await adminDb.collection('attendance')
    .where('subjectId', '==', subjectId)
    .where('divisionId', '==', divisionId).get();

  const records = [];
  for (const attDoc of attSnap.docs) {
    const data = attDoc.data();
    const status = data.records?.[String(myRoll)];
    if (status) {
      records.push({ date: data.date, status });
    }
  }
  records.sort((a, b) => a.date.localeCompare(b.date));

  const present = records.filter(r => r.status === 'P').length;
  const total = records.length;
  const pct = total > 0 ? parseFloat(((present / total) * 100).toFixed(2)) : 0;

  return sendSuccess(res, {
    records,
    overall: { present, total, pct },
  });
}

// ==========================================
// PROFILE LOGIC
// ==========================================
async function handleProfile(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const uid = req.user.uid;

  const userDoc = await adminDb.collection('users').doc(uid).get();
  const studentDoc = await adminDb.collection('students').doc(uid).get();

  const userData = userDoc.exists ? userDoc.data() : {};
  const studentData = studentDoc.exists ? studentDoc.data() : {};

  return sendSuccess(res, {
    name: userData.name || '',
    email: userData.email || req.user.email,
    myRoll: userData.myRoll || studentData.myRoll || null,
    linkedDivisions: studentData.linkedDivisions || [],
  });
}

// Wrap sub-handlers with their specific middlewares & rate limits
const rollHandler = withRateLimit(handleRoll, { max: 5, window: 60 });
const joinHandler = withRateLimit(handleJoin, { max: 10, window: 900 });
const linksHandler = withRateLimit(handleLinks, { max: 30, window: 60 });
const overviewHandler = withRateLimit(handleOverview, { max: 20, window: 60 });
const subjectAttendanceHandler = withRateLimit(handleSubjectAttendance, { max: 30, window: 60 });
const profileHandler = withRateLimit(handleProfile, { max: 30, window: 60 });

async function mainHandler(req, res) {
  const { action } = req.query;

  if (action === 'roll') {
    return rollHandler(req, res);
  } else if (action === 'join') {
    return joinHandler(req, res);
  } else if (action === 'links') {
    return linksHandler(req, res);
  } else if (action === 'overview') {
    return overviewHandler(req, res);
  } else if (action === 'subject-attendance') {
    return subjectAttendanceHandler(req, res);
  } else if (action === 'profile') {
    return profileHandler(req, res);
  }

  return sendError(res, 404, 'Not found');
}

module.exports = withStudent(mainHandler);
