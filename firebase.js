// ===== FIREBASE CLIENT — AUTH ONLY =====
// This file provides ONLY Firebase Authentication.
// All data operations go through the backend API (see api.js).
// No Firestore SDK is loaded in the browser.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "__FIREBASE_AUTH_DOMAIN__",
  projectId: "__FIREBASE_PROJECT_ID__",
  storageBucket: "__FIREBASE_STORAGE_BUCKET__",
  messagingSenderId: "__FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__FIREBASE_APP_ID__"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ===== AUTH HELPERS =====

// Sign in and return the user object
export async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

// Send verification email to the currently signed-in user
export async function sendVerificationEmail() {
  if (auth.currentUser) {
    await sendEmailVerification(auth.currentUser);
  }
}

// Sign out
export async function logoutUser() {
  await signOut(auth);
}

// Send password reset email
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

// Get the current user's ID token for API calls
export async function getIdToken() {
  if (!auth.currentUser) throw new Error("Not authenticated");
  return auth.currentUser.getIdToken();
}

// Re-export onAuthStateChanged for auth guards
export { onAuthStateChanged };
