'use strict';

const { adminAuth, adminDb, FieldValue } = require('./_lib/firebaseAdmin');
const { sendError, sendCreated, sendSuccess } = require('./_lib/errors');
const { withRateLimit } = require('./_lib/rateLimit');
const { withAuth } = require('./_lib/auth');
const { sanitizeString, validateEmail, requireFields } = require('./_lib/validate');
const { logAudit } = require('./_lib/audit');
const { verifyChecksum } = require('./_lib/checksum');

// ==========================================
// SIGNUP LOGIC
// ==========================================
async function handleSignup(req, res) {
  const { valid, missing } = requireFields(req.body, ['email', 'password', 'name', 'role']);
  if (!valid) {
    return sendError(res, 400, `Missing required fields: ${missing.join(', ')}`);
  }

  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password;
  const name = sanitizeString(req.body.name, 100);
  const role = (req.body.role || '').trim().toLowerCase();
  const teacherCode = (req.body.teacherCode || '').trim();

  if (!validateEmail(email)) {
    return sendError(res, 400, 'Invalid email address');
  }

  if (typeof password !== 'string' || password.length < 6) {
    return sendError(res, 400, 'Password must be at least 6 characters');
  }

  if (password.length > 128) {
    return sendError(res, 400, 'Password must not exceed 128 characters');
  }

  if (!name || name.length < 1) {
    return sendError(res, 400, 'Name is required and must be 1-100 characters');
  }

  if (role !== 'teacher' && role !== 'student') {
    return sendError(res, 400, 'Role must be "teacher" or "student"');
  }

  if (role === 'teacher') {
    const serverCode = process.env.TEACHER_SIGNUP_CODE;
    if (!serverCode) {
      console.error('[signup] TEACHER_SIGNUP_CODE env var is not set');
      return sendError(res, 500, 'Teacher registration is currently unavailable');
    }
    if (teacherCode !== serverCode) {
      return sendError(res, 403, 'Invalid teacher access code');
    }
  }

  let userRecord;
  try {
    userRecord = await adminAuth.createUser({
      email,
      password,
      displayName: name,
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      return await handleExistingEmail(req, res, email, password, name, role);
    }
    if (err.code === 'auth/invalid-email') return sendError(res, 400, 'Invalid email address');
    if (err.code === 'auth/invalid-password') return sendError(res, 400, 'Password does not meet requirements');

    console.error('[signup] Firebase Auth createUser error:', err.code, err.message);
    return sendError(res, 500, 'Failed to create account. Please try again later.');
  }

  try {
    await adminDb.collection('pendingUsers').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      role,
      name,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[signup] Failed to write pendingUsers doc:', err.message);
    try {
      await adminAuth.deleteUser(userRecord.uid);
    } catch (_) {}
    return sendError(res, 500, 'Failed to create account. Please try again later.');
  }

  if (role === 'teacher') {
    req.user = { uid: userRecord.uid, email, role };
    logAudit(req, 'TEACHER_SIGNUP', `pendingUsers/${userRecord.uid}`, { name });
  }

  return sendCreated(res, {
    message: 'Account created. Please check your email for verification.',
    uid: userRecord.uid,
  });
}

async function handleExistingEmail(req, res, email, password, name, role) {
  try {
    const existingUser = await adminAuth.getUserByEmail(email);

    if (existingUser.emailVerified) {
      return sendError(res, 409, 'An account with this email already exists');
    }

    const pendingDoc = await adminDb.collection('pendingUsers').doc(existingUser.uid).get();

    if (!pendingDoc.exists) {
      const userDoc = await adminDb.collection('users').doc(existingUser.uid).get();
      if (userDoc.exists) {
        return sendError(res, 409, 'An account with this email already exists');
      }
    } else {
      const pendingData = pendingDoc.data();
      if (pendingData.role !== role) {
        return sendError(res, 409, 'An account with this email already exists with a different role');
      }
    }

    await adminAuth.deleteUser(existingUser.uid);
    if (pendingDoc && pendingDoc.exists) {
      await adminDb.collection('pendingUsers').doc(existingUser.uid).delete();
    }

    const newUser = await adminAuth.createUser({
      email,
      password,
      displayName: name,
    });

    await adminDb.collection('pendingUsers').doc(newUser.uid).set({
      uid: newUser.uid,
      email,
      role,
      name,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (role === 'teacher') {
      req.user = { uid: newUser.uid, email, role };
      logAudit(req, 'TEACHER_SIGNUP', `pendingUsers/${newUser.uid}`, {
        name,
        note: 'Replaced unverified ghost account',
      });
    }

    return sendCreated(res, {
      message: 'Account created. Please check your email for verification.',
      uid: newUser.uid,
    });
  } catch (err) {
    console.error('[signup] Ghost account handling error:', err.message);
    return sendError(res, 409, 'An account with this email already exists');
  }
}

// ==========================================
// LOGIN CHECK LOGIC
// ==========================================
async function handleLoginCheck(req, res) {
  const uid = req.user.uid;

  try {
    const userSnap = await adminDb.collection('users').doc(uid).get();

    if (!userSnap.exists) {
      const pendingSnap = await adminDb.collection('pendingUsers').doc(uid).get();
      if (pendingSnap.exists) {
        const profileData = pendingSnap.data();
        await adminDb.collection('users').doc(uid).set(profileData);
        const roleCollection = profileData.role === 'teacher' ? 'teachers' : 'students';
        await adminDb.collection(roleCollection).doc(uid).set(profileData);
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

async function runTamperCheck(teacherUid) {
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
          subjectName: subDoc.data().name || 'Unknown',
          date: data.date,
          changedRolls: changedRolls.join(', ') || 'Unknown',
        });

        logAudit({ user: { uid: teacherUid, email: '', role: 'teacher' } },
          'TAMPER_DETECTED', `attendance/${attDoc.id}`,
          { subjectId, date: data.date, changedRolls });
      }
    }
  }

  return tampered;
}

// Wrap sub-handlers with their specific middlewares & rate limits
const signupHandler = withRateLimit(handleSignup, { max: 5, window: 900 });
const loginCheckHandler = withRateLimit(withAuth(handleLoginCheck), { max: 20, window: 900 });

// Combined serverless handler
async function mainHandler(req, res) {
  const { action } = req.query;

  if (action === 'signup') {
    return signupHandler(req, res);
  } else if (action === 'login-check') {
    return loginCheckHandler(req, res);
  }

  return sendError(res, 404, 'Not found');
}

module.exports = mainHandler;
