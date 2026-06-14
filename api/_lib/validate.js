'use strict';

/**
 * Sanitize a string input: trim, strip HTML tags, enforce max length.
 * Returns empty string for non-string inputs.
 *
 * @param {*} str - Input to sanitize
 * @param {number} maxLength - Maximum allowed length after sanitization
 * @returns {string}
 */
function sanitizeString(str, maxLength = 200) {
  if (typeof str !== 'string') return '';
  let clean = str.trim();
  // Strip any HTML tags
  clean = clean.replace(/<[^>]*>/g, '');
  if (clean.length > maxLength) {
    clean = clean.substring(0, maxLength);
  }
  return clean;
}

/**
 * Validate an email address (basic format check).
 * @param {string} email
 * @returns {boolean}
 */
function validateEmail(email) {
  if (typeof email !== 'string') return false;
  // RFC 5322 simplified — good enough for server-side gating
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email) && email.length <= 254;
}

/**
 * Validate a date string in YYYY-MM-DD format and confirm it's a real date.
 * @param {string} date
 * @returns {boolean}
 */
function validateDate(date) {
  if (typeof date !== 'string') return false;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(date)) return false;

  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

/**
 * Parse a roll range string like '1-60,65,70-75' into a sorted array of
 * positive integer roll strings.
 *
 * Rules:
 *  - Only positive integers allowed
 *  - Max 500 individual rolls
 *  - Ranges are inclusive on both ends
 *
 * @param {string} input - Roll range string
 * @returns {{ valid: boolean, rolls?: string[], error?: string }}
 */
function validateRollRange(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { valid: false, error: 'Roll range is required' };
  }

  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  const rollSet = new Set();

  for (const part of parts) {
    // Check for a range (e.g., '1-60')
    if (part.includes('-')) {
      const bounds = part.split('-').map((b) => b.trim());
      if (bounds.length !== 2) {
        return { valid: false, error: `Invalid range segment: "${part}"` };
      }
      const start = Number(bounds[0]);
      const end = Number(bounds[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        return { valid: false, error: `Invalid range values: "${part}". Only positive integers are allowed.` };
      }
      if (start > end) {
        return { valid: false, error: `Invalid range: start (${start}) > end (${end})` };
      }
      if (end - start + 1 > 500) {
        return { valid: false, error: `Range "${part}" produces more than 500 rolls` };
      }
      for (let i = start; i <= end; i++) {
        rollSet.add(i);
      }
    } else {
      const num = Number(part);
      if (!Number.isInteger(num) || num < 1) {
        return { valid: false, error: `Invalid roll number: "${part}". Only positive integers are allowed.` };
      }
      rollSet.add(num);
    }

    if (rollSet.size > 500) {
      return { valid: false, error: 'Exceeded maximum of 500 rolls' };
    }
  }

  if (rollSet.size === 0) {
    return { valid: false, error: 'No valid rolls found' };
  }

  const sorted = Array.from(rollSet)
    .sort((a, b) => a - b)
    .map(String);

  return { valid: true, rolls: sorted };
}

// Valid characters for join codes (no 0/O/1/I to avoid confusion)
const JOIN_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Validate a join code: 6 uppercase alphanumeric characters from the allowed charset.
 * @param {string} code
 * @returns {boolean}
 */
function validateJoinCode(code) {
  if (typeof code !== 'string') return false;
  if (code.length !== 6) return false;
  const upper = code.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    if (!JOIN_CODE_CHARSET.includes(upper[i])) return false;
  }
  return true;
}

/**
 * Validate attendance records object.
 * Must be a plain object with roll-number keys and 'P' or 'A' values.
 * Max 500 entries.
 *
 * @param {*} records
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAttendanceRecords(records) {
  if (records === null || typeof records !== 'object' || Array.isArray(records)) {
    return { valid: false, error: 'Records must be a non-null object' };
  }

  const keys = Object.keys(records);
  if (keys.length === 0) {
    return { valid: false, error: 'Records cannot be empty' };
  }
  if (keys.length > 500) {
    return { valid: false, error: 'Records exceed maximum of 500 entries' };
  }

  for (const key of keys) {
    const val = records[key];
    if (val !== 'P' && val !== 'A') {
      return { valid: false, error: `Invalid status "${val}" for roll "${key}". Must be "P" or "A".` };
    }
  }

  return { valid: true };
}

/**
 * Ensure that all specified fields exist in the body and are non-empty.
 * "Non-empty" means: not undefined, not null, and if string not blank after trim.
 *
 * @param {object} body
 * @param {string[]} fields
 * @returns {{ valid: boolean, missing?: string[] }}
 */
function requireFields(body, fields) {
  if (!body || typeof body !== 'object') {
    return { valid: false, missing: fields };
  }

  const missing = [];
  for (const field of fields) {
    const val = body[field];
    if (val === undefined || val === null) {
      missing.push(field);
      continue;
    }
    if (typeof val === 'string' && val.trim() === '') {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return { valid: false, missing };
  }
  return { valid: true };
}

module.exports = {
  sanitizeString,
  validateEmail,
  validateDate,
  validateRollRange,
  validateJoinCode,
  validateAttendanceRecords,
  requireFields,
  JOIN_CODE_CHARSET,
};
