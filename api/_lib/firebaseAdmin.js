'use strict';

const admin = require('firebase-admin');

let _app = null;
let _auth = null;
let _db = null;

function getApp() {
  if (_app) return _app;

  const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountJSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJSON);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON: ' + err.message);
  }

  // Avoid double-initialization in hot-reload / warm-start scenarios
  if (admin.apps.length > 0) {
    _app = admin.apps[0];
  } else {
    _app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  return _app;
}

/**
 * Firebase Admin Auth instance (singleton).
 */
function getAuth() {
  if (_auth) return _auth;
  getApp();
  _auth = admin.auth();
  return _auth;
}

/**
 * Firestore instance (singleton).
 */
function getDb() {
  if (_db) return _db;
  getApp();
  _db = admin.firestore();
  return _db;
}

// Use lazy getters so the SDK is only initialized when first accessed.
// This avoids issues with env vars not being available at module load time
// in certain serverless runtimes.
Object.defineProperty(module.exports, 'adminAuth', {
  get: getAuth,
  enumerable: true,
});

Object.defineProperty(module.exports, 'adminDb', {
  get: getDb,
  enumerable: true,
});

// Also export FieldValue for convenience
Object.defineProperty(module.exports, 'FieldValue', {
  get: () => admin.firestore.FieldValue,
  enumerable: true,
});
