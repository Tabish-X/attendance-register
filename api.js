// ===== ATTENDIFY API CLIENT =====
// All data operations go through the secure backend API.
// This module replaces the old firebase.js data layer.
// The backend verifies auth, ownership, and permissions
// for every request — the browser is just a presentation layer.

import { auth } from "./firebase.js";

// ===== CORE API HELPER =====

async function apiCall(method, path, body = null) {
  const token = await auth.currentUser.getIdToken();
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== null && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/${path}`, opts);
  let data = {};
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Server returned non-JSON response: ${text.slice(0, 150)}... (Status ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status}) on ${method} ${path}`);
  }
  return data;
}

// ===== AUTH =====

export async function signupUser(email, password, name, role, teacherCode = null) {
  // Signup does NOT require auth (user doesn't have an account yet)
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name, role, teacherCode }),
  });
  let data = {};
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Server returned non-JSON response: ${text.slice(0, 150)}... (Status ${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || `Signup failed (${res.status})`);
  return data;
}

export async function loginCheck() {
  return apiCall("POST", "auth/login-check");
}

export async function getUserProfile() {
  return apiCall("GET", "students/profile");
}

// ===== CLASSES =====

export async function createClass(name) {
  return apiCall("POST", "classes", { name });
}

export async function getTeacherClasses() {
  const data = await apiCall("GET", "classes");
  return data.classes || [];
}

export async function updateClassName(classId, name) {
  return apiCall("PUT", `classes/${classId}`, { name });
}

export async function deleteClass(classId) {
  return apiCall("DELETE", `classes/${classId}`);
}

// ===== DIVISIONS =====

export async function addDivision(classId, name) {
  return apiCall("POST", "divisions", { classId, name });
}

export async function getDivisions(classId) {
  const data = await apiCall("GET", `divisions?classId=${classId}`);
  return data.divisions || [];
}

export async function deleteDivision(classId, divisionId) {
  return apiCall("DELETE", `divisions/${divisionId}?classId=${classId}`);
}

export async function regenerateJoinCode(classId, divisionId) {
  const data = await apiCall("POST", "divisions/regen-code", { classId, divisionId });
  return data.joinCode;
}

// ===== DIVISION STUDENTS (ROLL NUMBERS) =====

export async function addStudentsToDivision(classId, divisionId, rolls) {
  return apiCall("POST", "divisions/students", {
    classId,
    divisionId,
    rolls: Array.isArray(rolls) ? rolls.join(",") : rolls,
  });
}

export async function getDivisionStudents(classId, divisionId) {
  const data = await apiCall("GET", `divisions/students?classId=${classId}&divisionId=${divisionId}`);
  return data.students || [];
}

export async function deleteStudent(classId, divisionId, studentDocId) {
  return apiCall("DELETE", `divisions/students?classId=${classId}&divisionId=${divisionId}&studentId=${studentDocId}`);
}

// ===== SUBJECTS =====

export async function createSubject(classId, name) {
  return apiCall("POST", "subjects", { classId, name });
}

export async function getTeacherSubjects() {
  const data = await apiCall("GET", "subjects");
  return data.subjects || [];
}

export async function getDivisionSubjects(classId, divisionId) {
  const data = await apiCall("GET", `subjects?classId=${classId}&divisionId=${divisionId}`);
  return data.subjects || [];
}

export async function updateSubjectName(subjectId, name) {
  return apiCall("PUT", `subjects/${subjectId}`, { name });
}

export async function deleteSubject(subjectId) {
  return apiCall("DELETE", `subjects/${subjectId}`);
}

// ===== ATTENDANCE =====

export async function saveAttendanceSession(subjectId, divisionId, date, records) {
  return apiCall("POST", "attendance", { subjectId, divisionId, date, records });
}

export async function getAttendanceSession(subjectId, divisionId, date) {
  const data = await apiCall("GET", `attendance?subjectId=${subjectId}&divisionId=${divisionId}&date=${date}`);
  return data.session || null;
}

export async function getSubjectAttendance(subjectId, divisionId = "") {
  let url = `attendance?subjectId=${subjectId}`;
  if (divisionId) {
    url += `&divisionId=${divisionId}`;
  }
  const data = await apiCall("GET", url);
  return data.sessions || [];
}

export async function deleteAttendanceSession(subjectId, divisionId, date) {
  const sessionId = `${subjectId}_${divisionId}_${date}`;
  return apiCall("DELETE", `attendance/${encodeURIComponent(sessionId)}`);
}

export async function editAttendanceSession(sessionId, records) {
  return apiCall("PUT", `attendance/${encodeURIComponent(sessionId)}`, { records });
}

// ===== TAMPER DETECTION =====

export async function checkTamperOnLogin() {
  const data = await apiCall("POST", "attendance/tamper-check");
  return data.tampered || [];
}

// ===== STUDENT OPERATIONS =====

export async function setStudentRoll(roll) {
  return apiCall("POST", "students/roll", { roll });
}

export async function joinDivisionByCode(joinCode) {
  return apiCall("POST", "students/join", { joinCode });
}

export async function findStudentLinks() {
  const data = await apiCall("GET", "students/links");
  return data.links || [];
}

export async function removeStudentLink(linkId) {
  return apiCall("DELETE", `students/links?linkId=${linkId}`);
}

export async function getStudentOverview() {
  return apiCall("GET", "students/overview");
}

export async function getStudentProfile() {
  const data = await apiCall("GET", "students/profile");
  return data;
}

export async function getStudentAttendanceForSubject(subjectId) {
  const data = await apiCall("GET", `students/subject-attendance?subjectId=${subjectId}`);
  return data.records || [];
}

// ===== REPORTS =====

export async function getSessionReportData(subjectId, date) {
  return apiCall("GET", `reports/session?subjectId=${subjectId}&date=${date}`);
}

export async function getClassReportData(classId) {
  return apiCall("GET", `reports/class-report?classId=${classId}`);
}

// ===== PURE UTILITY FUNCTIONS =====
// These have no security implications and run client-side for convenience.

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
