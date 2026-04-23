// build.js — Vercel build script
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function injectEnv(filePath, replacements) {
  let content = fs.readFileSync(filePath, "utf8");
  const missing = [];
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!value) { missing.push(placeholder); continue; }
    content = content.replaceAll(placeholder, value);
  }
  if (missing.length > 0) {
    console.error("ERROR: Missing environment variables:", missing.join(", "));
    process.exit(1);
  }
  fs.writeFileSync(filePath, content, "utf8");
}

// Compute SHA-256 hash of the teacher code — only the hash goes into the frontend
// The real code is NEVER written to any deployed file
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

const teacherCode = process.env.TEACHER_SIGNUP_CODE;
if (!teacherCode) {
  console.error("ERROR: TEACHER_SIGNUP_CODE environment variable is not set.");
  process.exit(1);
}

// Inject Firebase config into firebase.js
injectEnv(path.join(__dirname, "firebase.js"), {
  __FIREBASE_API_KEY__:             process.env.FIREBASE_API_KEY,
  __FIREBASE_AUTH_DOMAIN__:         process.env.FIREBASE_AUTH_DOMAIN,
  __FIREBASE_PROJECT_ID__:          process.env.FIREBASE_PROJECT_ID,
  __FIREBASE_STORAGE_BUCKET__:      process.env.FIREBASE_STORAGE_BUCKET,
  __FIREBASE_MESSAGING_SENDER_ID__: process.env.FIREBASE_MESSAGING_SENDER_ID,
  __FIREBASE_APP_ID__:              process.env.FIREBASE_APP_ID,
});

// Inject only the HASH of the teacher code into index.html — never the real code
injectEnv(path.join(__dirname, "index.html"), {
  __TEACHER_SIGNUP_CODE_HASH__: sha256(teacherCode),
});

console.log("Build complete — Firebase config and teacher code hash injected.");
console.log("Real teacher code never written to any deployed file.");
