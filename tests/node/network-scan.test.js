/**
 * Network scanner with a stubbed fetch: finds Digest-protected devices,
 * caps concurrency, stops after the first subnet with a hit, and cancels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateSubnets, scanForHikvision } from '../../extension/lib/network-scan.js';

const devices = new Map([
  ['192.168.0.108', { status: 401, auth: 'Digest realm="x", nonce="n", qop="auth"' }],
  ['192.168.0.1', { status: 404 }],
  ['192.168.0.50', { status: 401, auth: 'Basic realm="x"' }],
  ['10.0.0.20', { status: 401, auth: 'Digest realm="y"' }],
]);
let stats;

beforeEach(() => {
  stats = { probes: 0, inFlight: 0, maxInFlight: 0 };
  vi.stubGlobal('fetch', (url, { signal }) => new Promise((resolve, reject) => {
    stats.probes++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const done = (fn) => { stats.inFlight--; fn(); };
    const dev = devices.get(new URL(url).hostname);
    if (dev) {
      setTimeout(() => done(() => resolve(new Response(null, {
        status: dev.status, headers: dev.auth ? { 'www-authenticate': dev.auth } : {},
      }))), 5);
      return;
    }
    // A host that doesn't exist: hangs until the probe times out or is aborted
    signal.addEventListener('abort', () => done(() => reject(new Error('aborted'))));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('candidateSubnets', () => {
  it('puts known hosts first and ignores non-IPs', () => {
    expect(candidateSubnets(['10.0.0.5', 'not-an-ip', '']).slice(0, 3)).toEqual(['10.0.0', '192.168.0', '192.168.1']);
  });
});

describe('scanForHikvision', () => {
  it('finds Digest devices only and stops after the first subnet with a hit', async () => {
    const found = await scanForHikvision({ subnets: ['192.168.0', '10.0.0'], probeTimeoutMs: 50 });
    expect(found).toEqual([{ ip: '192.168.0.108', port: 80 }]);
    expect(stats.probes).toBe(254);
    expect(stats.maxInFlight).toBeLessThanOrEqual(48);
  });

  it('moves on past empty subnets', async () => {
    const found = await scanForHikvision({ subnets: ['192.168.9', '10.0.0'], probeTimeoutMs: 50 });
    expect(found[0].ip).toBe('10.0.0.20');
    expect(stats.probes).toBe(508);
  });

  it('stops promptly when cancelled', async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 50);
    await scanForHikvision({ subnets: ['172.16.0', '172.16.1'], signal: abort.signal });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
