/**
 * Pure browser-side HTTP Digest Authentication for Hikvision ISAPI.
 *
 * Uses a compact MD5 implementation (no external dependencies) to compute
 * the challenge-response that Hikvision devices require.
 */

/* ── Minimal MD5 (RFC 1321) ─────────────────────────────────────────────── */

const md5 = (() => {
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

  function toUTF8(str) {
    return new TextEncoder().encode(str);
  }

  function leftRotate(x, c) {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  return function md5(input) {
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

/* ── Errors ─────────────────────────────────────────────────────────────── */

/**
 * The device rejected our credentials. Callers must not retry with the same
 * credentials: Hikvision locks the account after a handful of failed logins.
 */
class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.code = 'AUTH_FAILED';
  }
}

/* ── Input validation ───────────────────────────────────────────────────── */

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;

/**
 * Build the device base URL, rejecting anything that isn't a bare host and
 * port so a crafted host value can't redirect requests elsewhere.
 */
function buildBaseUrl(config) {
  const host = String(config?.host ?? '');
  const port = Number(config?.port || 80);
  if (!HOST_RE.test(host)) throw new Error(`Invalid host: ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  return `http://${host}:${port}`;
}

/* ── Digest Auth helpers ────────────────────────────────────────────────── */

/** Parse `key=value` / `key="quoted value"` pairs from one challenge. */
function parseChallengeParams(str) {
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
 */
function parseDigestChallenge(header) {
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
 */
function pickQop(qopParam) {
  if (qopParam === undefined) return null;
  const options = qopParam.split(',').map(s => s.trim().toLowerCase());
  if (options.includes('auth')) return 'auth';
  throw new Error(`Unsupported digest qop: ${qopParam}`);
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Quote a header parameter value, escaping `"` and `\`. */
function quote(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * A server challenge we keep reusing until the device rejects it, so each
 * request costs one round trip instead of two. `nc` counts uses of the nonce.
 */
function createDigestSession(wwwAuthHeader) {
  const challenge = parseDigestChallenge(wwwAuthHeader || '');
  return { challenge, qop: pickQop(challenge.qop), nc: 0 };
}

/**
 * Build an HTTP Digest Authorization header value.
 */
function buildDigestHeader(method, uri, session, username, password) {
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
    const cnonce = randomHex(16);
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

/** Cached challenges, keyed by device + credentials. */
const digestSessions = new Map();

/**
 * Credentials the device has already rejected. Requests with these fail
 * immediately instead of hitting the device, so background polling can't
 * burn through the device's failed-login limit.
 */
const rejectedCredentials = new Set();

function credentialKey(baseUrl, config) {
  return `${baseUrl}|${config.username}|${md5(String(config.password))}`;
}

/**
 * Allow one more attempt with these credentials. Only call this for an
 * explicit user action (pressing Connect), never from automatic retries.
 */
function forgetRejectedCredentials(config) {
  rejectedCredentials.delete(credentialKey(buildBaseUrl(config), config));
}

/**
 * Perform an HTTP request with Digest Authentication.
 *
 * Reuses the last challenge for these credentials when we have one. On a
 * 401 it retries once with the new challenge — but only if the device
 * actually issued a new nonce; a 401 for the nonce we just used means the
 * credentials are wrong, and retrying would just add a failed login.
 *
 * @returns {{ status: number, headers: Headers, data: string|ArrayBuffer }}
 */
async function digestFetch(config, method, urlPath, body = null) {
  const baseUrl = buildBaseUrl(config);
  const url = `${baseUrl}${urlPath}`;
  const isImage = urlPath.includes('/picture');
  const credKey = credentialKey(baseUrl, config);

  if (rejectedCredentials.has(credKey)) {
    throw new AuthError('Device rejected the username or password');
  }

  const send = (authorization) => fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/xml' } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body,
  });
  const authorize = (session) => buildDigestHeader(
    method.toUpperCase(), urlPath, session, config.username, config.password);

  const reject = () => {
    digestSessions.delete(credKey);
    rejectedCredentials.add(credKey);
    return new AuthError('Device rejected the username or password');
  };

  const cached = digestSessions.get(credKey);
  let resp = await send(cached ? authorize(cached) : null);

  if (resp.status === 401) {
    const session = createDigestSession(resp.headers.get('WWW-Authenticate'));
    const nonceExpired = cached && (
      session.challenge.nonce !== cached.challenge.nonce || /^true$/i.test(session.challenge.stale ?? ''));
    if (cached && !nonceExpired) throw reject();

    // First contact, or the cached nonce expired — retry with the new challenge.
    digestSessions.set(credKey, session);
    resp = await send(authorize(session));
    if (resp.status === 401) throw reject();
  }

  if (!resp.ok) {
    throw new Error(`ISAPI ${method} ${urlPath} failed: HTTP ${resp.status}`);
  }

  const data = isImage ? await resp.arrayBuffer() : await resp.text();
  return { status: resp.status, headers: resp.headers, data };
}
