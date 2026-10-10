/**
 * Digest auth against a local mock device: RFC 2617 vector, nonce reuse and
 * expiry, and the guard that keeps rejected credentials off the device.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDigestHeader, digestFetch, forgetRejectedCredentials, md5, parseDigestChallenge, pickQop,
} from '../../extension/lib/digest-auth.js';

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

describe('digestFetch against a mock device', () => {
  const REALM = 'IP Camera';
  let server, cfg;
  const device = { password: 'secret', nonce: 'nonce-1', requests: 0, failedLogins: 0 };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      device.requests++;
      const challenge = () => {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${device.nonce}", qop="auth", opaque=""` });
        res.end();
      };
      const auth = req.headers.authorization;
      if (!auth) return challenge();
      const p = Object.fromEntries([...auth.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
      if (p.nonce !== device.nonce) return challenge();
      const ha1 = nodeMd5(`${p.username}:${REALM}:${device.password}`);
      const expected = nodeMd5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${nodeMd5(`${req.method}:${p.uri}`)}`);
      if (p.response !== expected) {
        device.failedLogins++;
        return challenge();
      }
      res.writeHead(200);
      res.end('<ok/>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    cfg = { host: '127.0.0.1', port: server.address().port, username: 'admin', password: 'secret' };
  });
  afterAll(() => server.close());
  beforeEach(() => {
    device.requests = 0;
    device.failedLogins = 0;
  });

  it('reuses the nonce: one request per call after the first', async () => {
    const first = await digestFetch(cfg, 'GET', '/ISAPI/System/deviceInfo');
    expect(first.data).toBe('<ok/>');
    expect(device.requests).toBe(2);
    await digestFetch(cfg, 'GET', '/ISAPI/x');
    await digestFetch(cfg, 'GET', '/ISAPI/y');
    expect(device.requests).toBe(4);
  });

  it('refreshes an expired nonce and retries once', async () => {
    device.nonce = 'nonce-2';
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

  it('costs exactly one failed login when the password changes mid-session', async () => {
    await digestFetch(cfg, 'GET', '/warm');
    device.password = 'changed-on-device';
    try {
      await expect(digestFetch(cfg, 'GET', '/b')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      await expect(digestFetch(cfg, 'GET', '/b')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      expect(device.failedLogins).toBe(1);
    } finally {
      device.password = 'secret';
    }
  });

  it('rejects hosts and ports that could redirect the request', async () => {
    await expect(digestFetch({ ...cfg, host: 'evil.com/x?' }, 'GET', '/a')).rejects.toThrow(/Invalid host/);
    await expect(digestFetch({ ...cfg, port: 99999 }, 'GET', '/a')).rejects.toThrow(/Invalid port/);
  });
});
