'use strict';

const crypto = require('crypto');

/**
 * Build the canonical payload string for checksum computation.
 * Format: sorted "roll:status" pairs joined by "|", then "|subjectId|date"
 *
 * @param {string} subjectId
 * @param {string} date - YYYY-MM-DD
 * @param {object} records - { roll: 'P'|'A' }
 * @returns {string}
 */
function buildPayload(subjectId, date, records) {
  const pairs = Object.keys(records)
    .sort((a, b) => {
      // Sort numerically when possible, fall back to lexicographic
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    })
    .map((roll) => `${roll}:${records[roll]}`);

  return pairs.join('|') + '|' + subjectId + '|' + date;
}

/**
 * Generate an HMAC-SHA256 checksum for an attendance session.
 *
 * @param {string} subjectId
 * @param {string} date - YYYY-MM-DD
 * @param {object} records - { roll: 'P'|'A' }
 * @returns {string} 64-character hex digest
 */
function generateChecksum(subjectId, date, records) {
  const secret = process.env.CHECKSUM_SECRET;
  if (!secret) {
    throw new Error('CHECKSUM_SECRET environment variable is not set');
  }

  const payload = buildPayload(subjectId, date, records);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an HMAC-SHA256 checksum for an attendance session.
 *
 * @param {string} subjectId
 * @param {string} date - YYYY-MM-DD
 * @param {object} records - { roll: 'P'|'A' }
 * @param {string} storedChecksum - The checksum to verify against
 * @returns {boolean}
 */
function verifyChecksum(subjectId, date, records, storedChecksum) {
  if (!storedChecksum || typeof storedChecksum !== 'string') return false;

  // HMAC-SHA256 hex digests are exactly 64 characters
  const isHmacFormat = /^[a-f0-9]{64}$/.test(storedChecksum);

  if (isHmacFormat) {
    // Modern HMAC-SHA256 checksum
    const computed = generateChecksum(subjectId, date, records);
    // Use timing-safe comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(storedChecksum, 'hex')
      );
    } catch {
      return false;
    }
  }

  // Legacy plain-text checksum (old client-side format)
  // The old format was the same canonical payload string, just not HMAC'd
  const payload = buildPayload(subjectId, date, records);
  return payload === storedChecksum;
}

module.exports = { generateChecksum, verifyChecksum, buildPayload };
