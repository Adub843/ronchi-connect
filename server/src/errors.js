'use strict';
/**
 * An error that is safe to show to the person using the app.
 * `code` is a stable machine-readable id; `message` is plain English.
 * Anything else thrown inside a handler is reported as a generic server error.
 */
class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Trim a user-supplied string and cap its length. */
function text(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

module.exports = { ProtocolError, text };
