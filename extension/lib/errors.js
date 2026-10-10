/**
 * How requests to a Hikvision device fail, and which failures an endpoint
 * fallback may skip past.
 *
 * A device that answers with an error explains it in a <ResponseStatus> body
 * (statusCode, subStatusCode, statusString). Hikvision's own clients turn
 * that into a specific message, and so does IsapiError: "HTTP 403" alone
 * can't tell an account without permission from a setting the firmware
 * doesn't have. A device that doesn't answer at all fails with NetworkError
 * or TimeoutError, never AuthError (lib/digest-auth.js), so a slow or
 * unreachable device can't trip the guard against failed logins.
 *
 * A rejected login may explain itself too (parseLoginStatus): whether the
 * device has locked this computer out, and for how long, or how many
 * attempts are left before it does.
 *
 * Bodies are parsed as plain text rather than with DOMParser: ResponseStatus
 * is a flat document, and the transport also runs in the Node tests.
 */

/**
 * The status a device reports in a <ResponseStatus> body: XML in any
 * namespace (hikvision.com and isapi.org ver20, or urn:psialliance-org as
 * /SDK/play answers), or the JSON form. Fields the body doesn't have are null.
 * @typedef {object} ResponseStatus
 * @property {number|null} statusCode - 1 OK, 2 busy, 3 device error, 4 invalid operation, 5 bad XML format, 6 bad XML content, 7 OK but reboot required
 * @property {string|null} statusString - the device's short text, e.g. "Invalid Operation"
 * @property {string|null} subStatusCode - the specific reason, e.g. "notSupport"; PSIA bodies omit it
 * @property {string|null} subStatusString - detail some firmware adds, e.g. "Tag 16 is invalid (two root tags)"
 */

/** ResponseStatus statusCode for a request that succeeded. */
export const STATUS_OK = 1;
/** ResponseStatus statusCode for a write the device stored but applies only after a reboot. */
export const STATUS_REBOOT_REQUIRED = 7;

/**
 * The reason each statusCode stands for, for firmware that sends only a
 * statusCode (no subStatusCode), so it gets the same message and fallback
 * treatment as newer firmware.
 * @type {Record<number, string>}
 */
const STATUS_CODE_REASONS = {
  2: 'deviceBusy',
  3: 'deviceError',
  4: 'invalidOperation',
  5: 'badXmlFormat',
  6: 'badXmlContent',
};

/**
 * Plain-language messages for the subStatusCodes users actually run into,
 * following what Hikvision's web UI and iVMS show for them.
 * @type {Record<string, string>}
 */
const REASON_MESSAGES = {
  lowPrivilege: 'This user account doesn’t have permission for this. Log in as an administrator, or give the account this permission on the device.',
  badAuthorization: 'The device rejected the login for this request. Check the username and password.',
  riskPassword: 'The device requires a stronger password for this account. Change it in the device’s own web interface first.',
  notSupport: 'The device doesn’t support this on this camera or firmware.',
  invalidOperation: 'The device refused this operation. It may not apply to this camera or its current settings.',
  methodNotAllowed: 'The device doesn’t allow this change.',
  badXmlFormat: 'The device couldn’t read the settings that were sent. Reload the settings and try again.',
  badXmlContent: 'The device rejected the settings that were sent as invalid. Reload the settings and try again.',
  badParameters: 'The device rejected one of the values. Check the settings and try again.',
  deviceBusy: 'The device is busy. Wait a moment and try again.',
  serviceUnavailable: 'The device is busy or the camera isn’t available. Wait a moment and try again.',
  deviceError: 'The device couldn’t apply this because of an internal error.',
  upgrading: 'The device is installing a firmware upgrade. Try again when it has finished.',
  noMemory: 'The device is out of memory. Try again later, or reboot the device.',
};

/**
 * Messages for error answers without a ResponseStatus body.
 * @type {Record<number, string>}
 */
const HTTP_MESSAGES = {
  403: 'The device refused the request (HTTP 403).',
  404: 'The device doesn’t have this setting (HTTP 404). This camera or firmware may not support it.',
  500: 'The device reported an internal error (HTTP 500).',
  503: 'The device is busy (HTTP 503). Wait a moment and try again.',
};

/**
 * The device answered a request with an error. The message is meant for the
 * user (the UI shows it as is); the fields keep the device's own codes for
 * code that decides what to do next, e.g. isFallbackError().
 */
