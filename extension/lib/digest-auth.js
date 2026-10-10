/**
 * Pure browser-side HTTP Digest Authentication for Hikvision ISAPI.
 *
 * Uses a compact MD5 implementation (no external dependencies) to compute
 * the challenge-response that Hikvision devices require. Failed requests
 * throw the error types in lib/errors.js, or AuthError for a rejected login.
 *
 * Hikvision locks a computer out after a few failed logins, so a wrong
 * password must cost as few attempts as possible: credentials the device
 * rejected are never sent again until the user presses Connect, and after a
 * 401 only one request per credentials retries (see digestFetch).
 */

import { IsapiError, NetworkError, TimeoutError, parseLoginStatus, parseResponseStatus } from './errors.js';

/** @typedef {import('./errors.js').LoginStatus} LoginStatus */

/* ── Minimal MD5 (RFC 1321) ─────────────────────────────────────────────── */

export const md5 = (() => {
  const K = [
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,
    0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,
    0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,
    0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,
    0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,
    0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,
    0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,
    0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,
    0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
  ];
  const S = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21,
  ];

  /** @param {string} str */
  function toUTF8(str) {
    return new TextEncoder().encode(str);
  }

  /** @param {number} x @param {number} c */
  function leftRotate(x, c) {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  /**
   * @param {string|Uint8Array} input
   * @returns {string} lowercase hex digest
   */
  return function digest(input) {
    const msg = typeof input === 'string' ? toUTF8(input) : input;
    const origLen = msg.length;
    const bitLen = origLen * 8;

    // Padding
    const padLen = ((56 - (origLen + 1) % 64) + 64) % 64;
    const buf = new Uint8Array(origLen + 1 + padLen + 8);
    buf.set(msg);
    buf[origLen] = 0x80;
    // Append bit length as 64-bit little-endian
    const view = new DataView(buf.buffer);
    view.setUint32(buf.length - 8, bitLen >>> 0, true);
    view.setUint32(buf.length - 4, (bitLen / 0x100000000) >>> 0, true);

    let a0 = 0x67452301 >>> 0;
    let b0 = 0xefcdab89 >>> 0;
    let c0 = 0x98badcfe >>> 0;
    let d0 = 0x10325476 >>> 0;

    for (let i = 0; i < buf.length; i += 64) {
      const M = new Uint32Array(16);
      for (let j = 0; j < 16; j++) {
        M[j] = view.getUint32(i + j * 4, true);
      }

      let A = a0, B = b0, C = c0, D = d0;

      for (let j = 0; j < 64; j++) {
        let F, g;
        if (j < 16) {
          F = (B & C) | (~B & D);
          g = j;
        } else if (j < 32) {
          F = (D & B) | (~D & C);
          g = (5 * j + 1) % 16;
        } else if (j < 48) {
          F = B ^ C ^ D;
          g = (3 * j + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * j) % 16;
        }
        F = (F + A + K[j] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + leftRotate(F, S[j])) >>> 0;
      }

      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    const result = new Uint8Array(16);
    const rv = new DataView(result.buffer);
    rv.setUint32(0, a0, true);
    rv.setUint32(4, b0, true);
    rv.setUint32(8, c0, true);
    rv.setUint32(12, d0, true);
    return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
  };
})();

/* ── Types ──────────────────────────────────────────────────────────────── */

/**
 * How to reach and log in to a device.
 * @typedef {object} DeviceConfig
 * @property {string} host - IPv4 address or hostname, no scheme or path
 * @property {number|string} [port] - defaults to 80
 * @property {string} username
 * @property {string} password
 */

/** Parameters of a WWW-Authenticate Digest challenge, keys lowercased. @typedef {Record<string, string>} DigestChallenge */

/**
 * A challenge reused across requests; `nc` counts uses of its nonce.
 * @typedef {{challenge: DigestChallenge, qop: 'auth'|null, nc: number}} DigestSession
 */

/**
 * A device's successful answer. `authenticated` says whether the request it
 * answers carried our credentials: only then does the answer say anything
 * about them (e.g. userCheck's verdict, see Isapi.checkLogin), since a
 * device may answer some paths without asking for a login first.
 * @typedef {{status: number, headers: Headers, data: string|ArrayBuffer, authenticated: boolean}} DigestResponse
 */

/**
 * Per-request options. Every request the UI makes should be bounded: without
 * a limit, a wrong IP address leaves Connect hanging until the OS gives up,
 * and one stalled snapshot freezes its live feed.
 * @typedef {object} RequestOptions
 * @property {AbortSignal} [signal] - cancels the request, e.g. when a live feed stops
 * @property {number} [timeoutMs] - limit for the whole call: the challenge round trip, the retry and reading
 *   the body. digestFetch has no limit without one (or with 0); Isapi.request sets one by request kind.
 */

/* ── Errors ─────────────────────────────────────────────────────────────── */

/**
 * The device rejected our credentials. Callers must not retry with the same
 * credentials: Hikvision locks this computer out after a handful of failed
 * logins, and while it is locked the right password is refused too.
 *
 * When the device explained the rejection (an XML 401 body, as userCheck
 * gives), the fields say whether it has locked this computer out and for how
 * long, or how many attempts are left, and the message says so; otherwise
 * they are undefined and the message is the plain one.
 */
export class AuthError extends Error {
  /** @param {LoginStatus|null} [status] - what the device said about the rejected login */
  constructor(status = null) {
    super(describeLoginFailure(status));
    this.name = 'AuthError';
    this.code = 'AUTH_FAILED';
    /** userCheck's statusValue, e.g. 401 */
    this.statusValue = status?.statusValue;
    /** e.g. "maxSessionUserLink" */
    this.subStatusCode = status?.subStatusCode;
    /** The device refuses logins from this computer for now, whatever the password */
    this.locked = status?.locked;
    /** Seconds until the device accepts logins again */
    this.unlockSeconds = status?.unlockSeconds;
    /** Failed logins left before the device locks this computer out */
    this.attemptsLeft = status?.attemptsLeft;
  }
}

/**
 * The message for a rejected login: the lock, or the attempts left, when the
 * device said; else the plain rejection. Hikvision's web UI tells the user
 * the same two things, so they stop guessing passwords before (or while) the
 * device locks them out.
 * @param {LoginStatus|null} status
 * @returns {string}
 */
function describeLoginFailure(status) {
  if (status?.locked) {
    const wait = status.unlockSeconds ? `in ${Math.ceil(status.unlockSeconds / 60)} min` : 'later';
    return `The device has temporarily locked logins from this computer — try again ${wait}`;
  }
  if (status?.attemptsLeft !== undefined) {
    const left = status.attemptsLeft;
    return `Wrong user name or password — ${left === 0 ? 'no' : left} attempt${left === 1 ? '' : 's'} left before the device locks this computer out`;
  }
  return 'Device rejected the username or password';
}

/* ── Input validation ───────────────────────────────────────────────────── */

export const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;

/**
 * Build the device base URL, rejecting anything that isn't a bare host and
 * port so a crafted host value can't redirect requests elsewhere. Only the
 * address is needed, so requests made without a login use it too.
 * @param {Pick<DeviceConfig, 'host'|'port'>} config
 * @returns {string}
 */
export function buildBaseUrl(config) {
  const host = String(config?.host ?? '');
  const port = Number(config?.port || 80);
  if (!HOST_RE.test(host)) throw new Error(`Invalid host: ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  return `http://${host}:${port}`;
}

/* ── Digest Auth helpers ────────────────────────────────────────────────── */

/**
 * Parse `key=value` / `key="quoted value"` pairs from one challenge.
 * @param {string} str
 * @returns {DigestChallenge}
 */
export function parseChallengeParams(str) {
  /** @type {DigestChallenge} */
  const params = {};
  const regex = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    params[match[1].toLowerCase()] = match[2] !== undefined
      ? match[2].replace(/\\(.)/g, '$1')
      : match[3];
  }
  return params;
}

/**
 * Parse the WWW-Authenticate header into the MD5 Digest challenge
 * (realm, nonce, qop, opaque, ...). A device may offer several challenges
 * (e.g. SHA-256 and MD5), which Headers.get() joins with ", ".
 * @param {string} header
 * @returns {DigestChallenge}
 */
export function parseDigestChallenge(header) {
  const challenges = header
    .split(/,?\s*(?=Digest\s)/i)
    .filter(s => /^Digest\s/i.test(s))
    .map(parseChallengeParams);
  if (challenges.length === 0) {
    throw new Error('Device did not return Digest authentication challenge');
  }
  const challenge = challenges.find(c => !c.algorithm || /^MD5$/i.test(c.algorithm));
  if (!challenge) {
    throw new Error(`Unsupported digest algorithm: ${challenges.map(c => c.algorithm).join(', ')}`);
  }
  return challenge;
}

/**
 * Pick the qop to use. The server may offer a list ("auth,auth-int");
 * we only implement "auth". No qop means legacy RFC 2069 digest.
 * @param {string|undefined} qopParam
 * @returns {'auth'|null}
 */
export function pickQop(qopParam) {
  if (qopParam === undefined) return null;
  const options = qopParam.split(',').map(s => s.trim().toLowerCase());
  if (options.includes('auth')) return 'auth';
  throw new Error(`Unsupported digest qop: ${qopParam}`);
}

/**
 * @param {number} bytes
 * @returns {string} 2 × `bytes` hex characters
 */
export function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Quote a header parameter value, escaping `"` and `\`.
 * @param {string} value
 */
export function quote(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * A server challenge we keep reusing until the device rejects it, so each
 * request costs one round trip instead of two. `nc` counts uses of the nonce.
 * @param {string|null} wwwAuthHeader
 * @returns {DigestSession}
 */
export function createDigestSession(wwwAuthHeader) {
  const challenge = parseDigestChallenge(wwwAuthHeader || '');
  return { challenge, qop: pickQop(challenge.qop), nc: 0 };
}

/**
 * Build an HTTP Digest Authorization header value.
 * @param {string} method - upper-case HTTP method
 * @param {string} uri - request path, as sent
 * @param {DigestSession} session - updated in place (nonce count)
 * @param {string} username
 * @param {string} password
 * @param {string} [cnonce] - client nonce; random unless given (tests pass a fixed one)
 * @returns {string}
 */
export function buildDigestHeader(method, uri, session, username, password, cnonce = randomHex(16)) {
  const { challenge, qop } = session;
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
  ];

  let response;
  if (qop) {
    session.nc += 1;
    const ncStr = session.nc.toString(16).padStart(8, '0');
    response = md5(`${ha1}:${challenge.nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`);
    parts.push(`qop=${qop}`, `nc=${ncStr}`, `cnonce=${quote(cnonce)}`);
  } else {
    response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
  }

  parts.push(`response=${quote(response)}`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

/* ── Session + lockout state ────────────────────────────────────────────── */

/**
 * Cached challenges, keyed by device + credentials.
 * @type {Map<string, DigestSession>}
 */
export const digestSessions = new Map();

/**
 * Credentials the device has already rejected, with what it said about the
 * rejection (null when its answer didn't explain it). Requests with these
 * fail immediately instead of hitting the device, so background polling
 * can't burn through the device's failed-login limit.
 * @type {Map<string, LoginStatus|null>}
 */
export const rejectedCredentials = new Map();

/**
 * Retries after a 401 in progress, per credentials. Hikvision answers a
 * wrong password and an expired nonce alike, with a 401 carrying a fresh
 * nonce and stale="FALSE", so the only way to tell them apart is to answer
 * the new challenge, and each such retry with a wrong password is one more
 * failed login. So one request retries for all: every other request that
 * gets a 401, or starts, meanwhile waits for it, then sends with the
 * challenge it proved, or fails without sending. The promise settles when
 * the retry has (it never rejects).
 * @type {Map<string, Promise<void>>}
 */
const retries = new Map();

/** Read at most this much of a rejected login's body: the device's explanation is a few hundred bytes. */
const MAX_LOGIN_BODY_BYTES = 16 * 1024;

/**
 * A picture URL, in any letter case: snapshots (…/channels/101/picture),
 * stored pictures (/picture/Streaming/tracks/…), and the web UI's own
 * spelling (…/StreamingProxy/channel/101/Picture).
 */
const PICTURE_PATH = /\/picture(?:[/?]|$)/i;

/**
 * Whether a successful answer's body is binary: an image by its Content-Type,
 * or anything from a picture URL, in case firmware labels its JPEGs
 * otherwise (callers check what they got, see Isapi.fetchSnapshot).
 * @param {Response} resp
 * @param {string} urlPath
 * @returns {boolean}
 */
function isBinaryAnswer(resp, urlPath) {
  return /^image\//i.test(resp.headers.get('Content-Type') ?? '') || PICTURE_PATH.test(urlPath);
}

/**
 * @param {string} baseUrl
 * @param {DeviceConfig} config
 * @returns {string} key that doesn't contain the password itself
 */
export function credentialKey(baseUrl, config) {
  return `${baseUrl}|${config.username}|${md5(String(config.password))}`;
}

/**
 * Allow one more attempt with these credentials. Only call this for an
 * explicit user action (pressing Connect), never from automatic retries.
 * @param {DeviceConfig} config
 */
export function forgetRejectedCredentials(config) {
  rejectedCredentials.delete(credentialKey(buildBaseUrl(config), config));
}

/**
 * Forget the cached challenges for a device, for every user, e.g. on
 * disconnect. The next request then starts from an unauthenticated
 * challenge, which costs no login attempt, so a password changed meanwhile
 * costs one failed login, not two (a stale challenge, then the retry).
 * @param {DeviceConfig} config
 */
export function forgetDigestSessions(config) {
  const prefix = `${buildBaseUrl(config)}|`;
  for (const key of digestSessions.keys()) {
    if (key.startsWith(prefix)) digestSessions.delete(key);
  }
}

/**
 * Record a rejection that came in a successful answer's body (older
 * firmware answers userCheck with HTTP 200 and <statusValue>401</statusValue>),
 * so nothing sends these credentials again until the user presses Connect,
 * as after a 401. Only for an answer to a request that carried them
 * (DigestResponse.authenticated): any other answer didn't judge them.
 * @param {DeviceConfig} config
 * @param {LoginStatus|null} status - what the device said
 * @returns {AuthError} the error to throw
 */
export function rejectCredentials(config, status) {
  const key = credentialKey(buildBaseUrl(config), config);
  markRejected(key, status);
  return new AuthError(status);
}

/**
 * @param {string} key - credentialKey()
 * @param {LoginStatus|null} status
 */
function markRejected(key, status) {
  digestSessions.delete(key);
  rejectedCredentials.set(key, status);
}

/**
 * @param {string} key - credentialKey()
 * @throws {AuthError} with what the device said, if it rejected these credentials
 */
function throwIfRejected(key) {
  if (rejectedCredentials.has(key)) throw new AuthError(rejectedCredentials.get(key));
}

/**
 * Perform an HTTP request with Digest Authentication.
 *
 * Reuses the last challenge for these credentials when we have one. A 401
 * can't say whether the password is wrong or the nonce expired: Hikvision
 * issues a fresh nonce with every 401 and never sets stale=true. So a 401 is
 * answered once with a new challenge, by one request at a time per
 * credentials (see `retries`). If that retry gets a 401 too, the
 * credentials are marked rejected, and every request waiting for it fails
 * without sending. A wrong password then costs each request in flight the
 * attempt it was already sent with, plus one retry for all of them. The
 * refused challenge is dropped as the retry starts, so a retry cancelled or
 * timed out before its verdict leaves the waiting requests to start over
 * from an unauthenticated challenge, not to send the refused one again.
 *
 * The final 401's body is read (its start) for the device's explanation:
 * the AuthError then says whether the device has locked this computer out,
 * or how many attempts are left. An HTML body leaves those fields undefined.
 *
 * A timeout or network failure leaves the cached challenge and the rejected
 * credentials alone: the device never judged the credentials.
 *
 * @param {DeviceConfig} config
 * @param {string} method
 * @param {string} urlPath - path and query, e.g. "/ISAPI/System/deviceInfo"
 * @param {string|null} [body] - XML for PUT/POST
 * @param {RequestOptions} [options] - no time limit unless `timeoutMs` is given
 * @returns {Promise<DigestResponse>} images (by Content-Type, or from a "/picture" URL in any
 *   letter case) as ArrayBuffer, everything else as text; `authenticated` false when the device
 *   answered without asking for the credentials
 * @throws {AuthError} the device rejected the credentials (now or earlier)
 * @throws {IsapiError} the device answered with an error status
 * @throws {TimeoutError} no complete answer within `timeoutMs`
 * @throws {NetworkError} the device couldn't be reached
 * @throws {unknown} the caller's `signal` abort reason, passed through as is
 */
export async function digestFetch(config, method, urlPath, body = null, { signal, timeoutMs } = {}) {
  const baseUrl = buildBaseUrl(config);
  const url = `${baseUrl}${urlPath}`;
  const credKey = credentialKey(baseUrl, config);
  throwIfRejected(credKey);

  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const requestSignal = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;

  /**
   * Run one network step (sending, reading a body, or waiting for another
   * request's retry), turning a failure into TimeoutError or NetworkError.
   * A caller's abort passes through unchanged, so the caller can recognise
   * its own cancellation.
   * @template T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  const network = async (step) => {
    try {
      return await step();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      const details = { method, path: urlPath, address: baseUrl.replace(/^http:\/\//, ''), cause: err };
      if (timeout?.aborted) throw new TimeoutError({ ...details, timeoutMs: Number(timeoutMs) });
      throw new NetworkError(details);
    }
  };

  /** Whether the latest send, whose answer this call returns, carried our credentials */
  let credentialed = false;
  /** @param {string|null} authorization */
  const send = (authorization) => {
    credentialed = authorization !== null;
    return network(() => fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/xml' } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body,
      signal: requestSignal,
    }));
  };
  /** @param {DigestSession} session */
  const authorize = (session) => buildDigestHeader(
    method.toUpperCase(), urlPath, session, config.username, config.password);

  /**
   * Wait for another request's retry, within this request's own time limit
   * and signal.
   * @param {Promise<void>} retry
   */
  const waitFor = (retry) => network(() => new Promise((resolve, reject) => {
    const onAbort = () => reject(requestSignal?.reason);
    if (requestSignal?.aborted) return onAbort();
    requestSignal?.addEventListener('abort', onAbort, { once: true });
    retry.then(() => {
      requestSignal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    });
  }));

  /**
   * The device's explanation of a rejected login, if the body has one (an
   * HTML page doesn't). A body that doesn't arrive loses only the
   * explanation, not the rejection.
   * @param {Response} resp - the final 401
   * @returns {Promise<LoginStatus|null>}
   */
  const readLoginStatus = async (resp) => {
    try {
      return parseLoginStatus(await network(() => readTextStart(resp, MAX_LOGIN_BODY_BYTES)));
    } catch (err) {
      if (err instanceof NetworkError) return null;
      throw err;
    }
  };

  /**
   * Mark these credentials rejected, with the device's explanation, and
   * return the error to throw.
   * @param {Response} resp - the final 401
   * @returns {Promise<AuthError>}
   */
  const rejection = async (resp) => {
    /** @type {LoginStatus|null} */
    let status = null;
    try {
      status = await readLoginStatus(resp);
    } finally {
      // Also if the caller gave up meanwhile: the device has judged the credentials
      markRejected(credKey, status);
    }
    return new AuthError(status);
  };

  /**
   * Answer the challenge in `challenge` as the one retry for these
   * credentials, while every other request that needs one waits for it.
   * @param {Response} challenge - a 401
   * @returns {Promise<Response>} the device's answer, never a 401
   * @throws {AuthError} the retry got a 401 too
   */
  const retry = async (challenge) => {
    const session = createDigestSession(challenge.headers.get('WWW-Authenticate'));
    /** @type {(value: void) => void} */
    let settle = () => {};
    const pending = new Promise(resolve => { settle = resolve; });
    retries.set(credKey, pending);
    try {
      const resp = await send(authorize(session));
      if (resp.status === 401) throw await rejection(resp);
      digestSessions.set(credKey, session);
      return resp;
    } finally {
      // Before the waiting requests resume, so none of them finds this retry again
      if (retries.get(credKey) === pending) retries.delete(credKey);
      settle();
    }
  };

  // Credentials another request is retrying right now may be about to be
  // rejected: wait for the verdict rather than send them again
  for (let pending = retries.get(credKey); pending; pending = retries.get(credKey)) await waitFor(pending);
  throwIfRejected(credKey);

  let used = digestSessions.get(credKey) ?? null;
  let resp = await send(used ? authorize(used) : null);
  let resent = false;
  while (resp.status === 401) {
    const pending = retries.get(credKey);
    if (pending) {
      await waitFor(pending);
      continue;
    }
    throwIfRejected(credKey);
    const current = digestSessions.get(credKey);
    if (current && current !== used && !resent) {
      // Another request has answered a newer challenge with these credentials since: use it
      used = current;
      resent = true;
      resp = await send(authorize(current));
    } else {
      // The device refused the cached challenge: drop it, so that if this
      // retry ends without a verdict (its caller cancels it, or it times
      // out) the requests waiting for it start over without credentials,
      // which costs no attempt, instead of each sending the refused
      // challenge again, which may be one failed login apiece
      if (used && digestSessions.get(credKey) === used) digestSessions.delete(credKey);
      resp = await retry(resp);
    }
  }

  if (!resp.ok) {
    // The body explains the error, also for snapshots, so read it as text
    const text = await network(() => resp.text());
    throw new IsapiError({ method, path: urlPath, httpStatus: resp.status, status: parseResponseStatus(text) });
  }

  /** @type {() => Promise<string|ArrayBuffer>} */
  const readBody = () => (isBinaryAnswer(resp, urlPath) ? resp.arrayBuffer() : resp.text());
  const data = await network(readBody);
  return { status: resp.status, headers: resp.headers, data, authenticated: credentialed };
}

/**
 * Read the start of a response body as text, at most `maxBytes`, then stop
 * the download: only the start can explain a rejected login, and whatever
 * answers at the device's address could send any amount.
 * @param {Response} resp
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readTextStart(resp, maxBytes) {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value.subarray(0, maxBytes - size), { stream: true });
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}
