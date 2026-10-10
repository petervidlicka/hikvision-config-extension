/**
 * Digest auth against a local mock device: RFC 2617 vector, nonce reuse and
 * expiry, the guard that keeps rejected credentials off the device (one
 * retry for all requests in flight), the device's explanation of a rejected
 * login, error answers, and time limits.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError, buildBaseUrl, buildDigestHeader, credentialKey, digestFetch, digestSessions, forgetDigestSessions,
  forgetRejectedCredentials, md5, parseDigestChallenge, pickQop, rejectedCredentials,
} from '../../extension/lib/digest-auth.js';
import { IsapiError, NetworkError, TimeoutError } from '../../extension/lib/errors.js';

const nodeMd5 = (s) => crypto.createHash('md5').update(s).digest('hex');

describe('md5', () => {
  it('matches Node for ASCII and UTF-8 input', () => {
    expect(md5('')).toBe(nodeMd5(''));
    expect(md5('héllo wörld'.repeat(20))).toBe(nodeMd5('héllo wörld'.repeat(20)));
  });
});

describe('Digest header', () => {
  it('matches the RFC 2617 §3.5 example', () => {
    const session = {
      challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41' },
      qop: 'auth',
      nc: 0,
    };
    const header = buildDigestHeader('GET', '/dir/index.html', session, 'Mufasa', 'Circle Of Life', '0a4f113b');
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
  });

  it('prefers the MD5 challenge and parses qop lists and empty values', () => {
    const c = parseDigestChallenge(
      'Digest realm="r", nonce="n2", algorithm=SHA-256, qop="auth", Digest realm="r", nonce="n1", qop="auth,auth-int", opaque=""');
    expect(c.nonce).toBe('n1');
    expect(c.opaque).toBe('');
    expect(pickQop(c.qop)).toBe('auth');
    expect(() => pickQop('auth-int')).toThrow();
    expect(() => parseDigestChallenge('Basic realm="x"')).toThrow();
  });
});

/** An error answer as the DS-7604NI sends it. */
const responseStatus = (path, statusCode, statusString, subStatusCode) =>
  '<?xml version="1.0" encoding="UTF-8" ?>\n<ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">\n' +
  `<requestURL>${path}</requestURL>\n<statusCode>${statusCode}</statusCode>\n<statusString>${statusString}</statusString>\n` +
  `<subStatusCode>${subStatusCode}</subStatusCode>\n</ResponseStatus>\n`;

/** The start of a 401 body as V4.75 sends it to a request without credentials, or with wrong ones. */
const HTML_401 = '<!DOCTYPE html>\n<head>\n    <title>Unauthorized</title>\n</head>\n<body>\n<h2>Access Error: 401 -- Unauthorized</h2>\n</body>\n</html>\n';

/** A rejected userCheck as the web UI and HCNetSDK parse it (not captured from V4.75: that costs a failed login). */
const userCheckRejected = ({ lockStatus, unlockTime, retryLoginTime }) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<userCheck version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">\n' +
  `<statusValue>401</statusValue>\n<statusString>Unauthorized</statusString>\n<lockStatus>${lockStatus}</lockStatus>\n` +
  `<unlockTime>${unlockTime}</unlockTime>\n<retryLoginTime>${retryLoginTime}</retryLoginTime>\n</userCheck>\n`;

