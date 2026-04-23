// ===== FIREBASE CONFIG =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  deleteUser,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
export const db = getFirestore(app);

// ===== AUTH HELPERS =====

// Sign up a new user.
// If the email already exists but was NOT verified (blocked account), we delete
// that ghost account first so the real person can register with their own email.
export async function signupUser(email, password, role, extraData = {}) {
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, password);
  } catch (e) {
    if (e.code === "auth/email-already-in-use") {
      // Try to sign in to check if account is unverified
      let existing;
      try {
        existing = await signInWithEmailAndPassword(auth, email, password);
      } catch (_) {
        // Wrong password — a real account exists with a different password
        throw new Error("This email is already registered. Please sign in instead.");
      }
      if (existing.user.emailVerified) {
        // Real verified account — do not touch it
        await signOut(auth);
        throw new Error("This email is already registered and verified. Please sign in instead.");
      }
      // Unverified ghost account — delete it so the real user can register
      await deleteUser(existing.user);
      // Now create fresh
      cred = await createUserWithEmailAndPassword(auth, email, password);
    } else {
      throw e;
    }
  }

  await sendEmailVerification(cred.user);

  // Save a PENDING profile — will be confirmed on first verified login
  await setDoc(doc(db, "pendingUsers", cred.user.uid), {
    uid: cred.user.uid,
    email,
    role,
    createdAt: serverTimestamp(),
    ...extraData,
  });

  return cred.user;
}

// Login. On first login after email verification, move pendingUsers -> users
// and also write to the role-specific collection (teachers or students).
export async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const user = cred.user;

  if (user.emailVerified) {
    // Check if profile already exists in users
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (!userSnap.exists()) {
      // First verified login — move from pendingUsers to users
      const pendingSnap = await getDoc(doc(db, "pendingUsers", user.uid));
      if (pendingSnap.exists()) {
        const profileData = pendingSnap.data();

        // 1. Save to users collection (for auth/login checks)
        await setDoc(doc(db, "users", user.uid), profileData);

        // 2. Also save to role-specific collection
        const roleCollection = profileData.role === "teacher" ? "teachers" : "students";
        await setDoc(doc(db, roleCollection, user.uid), profileData);

        // 3. Remove from pending
        await deleteDoc(doc(db, "pendingUsers", user.uid));
      }
    }
  }

  return user;
}

