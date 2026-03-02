'use strict';

const http = require('http');
const { signRequest } = require('./signRequest');

/**
 * Low-level HTTP request helper (supports any method, headers, body).
 */
function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data), rawBody: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data, rawBody: data });
        }
      });
    });

    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Make an authenticated request using the given Ed25519 keypair.
 * Handles signing automatically; the path's query string is stripped
 * for signature computation (matching server-side req.path behaviour).
 */
function authedRequest(port, { method = 'GET', path, keys, body }) {
  const signPath = path.split('?')[0];
  const signed = signRequest({
    method,
    path: signPath,
    body,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  return request(port, { method, path, headers: signed.headers, body });
}

module.exports = { request, authedRequest };