describe('digestFetch against a mock device', () => {
  const REALM = 'IP Camera';
  let server, cfg;
  /**
   * Like the DS-7604NI (V4.75): every 401 carries a fresh nonce, and a nonce
   * it issued stays valid, also on another connection, until expireNonces().
   * A request with a valid nonce and the wrong password is a failed login.
   * `lock` makes a rejected userCheck explain itself in XML; everything else
   * gets the HTML page.
   */
  const device = {
    password: 'secret', requests: 0, failedLogins: 0, issued: 0, nonces: new Set(),
    /** @type {null | {lockStatus: string, unlockTime: number, retryLoginTime: number}} */
    lock: null,
    /** @type {null | {at: number, arrived: () => void, release: Promise<void>}} holds the `at`-th request until released */
    hold: null,
    /** Nonces of the requests the device accepted, in order. */
    accepted: [],
    expireNonces() { this.nonces.clear(); },
  };
  /** Authenticated requests the device never answers, like a stalled NVR. */
  const stalled = [];
  /** How long each step of /slow takes: the challenge, and the authenticated answer. */
  const SLOW_STEP_MS = 150;

  beforeAll(async () => {
    const handle = (req, res) => {
      if (req.socket.destroyed) return; // the client gave up while /slow was waiting
      const challenge = (body = HTML_401, type = 'text/html') => {
        const nonce = `0123456789abcdef:${(++device.issued).toString(16)}`;
        device.nonces.add(nonce);
        res.writeHead(401, {
          'Content-Type': type,
          'WWW-Authenticate': `Digest realm="${REALM}", domain="/", qop="auth", nonce="${nonce}", opaque="799d5", algorithm="MD5", stale="FALSE"`,
        });
        res.end(body);
      };
      const auth = req.headers.authorization;
      if (!auth) return challenge();
      const p = Object.fromEntries([...auth.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
      if (!device.nonces.has(p.nonce)) return challenge();
      const ha1 = nodeMd5(`${p.username}:${REALM}:${device.password}`);
      const expected = nodeMd5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${nodeMd5(`${req.method}:${p.uri}`)}`);
      if (p.response !== expected) {
        device.failedLogins++;
        if (device.lock && req.url === '/ISAPI/Security/userCheck') return challenge(userCheckRejected(device.lock), 'application/xml');
        return challenge();
      }
      device.accepted.push(p.nonce);
      if (req.url === '/hang') return void stalled.push(res);
      if (req.url === '/forbidden') {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        return void res.end(responseStatus(req.url, 4, 'Invalid Operation', 'notSupport'));
      }
      if (req.url === '/ISAPI/Streaming/channels/501/picture') {
        res.writeHead(503, { 'Content-Type': 'application/xml' });
        return void res.end(responseStatus(req.url, 2, 'Device Busy', 'serviceUnavailable'));
      }
      res.writeHead(200);
      res.end('<ok/>');
    };
    server = http.createServer(async (req, res) => {
      const n = ++device.requests;
      if (device.hold?.at === n) {
        device.hold.arrived();
        await device.hold.release;
      }
      if (req.url === '/slow') return void setTimeout(() => handle(req, res), SLOW_STEP_MS);
      handle(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cfg = { host: '127.0.0.1', port: server.address().port, username: 'admin', password: 'secret' };
  });
  afterAll(() => {
    stalled.forEach(res => res.destroy());
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    device.requests = 0;
    device.failedLogins = 0;
    device.accepted = [];
    // A password-change test leaves these credentials marked as rejected
    forgetRejectedCredentials(cfg);
  });

  /** Change the password on the device for one test. */
  const withPassword = async (password, run) => {
    device.password = password;
    try {
      await run();
    } finally {
      device.password = 'secret';
    }
  };

  it('reuses the nonce: one request per call after the first', async () => {
    const first = await digestFetch(cfg, 'GET', '/ISAPI/System/deviceInfo');
    expect(first.data).toBe('<ok/>');
    expect(device.requests).toBe(2);
    await digestFetch(cfg, 'GET', '/ISAPI/x');
    await digestFetch(cfg, 'GET', '/ISAPI/y');
    expect(device.requests).toBe(4);
  });

  it('refreshes an expired nonce and retries once', async () => {
    device.expireNonces();
    await digestFetch(cfg, 'GET', '/ISAPI/z');
    expect(device.requests).toBe(2);
  });

  it('never sends rejected credentials to the device again until Connect', async () => {
    const bad = { ...cfg, password: 'wrong' };
    await expect(digestFetch(bad, 'GET', '/a')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const after = device.requests;
    await expect(digestFetch(bad, 'GET', '/a')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(device.requests).toBe(after);

    forgetRejectedCredentials(bad);
    await expect(digestFetch(bad, 'GET', '/a')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(device.requests).toBe(after + 2);
    expect((await digestFetch(cfg, 'GET', '/ok')).status).toBe(200);
  });

  it('costs two failed logins when the password changes mid-session, then sends nothing', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    await withPassword('changed-on-device', async () => {
      // The 401 for the cached nonce looks just like an expired one, so it takes the retry to tell
      await expect(digestFetch(cfg, 'GET', '/b')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      expect(device.failedLogins).toBe(2);
      const after = device.requests;
      await expect(digestFetch(cfg, 'GET', '/b')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      expect(device.requests).toBe(after);
    });
  });

  it('retries once for all parallel requests when the password changes', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    await withPassword('changed-on-device', async () => {
      const results = await Promise.allSettled([1, 2, 3, 4].map(i => digestFetch(cfg, 'GET', `/grid/${i}`)));
      expect(results.map(r => r.reason)).toEqual(Array(4).fill(expect.any(AuthError)));
      // Each was already sent with the cached nonce; then one retry, not four
      expect(device.failedLogins).toBe(5);
      expect(device.requests).toBe(2 + 5);
    });
  });

  it('keeps requests that start during the retry off the device: 4 requests, 2 failed logins', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    let arrived;
    const retryArrived = new Promise(resolve => { arrived = resolve; });
    let release;
    // Hold the retry (the 2nd request after warming up) at the device
    device.hold = { at: device.requests + 2, arrived, release: new Promise(resolve => { release = resolve; }) };
    try {
      await withPassword('changed-on-device', async () => {
        const first = digestFetch(cfg, 'GET', '/grid/1').catch(e => e);
        await retryArrived;
        const others = [2, 3, 4].map(i => digestFetch(cfg, 'GET', `/grid/${i}`).catch(e => e));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(device.requests).toBe(2 + 2);
        release();
        expect(await Promise.all([first, ...others])).toEqual(Array(4).fill(expect.any(AuthError)));
        expect(device.failedLogins).toBe(2);
        expect(device.requests).toBe(2 + 2);
      });
    } finally {
      device.hold = null;
      release();
    }
  });

  it('costs one failed login for parallel first requests with a wrong password', async () => {
    const bad = { ...cfg, username: 'first-contact', password: 'wrong' };
    const results = await Promise.allSettled([1, 2, 3, 4].map(i => digestFetch(bad, 'GET', `/grid/${i}`)));
    expect(results.map(r => r.reason)).toEqual(Array(4).fill(expect.any(AuthError)));
    expect(device.failedLogins).toBe(1);
  });

  it('gets parallel requests through a nonce rotation with one new challenge', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    device.accepted = [];
    device.expireNonces();
    const results = await Promise.all([1, 2, 3, 4].map(i => digestFetch(cfg, 'GET', `/grid/${i}`)));
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200]);
    expect(device.failedLogins).toBe(0);
    // 4 expired, 1 retry that answers the new challenge, 3 resent with it
    expect(device.requests).toBe(2 + 4 + 1 + 3);
    expect(new Set(device.accepted).size).toBe(1);
  });

  it('starts from a fresh challenge after forgetting the device’s sessions', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    forgetDigestSessions(cfg);
    expect(digestSessions.has(credentialKey(buildBaseUrl(cfg), cfg))).toBe(false);
    // A password changed meanwhile now costs only the one credentialed attempt
    await withPassword('changed-on-device', async () => {
      await expect(digestFetch(cfg, 'GET', '/b')).rejects.toBeInstanceOf(AuthError);
      expect(device.failedLogins).toBe(1);
    });
  });

  it('says when the device has locked logins, or how many attempts are left', async () => {
    const bad = { ...cfg, username: 'locked-out', password: 'wrong' };
    device.lock = { lockStatus: 'lock', unlockTime: 1500, retryLoginTime: 0 };
    try {
      const locked = await digestFetch(bad, 'GET', '/ISAPI/Security/userCheck').catch(e => e);
      expect(locked).toBeInstanceOf(AuthError);
      expect(locked).toMatchObject({ statusValue: 401, locked: true, unlockSeconds: 1500, attemptsLeft: 0 });
      expect(locked.message).toBe('The device has temporarily locked logins from this computer — try again in 25 min');
      // Refused without asking the device again, for the same reason
      const before = device.requests;
      await expect(digestFetch(bad, 'GET', '/ISAPI/x')).rejects.toMatchObject({ locked: true, unlockSeconds: 1500 });
      expect(device.requests).toBe(before);

      device.lock = { lockStatus: 'unlock', unlockTime: 0, retryLoginTime: 3 };
      forgetRejectedCredentials(bad);
      const wrong = await digestFetch(bad, 'GET', '/ISAPI/Security/userCheck').catch(e => e);
      expect(wrong).toMatchObject({ locked: false, attemptsLeft: 3 });
      expect(wrong.message).toBe('Wrong user name or password — 3 attempts left before the device locks this computer out');
    } finally {
      device.lock = null;
    }
  });

  it('keeps the plain message when the 401 is an HTML page', async () => {
    const err = await digestFetch({ ...cfg, username: 'html', password: 'wrong' }, 'GET', '/ISAPI/System/deviceInfo').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(device.failedLogins).toBe(1);
    expect(err.message).toBe('Device rejected the username or password');
    expect(err).toMatchObject({ statusValue: undefined, locked: undefined, unlockSeconds: undefined, attemptsLeft: undefined });
  });

  it('rejects hosts and ports that could redirect the request', async () => {
    await expect(digestFetch({ ...cfg, host: 'evil.com/x?' }, 'GET', '/a')).rejects.toThrow(/Invalid host/);
    await expect(digestFetch({ ...cfg, port: 99999 }, 'GET', '/a')).rejects.toThrow(/Invalid port/);
  });

  it('reads the device’s reason from an error answer, also for snapshots', async () => {
    const err = await digestFetch(cfg, 'GET', '/forbidden').catch(e => e);
    expect(err).toBeInstanceOf(IsapiError);
    expect(err).toMatchObject({ method: 'GET', path: '/forbidden', httpStatus: 403, statusCode: 4, subStatusCode: 'notSupport' });
    expect(err.message).toMatch(/doesn’t support this/);

    await expect(digestFetch(cfg, 'GET', '/ISAPI/Streaming/channels/501/picture')).rejects.toMatchObject({
      httpStatus: 503, statusString: 'Device Busy', subStatusCode: 'serviceUnavailable',
    });
  });

  it('times out without touching the cached challenge or the rejected credentials', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    const key = credentialKey(buildBaseUrl(cfg), cfg);
    const session = digestSessions.get(key);
    const before = device.requests;

    const err = await digestFetch(cfg, 'GET', '/hang', null, { timeoutMs: 100 }).catch(e => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ path: '/hang', timeoutMs: 100, address: `127.0.0.1:${cfg.port}` });
    expect(device.requests).toBe(before + 1);
    expect(digestSessions.get(key)).toBe(session);
    expect(rejectedCredentials.has(key)).toBe(false);

    await digestFetch(cfg, 'GET', '/ok');
    expect(device.requests).toBe(before + 2);
  });

  it('counts the Digest challenge round trip towards the time limit', async () => {
    // Each step fits in the limit on its own, but the two together don't
    const limit = SLOW_STEP_MS + 100;
    const fresh = { ...cfg, username: 'viewer' };
    const err = await digestFetch(fresh, 'GET', '/slow', null, { timeoutMs: limit }).catch(e => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ path: '/slow', timeoutMs: limit });
    expect(device.requests).toBe(2); // ran out during the authenticated retry, after the challenge
    expect(rejectedCredentials.has(credentialKey(buildBaseUrl(fresh), fresh))).toBe(false);

    // With room for both steps, the same first contact succeeds
    const other = { ...cfg, username: 'viewer2' };
    expect((await digestFetch(other, 'GET', '/slow', null, { timeoutMs: 4 * limit })).data).toBe('<ok/>');
  });

  it('passes the caller’s abort through unchanged', async () => {
    const controller = new AbortController();
    const pending = digestFetch(cfg, 'GET', '/hang', null, { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 20);
    const err = await pending.catch(e => e);
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(NetworkError);
  });

  it('reports an address where nothing listens as a network failure, not a rejected login', async () => {
    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));

    const unreachable = { ...cfg, port };
    const err = await digestFetch(unreachable, 'GET', '/a', null, { timeoutMs: 2000 }).catch(e => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(new RegExp(`127\\.0\\.0\\.1:${port}`));
    expect(rejectedCredentials.has(credentialKey(buildBaseUrl(unreachable), unreachable))).toBe(false);
  });
});