export class IsapiError extends Error {
  /**
   * @param {object} init
   * @param {string} init.method - HTTP method of the failed request
   * @param {string} init.path - request path, e.g. "/ISAPI/Event/triggers/VMD-1"
   * @param {number} init.httpStatus - 200 for a write whose ResponseStatus reported a failure
   * @param {ResponseStatus|null} [init.status] - the parsed body; null when it had none
   */
  constructor({ method, path, httpStatus, status = null }) {
    super(describeFailure(httpStatus, status));
    this.name = 'IsapiError';
    this.method = method;
    this.path = path;
    this.httpStatus = httpStatus;
    this.statusCode = status?.statusCode ?? null;
    this.statusString = status?.statusString ?? null;
    this.subStatusCode = status?.subStatusCode ?? null;
    this.subStatusString = status?.subStatusString ?? null;
  }

  /**
   * The specific reason: the subStatusCode, or for firmware that sends only
   * a statusCode, the reason that code stands for. Null without a body.
   * @returns {string|null}
   */
  get reason() {
    return reasonOf(this.statusCode, this.subStatusCode);
  }
}

/**
 * The device didn't answer: the connection was refused, the address is
 * unreachable, or the connection dropped. There is no device answer to
 * explain, so this is separate from IsapiError, and separate from AuthError
 * so an unreachable device never counts as a rejected login.
 */
export class NetworkError extends Error {
  /**
   * @param {object} init
   * @param {string} init.method
   * @param {string} init.path
   * @param {string} init.address - "host:port" of the device
   * @param {unknown} [init.cause] - the underlying fetch failure
   * @param {string} [message] - overrides the default message (used by TimeoutError)
   */
  constructor({ method, path, address, cause }, message) {
    super(message ?? `Couldn’t reach the device at ${address}. Check the IP address and port, and that the device is on.`, { cause });
    this.name = 'NetworkError';
    this.method = method;
    this.path = path;
    this.address = address;
  }
}

/**
 * The device didn't answer within the request's time limit. A NetworkError,
 * because to the user both mean the same thing: nothing answered.
 */
