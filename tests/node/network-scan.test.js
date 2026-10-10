/**
 * Network scanner with a stubbed fetch: finds devices that ask for a Digest
 * login on port 80 or 8080, confirms them with an unauthenticated
 * /SDK/activateStatus (keeping those that don't confirm as possible devices),
 * caps concurrency, stops after the first subnet with a hit, and cancels.
 * Also what each probe costs in scan time, and the texts the results show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkActivation, parseActivateStatus } from '../../extension/lib/device-probe.js';
import {
  NOT_ACTIVATED_HINT, candidateSubnets, describeFoundDevice, describeScanResults, scanForHikvision,
} from '../../extension/lib/network-scan.js';

const DEVICE_INFO = '/ISAPI/System/deviceInfo';
const ACTIVATE_STATUS = '/SDK/activateStatus';

/**
 * The DS-7604NI's unauthenticated /SDK/activateStatus answer, as captured.
 * @param {boolean} activated
 */
const activateStatus = (activated) => ({
  status: 200,
  body: '<?xml version="1.0" encoding="UTF-8" ?>\n<ActivateStatus version="1.0" ' +
    `xmlns="http://www.hikvision.com/ver20/XMLSchema">\n<Activated>${activated}</Activated>\n</ActivateStatus>\n`,
});
/** The DS-7604NI's unauthenticated answer to any /ISAPI path. */
const DIGEST = {
  status: 401,
  headers: { 'www-authenticate': 'Digest realm="0123456789abcdef01234567", domain="/", qop="auth", nonce="n", algorithm="MD5", stale="FALSE"' },
};

/**
 * What answers where, by "host:port" and path; a path left out answers 404.
 * A host listed on one port refuses connections on the others at once; a
 * host not listed at all never answers, like an address with nothing on it.
 * `hang` never answers; `slowBody` sends its headers but never finishes.
 * @type {Map<string, Record<string, {status: number, headers?: Record<string, string>, body?: string, hang?: boolean, slowBody?: boolean}>>}
 */