export async function logoutUser() {
  await signOut(auth);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// ===== CLASS HELPERS =====

export async function createClass(teacherUid, name) {
  const ref = await addDoc(collection(db, "classes"), {
    teacherUid,
    name,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getTeacherClasses(teacherUid) {
  const q = query(collection(db, "classes"), where("teacherUid", "==", teacherUid));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteClass(classId) {
  await deleteDoc(doc(db, "classes", classId));
}

export async function updateClassName(classId, name) {
  await updateDoc(doc(db, "classes", classId), { name });
}

// ===== DIVISION HELPERS =====

export async function addDivision(classId, divisionName) {
  const joinCode = generateCode(); // 6-char join code
  const ref = await addDoc(collection(db, "classes", classId, "divisions"), {
    name: divisionName,
    joinCode,
    createdAt: serverTimestamp(),
  });
  // Also store joinCode -> {classId, divisionId} for fast lookup by students
  await setDoc(doc(db, "joinCodes", joinCode), {
    classId,
    divisionId: ref.id,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getDivisions(classId) {
  const snap = await getDocs(collection(db, "classes", classId, "divisions"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteDivision(classId, divisionId) {
  // Also remove the joinCode doc
  const divSnap = await getDoc(doc(db, "classes", classId, "divisions", divisionId));
  if (divSnap.exists() && divSnap.data().joinCode) {
    await deleteDoc(doc(db, "joinCodes", divSnap.data().joinCode));
  }
  await deleteDoc(doc(db, "classes", classId, "divisions", divisionId));
}

// Regenerate a new join code for a division (old one becomes invalid)
export async function regenerateJoinCode(classId, divisionId) {
  const divRef = doc(db, "classes", classId, "divisions", divisionId);
  const divSnap = await getDoc(divRef);
  if (!divSnap.exists()) throw new Error("Division not found.");

  // Delete old join code doc
  const oldCode = divSnap.data().joinCode;
  if (oldCode) {
    await deleteDoc(doc(db, "joinCodes", oldCode));
  }

  const newCode = generateCode();
  await updateDoc(divRef, { joinCode: newCode });
  await setDoc(doc(db, "joinCodes", newCode), {
    classId,
    divisionId,
    createdAt: serverTimestamp(),
  });
  return newCode;
}

// Look up classId + divisionId from a join code
export async function getDivisionByJoinCode(code) {
  const clean = code.trim().toUpperCase();
  const snap = await getDoc(doc(db, "joinCodes", clean));
  if (!snap.exists()) throw new Error("Join code not found. Please check the code and try again.");
  return snap.data(); // { classId, divisionId }
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,O,1,I to avoid confusion
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ===== STUDENT (ROLL NUMBER) HELPERS =====

export async function addStudentsToDivision(classId, divisionId, rollNumbers) {
  const existing = await getDivisionStudents(classId, divisionId);
  const existingRolls = new Set(existing.map(s => String(s.roll)));
  const batch = [];
  for (const roll of rollNumbers) {
    if (existingRolls.has(String(roll))) continue;
    batch.push(
      addDoc(collection(db, "classes", classId, "divisions", divisionId, "students"), {
        roll: String(roll),
        uid: null,
        createdAt: serverTimestamp(),
      })
    );
  }
  await Promise.all(batch);
}

export async function getDivisionStudents(classId, divisionId) {
  const snap = await getDocs(
    collection(db, "classes", classId, "divisions", divisionId, "students")
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteStudent(classId, divisionId, studentDocId) {
  await deleteDoc(
    doc(db, "classes", classId, "divisions", divisionId, "students", studentDocId)
  );
}

// ===== STUDENT LINK SYSTEM =====
// New design:
//   - Student sets their roll number ONCE (saved in their users doc as myRoll)
//   - Student can join MULTIPLE divisions using only a 6-char join code
//   - All these divisions appear in their dashboard
//   - Roll number cannot be changed after being set
//   - Cannot join the same division twice

// Set the student's roll number (only allowed once)
export async function setStudentRoll(uid, roll) {
  const snap = await getDoc(doc(db, "users", uid));
  if (snap.exists() && snap.data().myRoll) {
    throw new Error("Roll number is already set and cannot be changed.");
  }
  // Update in users collection
  await updateDoc(doc(db, "users", uid), { myRoll: String(roll) });
  // Also update in students collection so it shows in Firestore students panel
  const studentsSnap = await getDoc(doc(db, "students", uid));
  if (studentsSnap.exists()) {
    await updateDoc(doc(db, "students", uid), { myRoll: String(roll) });
  }
}

// Join a division using a 6-char join code
// Student must have set their roll number first
// Returns error if roll is already taken in that division by another student
export async function joinDivisionByCode(uid, joinCode, myRoll) {
  // 1. Lookup division
  const divInfo = await getDivisionByJoinCode(joinCode);
  const { classId, divisionId } = divInfo;

  // 2. Check not already joined
  const existing = await findStudentLinks(uid);
  const alreadyJoined = existing.some(
    l => l.classId === classId && l.divisionId === divisionId
  );
  if (alreadyJoined) {
    throw new Error("You have already joined this division.");
  }

  // 3. Check roll not taken by another student in this division
  const taken = await isRollTakenInDivision(classId, divisionId, myRoll, uid);
  if (taken) {
    throw new Error(
      "Roll number " + myRoll + " is already taken by another student in this division. " +
      "Please check your roll number or contact your teacher."
    );
  }

  // 4. Save link
  await addDoc(collection(db, "studentLinks"), {
    uid,
    classId,
    divisionId,
    roll: String(myRoll),
    joinCode: joinCode.trim().toUpperCase(),
    createdAt: serverTimestamp(),
  });

  // 5. Update uid in the students sub-doc so teacher sees "Linked"
  const studentsSnap = await getDocs(
    collection(db, "classes", classId, "divisions", divisionId, "students")
  );
  for (const docSnap of studentsSnap.docs) {
    if (String(docSnap.data().roll) === String(myRoll)) {
      await updateDoc(
        doc(db, "classes", classId, "divisions", divisionId, "students", docSnap.id),
        { uid }
      );
      break;
    }
  }

  // 6. Also update the top-level students collection doc so roll numbers
  //    are visible in the Firestore students panel
  const studentProfileSnap = await getDoc(doc(db, "students", uid));
  if (studentProfileSnap.exists()) {
    const existingLinks = studentProfileSnap.data().linkedDivisions || [];
    // Avoid duplicates
    const alreadyHas = existingLinks.some(
      l => l.classId === classId && l.divisionId === divisionId
    );
    if (!alreadyHas) {
      await updateDoc(doc(db, "students", uid), {
        linkedDivisions: [
          ...existingLinks,
          { classId, divisionId, roll: String(myRoll) }
        ]
      });
    }
  }
}

async function isRollTakenInDivision(classId, divisionId, roll, myUid) {
  const q = query(
    collection(db, "studentLinks"),
    where("classId", "==", classId),
    where("divisionId", "==", divisionId),
    where("roll", "==", String(roll))
  );
  const snap = await getDocs(q);
  // Allow if the only match is this student's own uid
  for (const d of snap.docs) {
    if (d.data().uid !== myUid) return true;
  }
  return false;
}

// Get all division links for a student
export async function findStudentLinks(uid) {
  const q = query(collection(db, "studentLinks"), where("uid", "==", uid));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Remove a student's link to a division
export async function removeStudentLink(linkDocId) {
  await deleteDoc(doc(db, "studentLinks", linkDocId));
}

// ===== SUBJECT HELPERS =====

export async function createSubject(teacherUid, classId, divisionId, subjectName) {
  const ref = await addDoc(collection(db, "subjects"), {
    teacherUid,
    classId,
    divisionId,
    name: subjectName,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getTeacherSubjects(teacherUid) {
  const q = query(collection(db, "subjects"), where("teacherUid", "==", teacherUid));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getDivisionSubjects(classId, divisionId) {
  const q = query(
    collection(db, "subjects"),
    where("classId", "==", classId),
    where("divisionId", "==", divisionId)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteSubject(subjectId) {
  await deleteDoc(doc(db, "subjects", subjectId));
}

export async function updateSubjectName(subjectId, name) {
  await updateDoc(doc(db, "subjects", subjectId), { name });
}

// ===== ATTENDANCE HELPERS =====

export async function saveAttendanceSession(subjectId, date, records) {
  const sessionId = `${subjectId}_${date}`;
  // Simple checksum: sorted "roll:status" pairs joined, then stored
  const checksum = Object.entries(records)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([roll, status]) => `${roll}:${status}`)
    .join("|");
  await setDoc(doc(db, "attendance", sessionId), {
    subjectId,
    date,
    records,
    checksum,
    updatedAt: serverTimestamp(),
  });
}

export async function getAttendanceSession(subjectId, date) {
  const sessionId = `${subjectId}_${date}`;
  const snap = await getDoc(doc(db, "attendance", sessionId));
  return snap.exists() ? snap.data() : null;
}

export async function getSubjectAttendance(subjectId) {
  const q = query(collection(db, "attendance"), where("subjectId", "==", subjectId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function deleteAttendanceSession(subjectId, date) {
  const sessionId = `${subjectId}_${date}`;
  await deleteDoc(doc(db, "attendance", sessionId));
}

// ===== STUDENT ATTENDANCE VIEW =====

export async function getStudentAttendanceForSubject(subjectId, roll) {
  const allSessions = await getSubjectAttendance(subjectId);
  const result = [];
  for (const session of allSessions) {
    const status = session.records?.[String(roll)] || null;
    if (status) {
      result.push({ date: session.date, status });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

// ===== UTILITY =====

export function parseRollRange(input) {
  const rolls = new Set();
  const parts = input.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(s => parseInt(s.trim()));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) rolls.add(String(i));
      }
    } else {
      const n = parseInt(trimmed);
      if (!isNaN(n)) rolls.add(String(n));
    }
  }
  return [...rolls].sort((a, b) => parseInt(a) - parseInt(b));
}

export function calcAttendancePct(records) {
  if (!records.length) return { pct: 0, present: 0, total: 0 };
  const present = records.filter(r => r.status === "P").length;
  const total = records.length;
  const pct = parseFloat(((present / total) * 100).toFixed(2));
  return { pct, present, total };
}

export function groupByMonth(records) {
  const groups = {};
  for (const r of records) {
    const month = r.date.slice(0, 7);
    if (!groups[month]) groups[month] = [];
    groups[month].push(r);
  }
  return groups;
}

export function formatMonthLabel(yyyymm) {
  const [y, m] = yyyymm.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m) - 1]} ${y}`;
}

export function formatDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[parseInt(m)-1]} ${y}`;
}

export { onAuthStateChanged, doc, db as _db };

// ===== TAMPER CHECK ON LOGIN =====
// Call this after login with all of the teacher's subject IDs.
// Returns array of tampered session info, or empty array if all clean.
export async function checkTamperOnLogin(subjectIds) {
  const tampered = [];
  for (const subjectId of subjectIds) {
    const q = query(collection(db, "attendance"), where("subjectId", "==", subjectId));
    const snap = await getDocs(q);
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      if (!data.checksum) continue; // old session before checksums were added — skip
      // Re-compute expected checksum from current records
      const expected = Object.entries(data.records || {})
        .sort(([a],[b]) => a.localeCompare(b))
        .map(([roll, status]) => `${roll}:${status}`)
        .join("|");
      if (data.checksum !== expected) {
        tampered.push({ subjectId, date: data.date });
      }
    }
  }
  return tampered;
}