export class TimeoutError extends NetworkError {
  /**
   * @param {object} init
   * @param {string} init.method
   * @param {string} init.path
   * @param {string} init.address - "host:port" of the device
   * @param {number} init.timeoutMs - the limit that ran out
   * @param {unknown} [init.cause]
   */
  constructor({ method, path, address, timeoutMs, cause }) {
    super({ method, path, address, cause },
      `No response from the device at ${address} within ${Math.round(timeoutMs / 100) / 10} s. Check that it is reachable and try again.`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The device answered a request for an image successfully, but not with an
 * image (an empty body, a page, another format), so there is nothing to show.
 * Separate from IsapiError, which is an error answer the device explained:
 * this URL may simply not be how this firmware serves pictures, so a
 * snapshot fallback moves on to the next one (see lib/snapshots.js).
 */
export class NotAnImageError extends Error {
  /**
   * @param {object} init
   * @param {string} init.method
   * @param {string} init.path
   * @param {string|null} init.contentType - what the device said it sent
   */
  constructor({ method, path, contentType }) {
    super('The device didn’t send an image for this camera. Its firmware may not provide snapshots this way.');
    this.name = 'NotAnImageError';
    this.method = method;
    this.path = path;
    this.contentType = contentType;
  }
}

/**
 * A save that takes more than one request failed partway, and putting the
 * device back as it was failed too, so it may now have neither the old nor
 * the new settings. The message tells the user what may be lost and what to
 * do; `cause` is the error that failed the save, `rollbackError` the one that
 * failed the restore.
 */
export class WriteRollbackError extends Error {
  /**
   * @param {string} message - user-facing: what may be lost, and what to do
   * @param {{cause: unknown, rollbackError: unknown}} init
   */
  constructor(message, { cause, rollbackError }) {
    super(message, { cause });
    this.name = 'WriteRollbackError';
    this.rollbackError = rollbackError;
  }
}

/**
 * Shared fallback policy: may an endpoint fallback try its next candidate
 * after this error?
 *
 * Only when the device clearly answered "not here": HTTP 404, 403 notSupport
 * or invalidOperation, or 400 badXmlContent or badParameters (this NVR
 * answers a snapshot URL form it doesn't use with 400 badXmlContent), and a
 * 403 or 400 without a body to say otherwise. A write the device answers
 * with HTTP 200 but a notSupport or invalidOperation status (see
 * checkWriteResponse in lib/isapi.js) counts the same as the 403. Everything
 * else stops the fallback and reaches the user:
 * - AuthError: each further attempt is a failed login towards the lockout
 * - lowPrivilege: every candidate would be refused the same way
 * - NetworkError, TimeoutError, aborts: nothing is answering, and more
 *   requests only add delay and load
 * - 503 serviceUnavailable or deviceBusy: try again later, not elsewhere. An
 *   empty channel's snapshot answers 503 on this NVR, so moving on to the
 *   next URL would spend every candidate on each frame (lib/snapshots.js
 *   keeps that URL and asks it less and less often instead).
 * @param {unknown} err
 * @returns {boolean}
 * @example
 * try { return await loadFromMainEndpoint(); } catch (err) { if (!isFallbackError(err)) throw err; }
 * return loadFromOtherEndpoint();
 */
export function isFallbackError(err) {
  if (!(err instanceof IsapiError)) return false;
  const reason = err.reason;
  switch (err.httpStatus) {
    case 404: return true;
    case 200: return reason === 'notSupport' || reason === 'invalidOperation';
    case 403: return reason === null || reason === 'notSupport' || reason === 'invalidOperation';
    case 400: return reason === null || reason === 'badXmlContent' || reason === 'badParameters';
    default: return false;
  }
}

/**
 * Read the ResponseStatus from a response body, if it is one. Matches
 * elements by local name, so any namespace or prefix works, and accepts the
 * JSON form ({statusCode, subStatusCode, ...}, optionally wrapped in
 * {ResponseStatus: ...}).
 * @param {string} text - response body
 * @returns {ResponseStatus|null} null for anything else, e.g. an HTML error page or an empty body
 * @example
 * parseResponseStatus('<ResponseStatus><statusCode>4</statusCode><subStatusCode>notSupport</subStatusCode></ResponseStatus>')
 * // → {statusCode: 4, statusString: null, subStatusCode: 'notSupport', subStatusString: null}
 */
export function parseResponseStatus(text) {
  const body = String(text ?? '').trim();
  const status = body.startsWith('{') ? parseJsonStatus(body) : parseXmlStatus(body);
  return status && (status.statusCode !== null || status.subStatusCode !== null) ? status : null;
}

/**
 * What a device says about a login: the answer to GET /ISAPI/Security/userCheck
 * (the explicit login Hikvision's web UI and SDK use), or the XML body of a
 * rejected login's 401. Each field is undefined when the body doesn't have
 * it; an HTML 401 page, which is what most requests get, has none.
 * @typedef {object} LoginStatus
 * @property {number} [statusValue] - userCheck's verdict: 200 accepted, 401 rejected
 * @property {string} [subStatusCode] - the specific reason, e.g. "maxSessionUserLink"
 * @property {boolean} [locked] - lockStatus: true for "lock", false for "unlock". The device
 *   refuses every login from this computer while locked, the right password included.
 * @property {number} [unlockSeconds] - unlockTime: seconds until the device accepts logins again
 * @property {number} [attemptsLeft] - retryLoginTime: failed logins left before the device locks
 */

/**
 * Read a LoginStatus from a userCheck answer or a 401 body, matching elements
 * by local name like the web UI does (userCheck's own fields, or a
 * ResponseStatus's subStatusCode), so any namespace or prefix works.
 * @param {string} text - response body
 * @returns {LoginStatus|null} null for anything but an XML document with one of the fields
 * @example
 * parseLoginStatus('<userCheck><statusValue>401</statusValue><lockStatus>lock</lockStatus><unlockTime>1500</unlockTime></userCheck>')
 * // → {statusValue: 401, locked: true, unlockSeconds: 1500}, the other fields undefined
 */
export function parseLoginStatus(text) {
  const body = String(text ?? '').trim();
  const root = XML_ROOT.exec(body)?.[1];
  if (!root || root.toLowerCase() === 'html') return null;

  const lockStatus = xmlField(body, 'lockStatus');
  /** @type {LoginStatus} */
  const status = {
    statusValue: toCount(xmlField(body, 'statusValue')),
    subStatusCode: xmlField(body, 'subStatusCode') ?? undefined,
    locked: lockStatus === 'lock' ? true : lockStatus === 'unlock' ? false : undefined,
    unlockSeconds: toCount(xmlField(body, 'unlockTime')),
    attemptsLeft: toCount(xmlField(body, 'retryLoginTime')),
  };
  const known = Object.values(status).some(value => value !== undefined);
  return known ? status : null;
}

/* ── Internals ──────────────────────────────────────────────────────────── */

/** A document whose root element is ResponseStatus, after any XML declaration or comments. */
const RESPONSE_STATUS_ROOT = /^(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?ResponseStatus[\s/>]/;

/** Any XML document: captures the root element's local name, after any XML declaration or comments. */
const XML_ROOT = /^(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?([\w.-]+)[\s/>]/;

/**
 * A whole non-negative number, as the device writes counts and durations.
 * @param {string|null} text
 * @returns {number|undefined}
 */
function toCount(text) {
  return text !== null && /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * @param {string} body
 * @returns {ResponseStatus|null}
 */
function parseXmlStatus(body) {
  if (!RESPONSE_STATUS_ROOT.test(body)) return null;
  return {
    statusCode: toStatusCode(xmlField(body, 'statusCode')),
    statusString: xmlField(body, 'statusString'),
    subStatusCode: xmlField(body, 'subStatusCode'),
    subStatusString: xmlField(body, 'subStatusString'),
  };
}

/**
 * Text of the first element with this local name. ResponseStatus lists its
 * own fields before any nested per-item statuses, so the first match is the
 * top-level one.
 * @param {string} body
 * @param {string} name - a fixed field name, never user input
 * @returns {string|null}
 */
function xmlField(body, name) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${name}\\s*>`).exec(body);
  return match ? nonEmpty(decodeXmlText(match[1])) : null;
}

/**
 * @param {string} body - text starting with "{"
 * @returns {ResponseStatus|null}
 */
function parseJsonStatus(body) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(body);
  } catch (err) {
    // Not JSON after all (e.g. a truncated body): there is no status to report
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  const obj = isRecord(value) && isRecord(value.ResponseStatus) ? value.ResponseStatus : value;
  if (!isRecord(obj)) return null;
  /** @param {string} key */
  const text = key => (typeof obj[key] === 'string' || typeof obj[key] === 'number' ? nonEmpty(String(obj[key])) : null);
  return {
    statusCode: toStatusCode(text('statusCode')),
    statusString: text('statusString'),
    subStatusCode: text('subStatusCode'),
    subStatusString: text('subStatusString'),
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string|null} text
 * @returns {number|null}
 */
function toStatusCode(text) {
  return text !== null && /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * @param {string} text
 * @returns {string|null}
 */
function nonEmpty(text) {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** @type {Record<string, string>} */
const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };

/**
 * Resolve the character references XML allows in text content.
 * @param {string} text
 * @returns {string}
 */
function decodeXmlText(text) {
  return text.replace(/&(?:#x([\da-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g, decodeReference);
}

/**
 * @param {string} _ - the whole reference
 * @param {string|undefined} hex - digits of &#x…;
 * @param {string|undefined} dec - digits of &#…;
 * @param {string|undefined} named - name of &lt; etc.
 * @returns {string}
 */
function decodeReference(_, hex, dec, named) {
  if (named) return XML_ENTITIES[named];
  return String.fromCodePoint(hex ? parseInt(hex, 16) : Number(dec));
}

/**
 * @param {number|null} statusCode
 * @param {string|null} subStatusCode
 * @returns {string|null}
 */
function reasonOf(statusCode, subStatusCode) {
  return subStatusCode ?? (statusCode !== null ? STATUS_CODE_REASONS[statusCode] ?? null : null);
}

/**
 * The user-facing message for an error answer: a plain explanation of the
 * reason when we know it, else the device's own statusString, else the HTTP
 * status. Detail the device adds (subStatusString) is kept for support.
 * @param {number} httpStatus
 * @param {ResponseStatus|null} status
 * @returns {string}
 */
function describeFailure(httpStatus, status) {
  const reason = reasonOf(status?.statusCode ?? null, status?.subStatusCode ?? null);
  const known = reason !== null ? REASON_MESSAGES[reason] : undefined;
  const detail = status?.subStatusString ? ` Details: ${status.subStatusString.replace(/\.$/, '')}.` : '';
  if (known) return known + detail;
  if (status?.statusString) {
    const code = status.subStatusCode ? ` (${status.subStatusCode})` : '';
    return `The device answered “${status.statusString}”${code}.${detail}`;
  }
  return HTTP_MESSAGES[httpStatus] ?? `The device answered with an error (HTTP ${httpStatus}).`;
}
