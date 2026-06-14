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

module.exports = withRateLimit(withStudent(handler), { max: 30, window: 60 });
