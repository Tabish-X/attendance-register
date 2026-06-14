'use strict';

/**
 * Send a JSON error response.
 * @param {object} res - Express-like response object
 * @param {number} status - HTTP status code
 * @param {string} message - Human-readable error message
 */
function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

/**
 * Send a 200 JSON success response.
 * @param {object} res - Express-like response object
 * @param {object} data - Additional data to spread into the response
 */
function sendSuccess(res, data = {}) {
  return res.status(200).json({ success: true, ...data });
}

/**
 * Send a 201 JSON success response (resource created).
 * @param {object} res - Express-like response object
 * @param {object} data - Additional data to spread into the response
 */
function sendCreated(res, data = {}) {
  return res.status(201).json({ success: true, ...data });
}

module.exports = { sendError, sendSuccess, sendCreated };
