/**
 * Tests for lib/network-scan.js with a stubbed fetch (no real network).
 * Run: node tests/network-scan.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const devices = new Map([
  ['192.168.0.108', { status: 401, auth: 'Digest realm="x", nonce="n", qop="auth"' }],
  ['192.168.0.1', { status: 404 }],                       // router: not a candidate
  ['192.168.0.50', { status: 401, auth: 'Basic realm="x"' }], // not Digest
  ['10.0.0.20', { status: 401, auth: 'Digest realm="y"' }],
]);
let inFlight = 0, maxInFlight = 0, probes = 0;
const fakeFetch = (url, { signal }) => new Promise((resolve, reject) => {
  probes++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  const ip = new URL(url).hostname;
  const done = (fn) => { inFlight--; fn(); };
  const dev = devices.get(ip);
  if (dev) return setTimeout(() => done(() => resolve({ status: dev.status, headers: new Headers(dev.auth ? { 'www-authenticate': dev.auth } : {}) })), 5);
  signal.addEventListener('abort', () => done(() => reject(new Error('aborted')))); // dead host: hangs until timeout
});

const ctx = vm.createContext({ fetch: fakeFetch, AbortController, setTimeout, clearTimeout, Promise, Array, Set, Headers });
vm.runInContext(fs.readFileSync(path.join(root, 'lib/network-scan.js'), 'utf8') + ';this.api={scanForHikvision,candidateSubnets}', ctx);
const { scanForHikvision, candidateSubnets } = ctx.api;

assert.deepEqual([...candidateSubnets(['10.0.0.5', 'not-an-ip', ''])].slice(0, 3), ['10.0.0', '192.168.0', '192.168.1']);

let found = await scanForHikvision({ subnets: ['192.168.0', '10.0.0'] });
assert.deepEqual(JSON.parse(JSON.stringify(found)), [{ ip: '192.168.0.108', port: 80 }], 'stops after first subnet with a hit');
assert.equal(probes, 254);
assert.ok(maxInFlight <= 48, `concurrency capped, saw ${maxInFlight}`);

probes = 0;
found = await scanForHikvision({ subnets: ['192.168.9', '10.0.0'] });
assert.equal(found[0].ip, '10.0.0.20', 'falls through empty subnets');
assert.equal(probes, 508);

const abort = new AbortController();
const t = Date.now();
setTimeout(() => abort.abort(), 50);
await scanForHikvision({ subnets: ['172.16.0', '172.16.1'], signal: abort.signal });
assert.ok(Date.now() - t < 500, 'cancel stops promptly');
console.log('network scan tests passed');