const answers = new Map([
  // The test NVR
  ['192.168.0.108:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: activateStatus(true) }],
  // A router's own pages, and a NAS behind Basic
  ['192.168.0.1:80', { [DEVICE_INFO]: { status: 404 } }],
  ['192.168.0.50:80', { [DEVICE_INFO]: { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } } }],
  // A new camera moved to port 8080 that hasn't been activated
  ['192.168.0.64:8080', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: activateStatus(false) }],
  // Something else behind Digest, or firmware without activateStatus
  ['192.168.0.70:80', { [DEVICE_INFO]: DIGEST }],
  ['10.0.0.20:80', { [DEVICE_INFO]: { status: 401, headers: { 'www-authenticate': 'Digest realm="y"' } } }],
  // Candidates whose activateStatus doesn't confirm them
  ['172.20.0.1:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: { status: 200, body: '<!DOCTYPE html><html><body>Login</body></html>' } }],
  ['172.20.0.2:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: { status: 200, body: '<ResponseStatus><statusCode>4</statusCode></ResponseStatus>' } }],
  ['172.20.0.3:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: { status: 401, headers: DIGEST.headers } }],
  ['172.20.0.4:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: { status: 200, hang: true } }],
  ['172.20.0.5:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: { status: 200, slowBody: true } }],
  ['172.20.0.6:80', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: { status: 200, body: '<ActivateStatus><Activated>maybe</Activated></ActivateStatus>' } }],
  // One device answering on both ports: confirmed only on 8080, and possible on both
  ['172.21.0.30:80', { [DEVICE_INFO]: DIGEST }],
  ['172.21.0.30:8080', { [DEVICE_INFO]: DIGEST, [ACTIVATE_STATUS]: activateStatus(true) }],
  ['172.21.0.31:80', { [DEVICE_INFO]: DIGEST }],
  ['172.21.0.31:8080', { [DEVICE_INFO]: DIGEST }],
]);
const hosts = new Set([...answers.keys()].map(key => key.split(':')[0]));

/** @type {{probes: number, inFlight: number, maxInFlight: number, requests: {url: URL, credentials?: string, cache?: string}[]}} */
let stats;

/**
 * An error that settles when the request is aborted, as fetch's does.
 * @param {AbortSignal} signal
 * @param {(err: Error) => void} fail
 */
const onAbort = (signal, fail) => {
  if (signal.aborted) fail(new Error('aborted'));
  else signal.addEventListener('abort', () => fail(new Error('aborted')));
};

beforeEach(() => {
  stats = { probes: 0, inFlight: 0, maxInFlight: 0, requests: [] };
  vi.stubGlobal('fetch', (url, { signal, credentials, cache }) => new Promise((resolve, reject) => {
    const u = new URL(url);
    stats.requests.push({ url: u, credentials, cache });
    if (u.pathname === DEVICE_INFO) stats.probes++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const done = (fn) => { stats.inFlight--; fn(); };
    const fail = (err) => done(() => reject(err));
    if (!hosts.has(u.hostname)) {
      // An address with nothing on it: no answer until the probe times out or is cancelled
      onAbort(signal, fail);
      return;
    }
    const site = answers.get(`${u.hostname}:${u.port || 80}`);
    if (!site) {
      setTimeout(() => fail(new TypeError('Failed to fetch')), 5); // connection refused
      return;
    }
    const answer = site[u.pathname] ?? { status: 404 };
    if (answer.hang) {
      onAbort(signal, fail);
      return;
    }
    const body = answer.slowBody
      ? new ReadableStream({ start: (controller) => onAbort(signal, err => controller.error(err)) })
      : answer.body ?? null;
    setTimeout(() => done(() => resolve(new Response(body, { status: answer.status, headers: answer.headers ?? {} }))), 5);
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The /SDK/activateStatus requests made, as "host:port". */
const activationChecks = () => stats.requests
  .filter(r => r.url.pathname === ACTIVATE_STATUS)
  .map(r => `${r.url.hostname}:${r.url.port || 80}`);

describe('candidateSubnets', () => {
  it('puts known hosts first, then the common subnets, then the popular routers’ own', () => {
    expect(candidateSubnets(['10.0.0.5', 'not-an-ip', ''])).toEqual([
      '10.0.0', '192.168.0', '192.168.1', '192.168.2', '10.0.1',
      '192.168.178', '192.168.50', '192.168.88', '192.168.100',
    ]);
  });
});

describe('scanForHikvision', () => {
  it('finds devices that ask for a Digest login on port 80 or 8080, and stops after the first subnet with a hit', async () => {
    const found = await scanForHikvision({ subnets: ['192.168.0', '10.0.0'], probeTimeoutMs: 50 });
    expect(found).toEqual([
      { ip: '192.168.0.64', port: 8080, confirmed: true, activated: false },
      { ip: '192.168.0.70', port: 80, confirmed: false, activated: null },
      { ip: '192.168.0.108', port: 80, confirmed: true, activated: true },
    ]);
    // Every address on both ports, one port after the other
    expect(stats.probes).toBe(2 * 254);
    const probedPorts = stats.requests.filter(r => r.url.pathname === DEVICE_INFO).map(r => r.url.port || '80');
    expect(probedPorts.indexOf('8080')).toBe(254);
    expect(stats.maxInFlight).toBeLessThanOrEqual(48);
  });

  it('asks only the candidates whether they are Hikvision, and never with credentials', async () => {
    await scanForHikvision({ subnets: ['192.168.0'], probeTimeoutMs: 50 });
    expect(activationChecks().sort()).toEqual(['192.168.0.108:80', '192.168.0.64:8080', '192.168.0.70:80']);
    for (const { url, credentials, cache } of stats.requests) {
      expect({ url: url.href, credentials, cache }).toEqual({ url: url.href, credentials: 'omit', cache: 'no-store' });
    }
  });

  it('keeps a candidate whose activateStatus is missing, odd or too slow as a possible device', async () => {
    const found = await scanForHikvision({ subnets: ['172.20.0'], ports: [80], probeTimeoutMs: 50 });
    expect(found).toEqual([1, 2, 3, 4, 5, 6].map(n => ({ ip: `172.20.0.${n}`, port: 80, confirmed: n === 6, activated: null })));
  });

  it('lists an address once, on the port that confirmed it, else on port 80', async () => {
    const onFound = vi.fn();
    const found = await scanForHikvision({ subnets: ['172.21.0'], probeTimeoutMs: 50, onFound });
    expect(found).toEqual([
      { ip: '172.21.0.30', port: 8080, confirmed: true, activated: true },
      { ip: '172.21.0.31', port: 80, confirmed: false, activated: null },
    ]);
    expect(onFound.mock.calls.map(([device]) => device.ip)).toEqual(['172.21.0.30', '172.21.0.31']);
  });

  it('moves on past empty subnets', async () => {
    const found = await scanForHikvision({ subnets: ['192.168.9', '10.0.0'], probeTimeoutMs: 50 });
    expect(found).toEqual([{ ip: '10.0.0.20', port: 80, confirmed: false, activated: null }]);
    expect(stats.probes).toBe(2 * 2 * 254);
  });

  it('reports progress out of every address on every port', async () => {
    const progress = vi.fn();
    await scanForHikvision({ subnets: ['192.168.9'], probeTimeoutMs: 20, onProgress: progress });
    expect(progress).toHaveBeenCalledTimes(508);
    expect(progress).toHaveBeenLastCalledWith({ subnet: '192.168.9', probed: 508, total: 508 });
  });

  it('stops promptly when cancelled', async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 50);
    await scanForHikvision({ subnets: ['172.16.0', '172.16.1'], signal: abort.signal });
    expect(Date.now() - started).toBeLessThan(500);
  });

  // The cost of trying a second port: an address with nothing on it takes a whole
  // probe timeout per port, through the same pool of 48
  it.each([
    { ports: [80], rounds: 6 },
    { ports: [80, 8080], rounds: 11 },
  ])('takes $rounds probe timeouts for an empty subnet on ports $ports', async ({ ports, rounds }) => {
    vi.useFakeTimers();
    const started = Date.now();
    const scan = scanForHikvision({ subnets: ['192.168.9'], ports, probeTimeoutMs: 1200 });
    await vi.runAllTimersAsync();
    await scan;
    expect(Date.now() - started).toBe(rounds * 1200);
  });
});

describe('checkActivation', () => {
  it('asks without credentials and reads the answer', async () => {
    expect(await checkActivation({ host: '192.168.0.108', port: '80' }, { timeoutMs: 50 })).toEqual({ activated: true });
    expect(await checkActivation({ host: '192.168.0.64', port: 8080 }, { timeoutMs: 50 })).toEqual({ activated: false });
    expect(stats.requests.map(r => [r.url.href, r.credentials])).toEqual([
      ['http://192.168.0.108/SDK/activateStatus', 'omit'],
      ['http://192.168.0.64:8080/SDK/activateStatus', 'omit'],
    ]);
  });

  it('doesn’t know when the device doesn’t say, or doesn’t answer', async () => {
    expect(await checkActivation({ host: '192.168.0.70' }, { timeoutMs: 50 })).toBeNull();
    expect(await checkActivation({ host: '192.168.9.9' }, { timeoutMs: 50 })).toBeNull();
    expect(await checkActivation({ host: '172.20.0.5' }, { timeoutMs: 50 })).toBeNull();
  });

  it('sends nothing once cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await checkActivation({ host: '192.168.0.108' }, { timeoutMs: 5000, signal: abort.signal })).toBeNull();
    expect(stats.requests).toEqual([]);
  });
});

describe('parseActivateStatus', () => {
  it('reads the flag in any namespace or prefix', () => {
    expect(parseActivateStatus(activateStatus(true).body)).toEqual({ activated: true });
    expect(parseActivateStatus('<!-- x --><hik:ActivateStatus xmlns:hik="urn:x">\n<hik:Activated> FALSE </hik:Activated>' +
      '</hik:ActivateStatus>')).toEqual({ activated: false });
  });

  it('knows a Hikvision answer that doesn’t say', () => {
    expect(parseActivateStatus('<ActivateStatus/>')).toEqual({ activated: null });
    expect(parseActivateStatus('<ActivateStatus><Activated></Activated></ActivateStatus>')).toEqual({ activated: null });
  });

  it('takes nothing else for a Hikvision answer', () => {
    for (const body of ['', 'true', '<html><body>ActivateStatus</body></html>', '<ResponseStatus><Activated>true</Activated></ResponseStatus>',
      '<ActivateStatusList><Activated>true</Activated></ActivateStatusList>']) {
      expect(parseActivateStatus(body)).toBeNull();
    }
  });
});

describe('result texts', () => {
  it('labels confirmed and possible devices with their port, and says when one needs activating', () => {
    expect(describeFoundDevice({ ip: '192.168.0.108', port: 80, confirmed: true, activated: true }))
      .toEqual({ label: 'Hikvision NVR / Camera • Port 80', note: null });
    expect(describeFoundDevice({ ip: '192.168.0.70', port: 8080, confirmed: false, activated: null }))
      .toEqual({ label: 'Possible Hikvision device • Port 8080', note: null });
    expect(describeFoundDevice({ ip: '192.168.0.64', port: 80, confirmed: true, activated: false }))
      .toEqual({ label: 'Hikvision NVR / Camera • Port 80', note: NOT_ACTIVATED_HINT });
    expect(NOT_ACTIVATED_HINT).toBe('Not activated — activate it with Hikvision SADP or its web page first');
  });

  it('counts devices as Hikvision only when all of them confirmed it', () => {
    const confirmed = { ip: '192.168.0.108', port: 80, confirmed: true, activated: true };
    const possible = { ip: '192.168.0.70', port: 80, confirmed: false, activated: null };
    expect(describeScanResults([])).toBe('No Hikvision devices found on your local network. Try entering the IP address manually.');
    expect(describeScanResults([confirmed])).toBe('Found 1 Hikvision device. Click one to connect:');
    expect(describeScanResults([confirmed, confirmed])).toBe('Found 2 Hikvision devices. Click one to connect:');
    expect(describeScanResults([confirmed, possible])).toBe('Found 2 devices that may be Hikvision. Click one to connect:');
  });
});
