'use strict';

const STATUS_CODES = {
  internal_error: 500,
  not_found: 404,
  auth_required: 401,
  forbidden: 403,
  unknown_peer: 403,
  peer_not_trusted: 403,
  invalid_request: 400,
  key_mismatch: 400,
  conflict: 409,
  peer_not_found: 404,
  peer_exists: 409,
  rate_limit_exceeded: 429,
  report_not_found: 404,
  report_not_shared: 403,
};

function errorResponse(res, code, message, details) {
  const status = STATUS_CODES[code] || 500;
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

module.exports = { errorResponse, STATUS_CODES };
