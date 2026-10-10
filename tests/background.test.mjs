/**
 * End-to-end tests for background.js message handling, with mocked chrome
 * APIs and a mock Hikvision device. Run: node tests/background.test.mjs
 */
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const h = s => crypto.createHash('md5').update(s).digest('hex');
const PASS = 'secret'; let reqs = 0, badLogins = 0;
const server = http.createServer((req, res) => {
  reqs++;
  const a = req.headers.authorization;
  const ch = () => { res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="R", nonce="N", qop="auth"' }); res.end(); };
  if (!a) return ch();
  const p = Object.fromEntries([...a.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
  const exp = h(`${h(`${p.username}:R:${PASS}`)}:N:${p.nc}:${p.cnonce}:auth:${h(`${req.method}:${p.uri}`)}`);
  if (p.response !== exp) { badLogins++; return ch(); }
  if (req.url === '/ISAPI/System/deviceInfo') { res.end('<DeviceInfo><deviceName>NVR</deviceName></DeviceInfo>'); return; }
  if (req.url === '/ISAPI/System/Video/inputs/channels') { res.end('<VideoInputChannelList><VideoInputChannel><id>1</id><name>Front &lt;b&gt; &amp; Back &#x263A;</name></VideoInputChannel></VideoInputChannelList>'); return; }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const EXT = 'chrome-extension://abc/';
let listener;
const chrome = { runtime: { id: 'abc', getURL: p => EXT + p, onMessage: { addListener: f => listener = f } }, system: {} };
const ctx = vm.createContext({ chrome, fetch, crypto: globalThis.crypto, TextEncoder, Uint8Array, Uint32Array, DataView, console, setTimeout, clearTimeout, AbortController, btoa });
ctx.importScripts = f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
const send = (msg, sender = { id: 'abc', url: EXT + 'app.html' }) => new Promise(res => { const keep = listener(msg, sender, res); if (!keep) res('IGNORED'); });
const cfg = { host: '127.0.0.1', port: server.address().port, username: 'admin', password: PASS };

assert.equal(await send({ action: 'testConnection', config: cfg }, { id: 'other', url: 'https://evil.com' }), 'IGNORED');
assert.equal(await send({ action: 'testConnection', config: cfg }, { id: 'abc', url: 'https://evil.com/' }), 'IGNORED');
let r = await send({ action: 'testConnection', config: cfg }); assert.equal(r.success, true); assert.equal(r.device.deviceName, 'NVR');
r = await send({ action: 'getChannels', config: cfg }); assert.equal(r.channels[0].name, 'Front <b> & Back \u263A');
r = await send({ action: 'getMotionDetection', config: cfg, channelId: '1/../../x' }); assert.match(r.error, /Invalid channel/);

const bad = { ...cfg, password: 'nope' }; badLogins = 0;
r = await send({ action: 'testConnection', config: bad }); assert.equal(r.code, 'AUTH_FAILED');
r = await send({ action: 'getChannels', config: bad }); assert.equal(r.code, 'AUTH_FAILED');
for (let i = 0; i < 10; i++) { r = await send({ action: 'getSnapshot', config: bad, channelId: '1' }); assert.equal(r.code, 'AUTH_FAILED'); }
r = await send({ action: 'getEventTriggers', config: bad, channelId: '1' }); assert.equal(r.code, 'AUTH_FAILED');
assert.equal(badLogins, 1, `only one failed login should reach the device, got ${badLogins}`);
r = await send({ action: 'testConnection', config: bad }); assert.equal(badLogins, 2, 'Connect click gets one fresh attempt');
server.close(); console.log('background tests passed; total device requests', reqs);
