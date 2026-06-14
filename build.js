// build.js — Vercel build script
const fs = require("fs");
const path = require("path");

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

// Inject Firebase config into firebase.js (client-side Auth SDK only)
injectEnv(path.join(__dirname, "firebase.js"), {
  __FIREBASE_API_KEY__:             process.env.FIREBASE_API_KEY,
  __FIREBASE_AUTH_DOMAIN__:         process.env.FIREBASE_AUTH_DOMAIN,
  __FIREBASE_PROJECT_ID__:          process.env.FIREBASE_PROJECT_ID,
  __FIREBASE_STORAGE_BUCKET__:      process.env.FIREBASE_STORAGE_BUCKET,
  __FIREBASE_MESSAGING_SENDER_ID__: process.env.FIREBASE_MESSAGING_SENDER_ID,
  __FIREBASE_APP_ID__:              process.env.FIREBASE_APP_ID,
});

console.log("Build complete — Firebase client config injected.");
console.log("Teacher signup code is server-side only — never exposed to frontend.");
