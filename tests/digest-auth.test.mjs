/**
 * Tests for lib/digest-auth.js against a mock Digest-auth device.
 * Run: node tests/digest-auth.test.mjs
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const src = fs.readFileSync(path.join(root, 'lib/digest-auth.js'), 'utf8');
const ctx = vm.createContext({ fetch, crypto: globalThis.crypto, TextEncoder, Uint8Array, Uint32Array, DataView, Error, Map, Set, Number, String, Array });
vm.runInContext(src + '\nthis.api={md5,buildDigestHeader,parseDigestChallenge,pickQop,digestFetch,forgetRejectedCredentials,AuthError};', ctx);
const api = ctx.api;
const h = s => crypto.createHash('md5').update(s).digest('hex');

// MD5 sanity
assert.equal(api.md5(''), h(''));
assert.equal(api.md5('héllo wörld'.repeat(20)), h('héllo wörld'.repeat(20)));

// RFC 2617 §3.5 vector
ctx.randomHex = () => '0a4f113b';
const sess = { challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41' }, qop: 'auth', nc: 0 };
const hdr = api.buildDigestHeader('GET', '/dir/index.html', sess, 'Mufasa', 'Circle Of Life');
assert.match(hdr, /response="6629fae49393a05397450978507c4ef1"/);
// parsing: multiple challenges, qop list, empty opaque
const c = api.parseDigestChallenge('Digest realm="r", nonce="n2", algorithm=SHA-256, qop="auth", Digest realm="r", nonce="n1", qop="auth,auth-int", opaque=""');
assert.equal(c.nonce, 'n1'); assert.equal(c.opaque, ''); assert.equal(api.pickQop(c.qop), 'auth');
assert.throws(() => api.pickQop('auth-int'));
assert.throws(() => api.parseDigestChallenge('Basic realm="x"'));
ctx.randomHex = (n) => crypto.randomBytes(n).toString('hex');

// Mock device
let PASS = 'secret'; let nonce = 'nonce-1'; const stats = { req: 0, fail: 0 };
const server = http.createServer((req, res) => {
  stats.req++;
  const a = req.headers.authorization;
  const challenge = () => { res.writeHead(401, { 'WWW-Authenticate': `Digest realm="IP Camera", nonce="${nonce}", qop="auth", opaque=""` }); res.end(); };
  if (!a) return challenge();
  const p = Object.fromEntries([...a.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
  if (p.nonce !== nonce) return challenge();
  const exp = h(`${h(`${p.username}:IP Camera:${PASS}`)}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${h(`${req.method}:${p.uri}`)}`);
  if (p.response !== exp) { stats.fail++; return challenge(); }
  res.writeHead(200); res.end('<ok/>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfg = { host: '127.0.0.1', port, username: 'admin', password: PASS };

let r = await api.digestFetch(cfg, 'GET', '/ISAPI/System/deviceInfo');
assert.equal(r.data, '<ok/>'); assert.equal(stats.req, 2);
await api.digestFetch(cfg, 'GET', '/ISAPI/x'); await api.digestFetch(cfg, 'GET', '/ISAPI/y');
assert.equal(stats.req, 4, 'cached nonce: one request each');
nonce = 'nonce-2';
await api.digestFetch(cfg, 'GET', '/ISAPI/z');
assert.equal(stats.req, 6, 'expired nonce: refresh + retry');

const bad = { ...cfg, password: 'wrong' };
await assert.rejects(api.digestFetch(bad, 'GET', '/a'), e => e.code === 'AUTH_FAILED');
const before = stats.req;
await assert.rejects(api.digestFetch(bad, 'GET', '/a'), e => e.code === 'AUTH_FAILED');
assert.equal(stats.req, before, 'rejected creds never hit the device again');
api.forgetRejectedCredentials(bad);
await assert.rejects(api.digestFetch(bad, 'GET', '/a'), e => e.code === 'AUTH_FAILED');
assert.equal(stats.req, before + 2, 'explicit retry allowed once');
r = await api.digestFetch(cfg, 'GET', '/ok'); assert.equal(r.status, 200);

await assert.rejects(api.digestFetch({ ...cfg, host: 'evil.com/x?' }, 'GET', '/a'), /Invalid host/);
await assert.rejects(api.digestFetch({ ...cfg, port: 99999 }, 'GET', '/a'), /Invalid port/);
PASS = 'changed-on-device'; const f0 = stats.fail;
await assert.rejects(api.digestFetch(cfg, 'GET', '/b'), e => e.code === 'AUTH_FAILED');
assert.equal(stats.fail - f0, 1, 'password changed mid-session costs exactly one failed login');
await assert.rejects(api.digestFetch(cfg, 'GET', '/b'), e => e.code === 'AUTH_FAILED');
assert.equal(stats.fail - f0, 1);
server.close(); console.log('all digest tests passed');
