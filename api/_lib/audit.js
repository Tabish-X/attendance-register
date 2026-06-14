'use strict';

const { adminDb, FieldValue } = require('./firebaseAdmin');
const { getClientIp } = require('./rateLimit');

/**
 * Log an action to the _auditLogs collection.
 * This is fire-and-forget — failures are logged to console but never
 * break the calling request.
 *
 * @param {object} req - Express-like request object (must have req.user set by auth middleware)
 * @param {string} action - Action constant, e.g. 'CLASS_CREATE', 'ATTENDANCE_SAVE'
 * @param {string} targetResource - Resource path, e.g. 'classes/abc123'
 * @param {object} details - Additional context about the action
 */
function logAudit(req, action, targetResource, details = {}) {
  const user = req.user || {};
  const ip = getClientIp(req);

  const entry = {
    action,
    userId: user.uid || null,
    userEmail: user.email || null,
    userRole: user.role || null,
    targetResource,
    details,
    ip,
    timestamp: FieldValue.serverTimestamp(),
  };

  // Fire-and-forget: don't await, don't let failures propagate
  adminDb
    .collection('_auditLogs')
    .add(entry)
    .catch((err) => {
      console.error('[audit] Failed to write audit log:', err.message, {
        action,
        targetResource,
      });
    });
}

module.exports = { logAudit };
