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

/* ── Digest Auth helpers ────────────────────────────────────────────────── */

/**
 * Parse the WWW-Authenticate header returned by the device into key/value
 * pairs (realm, nonce, qop, opaque, etc.).
 */
function parseDigestChallenge(header) {
  const params = {};
  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2] || match[3];
  }
  return params;
}

let nc = 0;

/**
 * Build an HTTP Digest Authorization header value.
 */
function buildDigestHeader(method, uri, challenge, username, password) {
  nc++;
  const ncStr = nc.toString(16).padStart(8, '0');
  const cnonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop || 'auth';
  const response = md5(`${ha1}:${challenge.nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`);

  let header = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"`;
  if (challenge.qop) header += `, qop=${qop}, nc=${ncStr}, cnonce="${cnonce}"`;
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  return header;
}

/**
 * Perform an HTTP request with Digest Authentication.
 *
 * 1. Send initial request (expect 401)
 * 2. Parse WWW-Authenticate challenge
 * 3. Retry with computed Authorization header
 *
 * @returns {{ status: number, headers: Headers, data: string|ArrayBuffer }}
 */
async function digestFetch(config, method, urlPath, body = null) {
  const baseUrl = `http://${config.host}:${config.port || 80}`;
  const url = `${baseUrl}${urlPath}`;
  const isImage = urlPath.includes('/picture');
  const headers = {};
  if (body) headers['Content-Type'] = 'application/xml';

  // First attempt — expect 401
  const first = await fetch(url, {
    method,
    headers,
    body,
  });

  if (first.status !== 401) {
    const data = isImage ? await first.arrayBuffer() : await first.text();
    return { status: first.status, headers: first.headers, data };
  }

  const wwwAuth = first.headers.get('WWW-Authenticate') || '';
  if (!wwwAuth.startsWith('Digest')) {
    throw new Error('Device did not return Digest authentication challenge');
  }

  const challenge = parseDigestChallenge(wwwAuth);
  const authHeader = buildDigestHeader(method.toUpperCase(), urlPath, challenge, config.username, config.password);

  const second = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      ...(body ? { 'Content-Type': 'application/xml' } : {}),
    },
    body,
  });

  if (!second.ok) {
    throw new Error(`ISAPI ${method} ${urlPath} failed: HTTP ${second.status}`);
  }

  const data = isImage ? await second.arrayBuffer() : await second.text();
  return { status: second.status, headers: second.headers, data };
}
