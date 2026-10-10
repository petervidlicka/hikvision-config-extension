/**
 * ISAPI client routing, fallbacks, write results and time limits, with fetch
 * replaced by a fake device.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../extension/lib/digest-auth.js';
import { IsapiError, NetworkError, NotAnImageError, TimeoutError, WriteRollbackError } from '../../extension/lib/errors.js';
import { applyStreamSizes, readMainStreamSizes } from '../../extension/lib/channels.js';
import { readPrivacyMask } from '../../extension/lib/config-xml.js';
import { Isapi, TIMEOUT_MS, defaultTimeoutMs } from '../../extension/lib/isapi.js';
import { jpegSize } from '../../extension/lib/picture-size.js';
import { RESOLVE_AGAIN_AFTER_FAILURES, isJpeg } from '../../extension/lib/snapshots.js';
import { childText, parseXml, serializeXml } from '../../extension/lib/xml.js';
import { NVR_HOST, STATUS, createMockNvr, responseStatusXml } from '../support/mock-nvr.js';
import { fixtures } from './fixtures.js';

/**
 * Replace fetch with a router keyed by path (without the query), or by
 * "METHOD path" for one method; unknown paths return 404. A route with
 * `hang` never answers until the request's signal aborts it, like a stalled
 * device; one with `unreachable` fails like a wrong IP address; one with
 * `challenge` answers only a request with credentials, and one without them
 * with a Digest challenge, as the NVR answers everything.
 * @returns {string[]} the requested paths with their queries, in order
 */
function mockDevice(routes) {
  const calls = [];
  vi.stubGlobal('fetch', async (url, opts = {}) => {
    const { pathname: path, search } = new URL(url);
    calls.push(path + search);
    const r = routes[`${opts.method ?? 'GET'} ${path}`] ?? routes[path];
    if (!r) return new Response('', { status: 404 });
    if (r.unreachable) throw new TypeError('Failed to fetch');
    if (r.challenge && !new Headers(opts.headers).has('Authorization')) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } });
    }
    if (r.hang) {
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(opts.signal.reason)));
    }
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  });
  return calls;
}

/** A route answering with a DS-7604NI-style ResponseStatus. */
const statusRoute = (status, statusCode, subStatusCode, statusString = 'Error') => ({
  status, body: responseStatusXml('/x', { statusCode, statusString, subStatusCode }),
});

/** A channel wired to the device, as getChannels lists it; snapshot URLs depend on the kind. */
const analog = (id) => ({ id, name: '', kind: 'analog' });
/** An IP camera behind an NVR. */
const digital = (id) => ({ id, name: '', kind: 'digital' });

let configSeq = 0;
/** Fresh credentials per test so the rejected-credentials guard doesn't leak between tests. */
const testConfig = () => ({ host: '10.9.9.9', port: 80, username: `user${++configSeq}`, password: 'pw' });

afterEach(() => {
  vi.unstubAllGlobals();
  Isapi.onAuthFailure = null;
  Isapi.clearDeviceCache();
});

describe('Isapi', () => {
  it('falls back to the trigger list and isolates one trigger', async () => {
    const ns = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"';
    mockDevice({
      '/ISAPI/Event/triggers': { body: `<EventTriggerList ${ns}>` +
        '<EventTrigger><id>VMD-1</id><eventType>VMD</eventType><videoInputChannelID>1</videoInputChannelID></EventTrigger>' +
        '<EventTrigger><id>VMD-2</id><eventType>VMD</eventType><videoInputChannelID>2</videoInputChannelID></EventTrigger>' +
        '</EventTriggerList>' },
    });
    const doc = await Isapi.getEventTrigger(testConfig(), '2');
    expect(doc.documentElement.localName).toBe('EventTrigger');
    expect(childText(doc.documentElement, 'id')).toBe('VMD-2');
    expect(serializeXml(doc)).toContain(`<EventTrigger ${ns}>`);
  });

  it('de-duplicates streaming channels', async () => {
    mockDevice({
      '/ISAPI/Streaming/channels': { body: '<StreamingChannelList>' +
        '<StreamingChannel><id>101</id><channelName>Front</channelName></StreamingChannel>' +
        '<StreamingChannel><id>102</id><channelName>Front</channelName></StreamingChannel>' +
        '<StreamingChannel><id>201</id></StreamingChannel></StreamingChannelList>' },
    });
    expect(await Isapi.getChannels(testConfig())).toEqual([
      { id: '1', name: 'Front', kind: 'analog' },
      { id: '2', name: '', kind: 'analog' },
    ]);
  });

  it('uses InputProxy URLs for IP cameras behind an NVR', async () => {
    expect(Isapi.motionDetectionPath({ id: '2', kind: 'digital' })).toBe('/ISAPI/ContentMgmt/InputProxy/channels/2/video/motionDetection');
    expect(Isapi.motionDetectionPath({ id: '2', kind: 'analog' })).toBe('/ISAPI/System/Video/inputs/channels/2/motionDetection');
    mockDevice({
      '/ISAPI/System/Video/inputs/channels': { status: 403 },
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: '<InputProxyChannelList><InputProxyChannel><id>1</id><name>Gate</name></InputProxyChannel></InputProxyChannelList>' },
      '/ISAPI/ContentMgmt/InputProxy/channels/1/video/privacyMask': { body: '<PrivacyMask><enabled>false</enabled></PrivacyMask>' },
    });
    const [channel] = await Isapi.getChannels(testConfig());
    expect(channel).toEqual({ id: '1', name: 'Gate', kind: 'digital' });
    expect((await Isapi.getPrivacyMask(testConfig(), channel)).path).toBe('/ISAPI/ContentMgmt/InputProxy/channels/1/video/privacyMask');
  });

  it('stops endpoint fallbacks on auth failure and fires the hook once', async () => {
    const challenge = { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } };
    const calls = mockDevice({
      '/ISAPI/System/Video/inputs/channels': challenge,
      '/ISAPI/ContentMgmt/InputProxy/channels': challenge,
    });
    const hook = vi.fn();
    Isapi.onAuthFailure = hook;
    await expect(Isapi.getChannels(testConfig())).rejects.toBeInstanceOf(AuthError);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/ISAPI/System/Video/inputs/channels', '/ISAPI/System/Video/inputs/channels']);
  });

  it('logs in with userCheck before reading the device info', async () => {
    const deviceInfo = { body: '<DeviceInfo><deviceName>NVR</deviceName><model>DS-7604NI-K1/4P</model></DeviceInfo>' };
    const calls = mockDevice({ '/ISAPI/Security/userCheck': { body: fixtures.userCheckNvr }, '/ISAPI/System/deviceInfo': deviceInfo });
    expect(await Isapi.getDeviceInfo(testConfig())).toMatchObject({ deviceName: 'NVR', model: 'DS-7604NI-K1/4P' });
    expect(calls).toEqual(['/ISAPI/Security/userCheck', '/ISAPI/System/deviceInfo']);

    // Firmware without userCheck: the device info request checks the login
    for (const missing of [{ status: 404 }, statusRoute(403, 4, 'notSupport')]) {
      mockDevice({ '/ISAPI/Security/userCheck': missing, '/ISAPI/System/deviceInfo': deviceInfo });
      expect((await Isapi.getDeviceInfo(testConfig())).deviceName).toBe('NVR');
    }
    mockDevice({ '/ISAPI/Security/userCheck': statusRoute(503, 2, 'serviceUnavailable'), '/ISAPI/System/deviceInfo': deviceInfo });
    await expect(Isapi.getDeviceInfo(testConfig())).rejects.toMatchObject({ httpStatus: 503 });
  });

  /** A userCheck answered HTTP 200 with a rejection, as older firmware answers a wrong password. */
  const REJECTED_IN_200 = '<userCheck><statusValue>401</statusValue><statusString>Unauthorized</statusString>' +
    '<lockStatus>unlock</lockStatus><retryLoginTime>2</retryLoginTime></userCheck>';

  it('takes a userCheck answered 200 with a rejection as a rejected login, when it carried the credentials', async () => {
    const calls = mockDevice({
      '/ISAPI/Security/userCheck': { challenge: true, body: REJECTED_IN_200 },
      '/ISAPI/System/deviceInfo': { challenge: true, body: '<DeviceInfo/>' },
    });
    const hook = vi.fn();
    Isapi.onAuthFailure = hook;
    const config = testConfig();
    const err = await Isapi.getDeviceInfo(config).catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ statusValue: 401, attemptsLeft: 2 });
    expect(hook).toHaveBeenCalledWith(err);
    // Nothing sends these credentials again until the next Connect
    await expect(Isapi.getChannels(config)).rejects.toMatchObject({ attemptsLeft: 2 });
    expect(calls).toEqual(['/ISAPI/Security/userCheck', '/ISAPI/Security/userCheck']);
  });

  it('leaves the login to the device info when userCheck answers without asking for the credentials', async () => {
    // Such firmware gives a request without credentials the same rejection: it judged nobody's password
    const calls = mockDevice({
      '/ISAPI/Security/userCheck': { body: REJECTED_IN_200 },
      '/ISAPI/System/deviceInfo': { challenge: true, body: '<DeviceInfo><deviceName>NVR</deviceName></DeviceInfo>' },
    });
    const hook = vi.fn();
    Isapi.onAuthFailure = hook;
    const config = testConfig();
    expect((await Isapi.getDeviceInfo(config)).deviceName).toBe('NVR');
    expect(hook).not.toHaveBeenCalled();
    expect(calls).toEqual(['/ISAPI/Security/userCheck', '/ISAPI/System/deviceInfo', '/ISAPI/System/deviceInfo']);
    // The credentials stay usable
    await expect(Isapi.getXml(config, '/ISAPI/System/deviceInfo')).resolves.toBeDefined();
  });

  it('falls back to the main stream when a camera has no sub-stream', async () => {
    const calls = mockDevice({ '/ISAPI/Streaming/channels/301/picture': { body: new Uint8Array([0xff, 0xd8]) } });
    const blob = await Isapi.getSnapshot(testConfig(), analog('3'), 'sub');
    expect(blob.size).toBe(2);
    expect(calls).toEqual(['/ISAPI/Streaming/channels/302/picture', '/ISAPI/Streaming/channels/301/picture']);
  });

  it('returns snapshots as JPEG blobs', async () => {
    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { body: new Uint8Array([0xff, 0xd8, 0xff]) } });
    const blob = await Isapi.getSnapshot(testConfig(), analog('1'));
    expect([blob.type, blob.size]).toEqual(['image/jpeg', 3]);
  });

  it('stops snapshot fallbacks when the camera isn’t available (503) or the device is slow', async () => {
    let calls = mockDevice({ '/ISAPI/Streaming/channels/501/picture': statusRoute(503, 2, 'serviceUnavailable', 'Device Busy') });
    await expect(Isapi.getSnapshot(testConfig(), analog('5'))).rejects.toMatchObject({ httpStatus: 503, subStatusCode: 'serviceUnavailable' });
    expect(calls).toEqual(['/ISAPI/Streaming/channels/501/picture']);

    calls = mockDevice({ '/ISAPI/Streaming/channels/102/picture': { hang: true } });
    await expect(Isapi.getSnapshot(testConfig(), analog('1'), 'sub', { timeoutMs: 50 })).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toEqual(['/ISAPI/Streaming/channels/102/picture']);
  });

  it('tries the bare channel ID after a "not here" answer, keeping the candidate order', async () => {
    const calls = mockDevice({
      '/ISAPI/Streaming/channels/101/picture': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/Streaming/channels/1/picture': { body: new Uint8Array([0xff, 0xd8]) },
    });
    expect((await Isapi.getSnapshot(testConfig(), analog('1'))).size).toBe(2);
    expect(calls).toEqual(['/ISAPI/Streaming/channels/101/picture', '/ISAPI/Streaming/channels/1/picture']);
  });

  it('explains a missing snapshot with the stream’s answer, not the bare channel ID’s', async () => {
    // The DS-7604NI answers the bare channel ID with 400 badXmlContent
    mockDevice({
      '/ISAPI/Streaming/channels/101/picture': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/Streaming/channels/1/picture': statusRoute(400, 6, 'badXmlContent'),
    });
    const err = await Isapi.getSnapshot(testConfig(), analog('1')).catch(e => e);
    expect(err).toMatchObject({ path: '/ISAPI/Streaming/channels/101/picture', subStatusCode: 'notSupport' });
    expect(err.message).toMatch(/doesn’t support this/);
  });

  it('aborts a snapshot when the caller’s signal fires', async () => {
    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { hang: true } });
    const controller = new AbortController();
    const pending = Isapi.getSnapshot(testConfig(), analog('1'), 'main', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('counts the mock NVR’s snapshots in flight only until each one ends', async () => {
    const device = createMockNvr({ snapshotDelayMs: 20 });
    vi.stubGlobal('fetch', device.fetch);
    const config = { host: NVR_HOST, port: 80, username: `user${++configSeq}`, password: 'pw' };

    // A signal that fires after its frame arrived (the feed stopping later) changes nothing
    const finished = new AbortController();
    await Isapi.getSnapshot(config, analog('1'), 'sub', { signal: finished.signal });
    finished.abort();
    expect(device.inFlightSnapshots).toBe(0);

    const stopped = new AbortController();
    const pending = Isapi.getSnapshot(config, analog('1'), 'sub', { signal: stopped.signal });
    await vi.waitFor(() => expect(device.inFlightSnapshots).toBe(1));
    stopped.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect([device.inFlightSnapshots, device.maxInFlightSnapshots]).toEqual([0, 1]);
  });

  it('tries StreamingProxy for an IP camera before the bare channel ID', async () => {
    const calls = mockDevice({
      '/ISAPI/ContentMgmt/StreamingProxy/channels/302/picture': { body: new Uint8Array([0xff, 0xd8]) },
    });
    expect((await Isapi.getSnapshot(testConfig(), digital('3'), 'sub')).size).toBe(2);
    expect(calls).toEqual([
      '/ISAPI/Streaming/channels/302/picture',
      '/ISAPI/Streaming/channels/301/picture',
      '/ISAPI/ContentMgmt/StreamingProxy/channels/302/picture',
    ]);
  });

  it('finds the snapshot URL once, then asks only that one', async () => {
    const calls = mockDevice({
      '/ISAPI/Streaming/channels/302/picture': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/Streaming/channels/301/picture': { body: new Uint8Array([0xff, 0xd8]) },
    });
    const source = Isapi.snapshotSource(testConfig(), analog('3'), 'sub');
    for (let i = 0; i < 3; i++) await source.next();
    expect(calls).toEqual([
      '/ISAPI/Streaming/channels/302/picture',
      '/ISAPI/Streaming/channels/301/picture',
      '/ISAPI/Streaming/channels/301/picture',
      '/ISAPI/Streaming/channels/301/picture',
    ]);
  });

  it('takes an answer that isn’t a JPEG as no picture, and tries the next URL', async () => {
    // A page instead of an image, and a refusal sent with HTTP 200
    const calls = mockDevice({
      '/ISAPI/Streaming/channels/101/picture': { body: '<html>Login</html>', headers: { 'Content-Type': 'text/html' } },
      '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture': { body: responseStatusXml('/x', STATUS.notSupport) },
      '/ISAPI/Streaming/channels/1/picture': { body: new Uint8Array([0xff, 0xd8]) },
    });
    expect((await Isapi.getSnapshot(testConfig(), digital('1'))).type).toBe('image/jpeg');
    expect(calls).toHaveLength(3);

    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { body: new Uint8Array([0x3c, 0x68]) } });
    const err = await Isapi.fetchSnapshot(testConfig(), '/ISAPI/Streaming/channels/101/picture').catch(e => e);
    expect(err).toBeInstanceOf(NotAnImageError);
    expect(err.message).toMatch(/didn’t send an image/);
    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { body: responseStatusXml('/x', STATUS.notSupport) } });
    await expect(Isapi.fetchSnapshot(testConfig(), '/ISAPI/Streaming/channels/101/picture'))
      .rejects.toMatchObject({ name: 'IsapiError', httpStatus: 200, subStatusCode: 'notSupport' });
  });

  it('asks a camera that doesn’t answer once per request, ever less often, until it is back', async () => {
    const device = createMockNvr({ snapshotDelayMs: 5 });
    vi.stubGlobal('fetch', device.fetch);
    const config = { host: NVR_HOST, port: 80, username: `user${++configSeq}`, password: 'pw' };
    device.offlineChannels = ['4']; // its snapshots answer 503, like an empty channel

    const source = Isapi.snapshotSource(config, digital('4'), 'sub');
    const delays = [];
    for (let i = 0; i < 3; i++) {
      await expect(source.next()).rejects.toMatchObject({ httpStatus: 503, subStatusCode: 'serviceUnavailable' });
      delays.push(source.retryDelayMs);
    }
    expect(device.requests.filter(r => r.endsWith('/picture'))).toEqual(Array(3).fill('GET /ISAPI/Streaming/channels/402/picture'));
    expect(delays).toEqual([500, 1000, 2000]);
    expect(source.noSignal).toBe(true);

    device.offlineChannels = [];
    expect(isJpeg(await source.next())).toBe(true);
    expect([source.failures, source.retryDelayMs, source.noSignal]).toEqual([0, 0, false]);
  });

  it('finds the URL again after several failures in a row', async () => {
    const device = createMockNvr({ snapshotDelayMs: 5 });
    vi.stubGlobal('fetch', device.fetch);
    const config = { host: NVR_HOST, port: 80, username: `user${++configSeq}`, password: 'pw' };
    const source = Isapi.snapshotSource(config, analog('2'), 'sub');
    await source.next();
    expect(source.path).toBe('/ISAPI/Streaming/channels/202/picture');

    // The camera on channel 2 is replaced by one without a sub-stream
    device.failures['GET /ISAPI/Streaming/channels/202/picture'] = { httpStatus: 403, ...STATUS.notSupport };
    for (let i = 0; i < RESOLVE_AGAIN_AFTER_FAILURES; i++) await expect(source.next()).rejects.toBeInstanceOf(IsapiError);
    const before = device.requests.length;
    await source.next();
    expect(device.requests.slice(before)).toEqual([
      'GET /ISAPI/Streaming/channels/202/picture', 'GET /ISAPI/Streaming/channels/201/picture',
    ]);
    expect(source.path).toBe('/ISAPI/Streaming/channels/201/picture');
  });

  it('starts a camera the NVR lists offline with no signal and slow retries, but still asks', async () => {
    const calls = mockDevice({ '/ISAPI/Streaming/channels/402/picture': statusRoute(503, 2, 'serviceUnavailable') });
    const source = Isapi.snapshotSource(testConfig(), { ...digital('4'), online: false }, 'sub');
    expect(source.noSignal).toBe(true);
    await expect(source.next()).rejects.toMatchObject({ httpStatus: 503 });
    expect(calls).toEqual(['/ISAPI/Streaming/channels/402/picture']);
    expect(source.retryDelayMs).toBeGreaterThanOrEqual(8000);
  });

  it('loads /privacyMask/regions only when the device has no /privacyMask', async () => {
    const channel = { id: '1', kind: 'digital' };
    const base = '/ISAPI/ContentMgmt/InputProxy/channels/1/video/privacyMask';
    const regions = { body: '<PrivacyMaskRegionList/>' };

    let calls = mockDevice({ [base]: statusRoute(403, 4, 'notSupport'), [`${base}/regions`]: regions });
    expect((await Isapi.getPrivacyMask(testConfig(), channel)).path).toBe(`${base}/regions`);
    expect(calls).toEqual([base, `${base}/regions`]);

    for (const [status, code, sub] of [[503, 2, 'deviceBusy'], [403, 4, 'lowPrivilege']]) {
      calls = mockDevice({ [base]: statusRoute(status, code, sub), [`${base}/regions`]: regions });
      await expect(Isapi.getPrivacyMask(testConfig(), channel)).rejects.toMatchObject({ subStatusCode: sub });
      expect(calls).toEqual([base]);
    }
  });

  it('applies the policy to channel lists and event triggers', async () => {
    // A refused list doesn't fall back to probing: its reason is what the user needs
    let calls = mockDevice({ '/ISAPI/System/Video/inputs/channels': statusRoute(403, 4, 'lowPrivilege') });
    await expect(Isapi.getChannels(testConfig())).rejects.toMatchObject({ subStatusCode: 'lowPrivilege' });
    expect(calls).toEqual(['/ISAPI/System/Video/inputs/channels', '/ISAPI/ContentMgmt/InputProxy/channels']);

    calls = mockDevice({ '/ISAPI/Event/triggers/VMD-1': statusRoute(503, 2, 'deviceBusy') });
    await expect(Isapi.getEventTrigger(testConfig(), '1')).rejects.toMatchObject({ httpStatus: 503 });
    expect(calls).toEqual(['/ISAPI/Event/triggers/VMD-1']);
  });

  it('opens motion with default limits when the capabilities can’t be read, unless nothing answers', async () => {
    const channel = { id: '1', kind: 'digital' };
    const caps = '/ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection/capabilities';
    // The DS-7604NI answers 503 serviceUnavailable, every time, for capabilities it doesn't serve
    const answers = [
      statusRoute(403, 4, 'notSupport'), statusRoute(503, 2, 'serviceUnavailable', 'Device Busy'),
      statusRoute(500, 3, 'deviceError'), { body: '<MotionDetection' },
    ];
    for (const route of answers) {
      mockDevice({ [caps]: route });
      expect(await Isapi.getMotionCapabilities(testConfig(), channel)).toBeNull();
    }
    mockDevice({ [caps]: { body: fixtures.motionCapabilitiesNvr } });
    expect((await Isapi.getMotionCapabilities(testConfig(), channel))?.documentElement.localName).toBe('MotionDetection');

    mockDevice({ [caps]: { unreachable: true } });
    await expect(Isapi.getMotionCapabilities(testConfig(), channel)).rejects.toBeInstanceOf(NetworkError);
    mockDevice({ [caps]: { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } } });
    await expect(Isapi.getMotionCapabilities(testConfig(), channel)).rejects.toBeInstanceOf(AuthError);
    const request = vi.spyOn(Isapi, 'request')
      .mockRejectedValueOnce(new TimeoutError({ method: 'GET', path: caps, address: '10.9.9.9:80', timeoutMs: TIMEOUT_MS.read }));
    try {
      await expect(Isapi.getMotionCapabilities(testConfig(), channel)).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      request.mockRestore();
    }
  });

  it('treats any error answer as "no recorded frame", but not a missing answer', async () => {
    const time = new Date(Date.UTC(2024, 0, 1, 12));
    mockDevice({}); // 404 everywhere
    expect(await Isapi.getRecordedFrame(testConfig(), '1', time)).toBeNull();

    mockDevice({ '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture': statusRoute(503, 2, 'serviceUnavailable') });
    expect(await Isapi.getRecordedFrame(testConfig(), '1', time)).toBeNull();

    mockDevice({ '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture': { unreachable: true } });
    await expect(Isapi.getRecordedFrame(testConfig(), '1', time)).rejects.toBeInstanceOf(NetworkError);
  });

  it('asks for recorded frames at the device’s wall-clock time, whatever the browser’s zone', async () => {
    // 02:30 on the day clocks spring forward: no such time in Central Europe, but the device's clock shows it
    let calls = mockDevice({});
    await Isapi.getRecordedFrame(testConfig(), '1', new Date(Date.UTC(2027, 2, 28, 2, 30)));
    expect(calls[0]).toBe('/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture?starttime=2027-03-28T02%3A30%3A00Z');
    // The probe for firmware that ignores the time asks for midnight at the start of 2000
    calls = mockDevice({});
    expect(await Isapi.ignoresRecordedFrameTime(testConfig(), '1')).toBe(false);
    expect(calls[0]).toMatch(/\?starttime=2000-01-01T00%3A00%3A00Z$/);
  });

  it('reads the device’s wall-clock time and ignores the offset it gives', async () => {
    // Captured at 13:03 CEST: the wall-clock part is right, "+01:00" leaves out daylight saving
    mockDevice({ '/ISAPI/System/time': { body: fixtures.systemTimeNvr } });
    expect(await Isapi.getDeviceTime(testConfig())).toEqual(new Date(Date.UTC(2026, 9, 10, 13, 3, 16)));

    // A device that doesn't tell its time leaves "today" to the browser's clock
    for (const route of [
      statusRoute(403, 4, 'notSupport'), statusRoute(403, 4, 'lowPrivilege'), { status: 404 },
      { body: '<html><body>Not XML</body></html>' }, { body: '<Time><timeMode>NTP</timeMode></Time>' },
      { body: '<Time><localTime>2026-02-30T10:00:00+01:00</localTime></Time>' },
    ]) {
      mockDevice({ '/ISAPI/System/time': route });
      expect(await Isapi.getDeviceTime(testConfig())).toBeNull();
    }
    // No answer isn't an answer
    mockDevice({ '/ISAPI/System/time': { unreachable: true } });
    await expect(Isapi.getDeviceTime(testConfig())).rejects.toBeInstanceOf(NetworkError);
  });

  it('doesn’t take a slow answer for a moment before any recording as the live image', async () => {
    const details = { method: 'GET', path: '/x', address: '10.9.9.9:80' };
    const frame = vi.spyOn(Isapi, 'getRecordedFrame');
    try {
      frame.mockRejectedValueOnce(new TimeoutError({ ...details, timeoutMs: 5000 }));
      expect(await Isapi.ignoresRecordedFrameTime(testConfig(), '1')).toBe(false);
      frame.mockRejectedValueOnce(new NetworkError(details));
      await expect(Isapi.ignoresRecordedFrameTime(testConfig(), '1')).rejects.toBeInstanceOf(NetworkError);
    } finally {
      frame.mockRestore();
    }
  });
});

describe('Isapi writes', () => {
  const path = '/ISAPI/Event/triggers/VMD-1';
  const doc = () => parseXml('<EventTrigger><id>VMD-1</id></EventTrigger>');

  it('reports OK and reboot-required results', async () => {
    mockDevice({ [`PUT ${path}`]: { body: responseStatusXml(path, STATUS.ok) } });
    expect(await Isapi.putXml(testConfig(), path, doc())).toEqual({ rebootRequired: false });

    mockDevice({ [`PUT ${path}`]: statusRoute(200, 7, 'rebootRequired', 'Reboot Required') });
    expect(await Isapi.putXml(testConfig(), path, doc())).toEqual({ rebootRequired: true });

    mockDevice({ [`PUT ${path}`]: { body: '' } }); // firmware that sends no body
    expect(await Isapi.putXml(testConfig(), path, doc())).toEqual({ rebootRequired: false });
  });

  it('fails a write whose ResponseStatus reports a failure, even with HTTP 200', async () => {
    mockDevice({ [`PUT ${path}`]: statusRoute(200, 4, 'invalidOperation', 'Invalid Operation') });
    const err = await Isapi.putXml(testConfig(), path, doc()).catch(e => e);
    expect(err).toBeInstanceOf(IsapiError);
    expect(err).toMatchObject({ method: 'PUT', path, httpStatus: 200, statusCode: 4, subStatusCode: 'invalidOperation' });
    expect(err.message).toMatch(/refused this operation/);
  });

  it('explains a refused write with the device’s reason', async () => {
    mockDevice({ [`PUT ${path}`]: statusRoute(403, 4, 'lowPrivilege', 'Invalid Operation') });
    await expect(Isapi.putXml(testConfig(), path, doc())).rejects.toThrow(/doesn’t have permission/);
  });

  it('deletes a resource with the same result handling', async () => {
    const regions = '/ISAPI/ContentMgmt/InputProxy/channels/3/video/privacyMask/regions';
    mockDevice({ [`DELETE ${regions}`]: { body: responseStatusXml(regions, STATUS.ok) } });
    expect(await Isapi.deleteResource(testConfig(), regions)).toEqual({ rebootRequired: false });

    mockDevice({ [`DELETE ${regions}`]: statusRoute(403, 4, 'methodNotAllowed') });
    await expect(Isapi.deleteResource(testConfig(), regions)).rejects.toMatchObject({ method: 'DELETE', subStatusCode: 'methodNotAllowed' });
  });
});

describe('picture sizes', () => {
  const mainStream = { width: 2688, height: 1520 };
  /** The mock NVR, answering at once, and a login of its own. */
  const nvr = () => {
    const device = createMockNvr({ snapshotDelayMs: 5 });
    vi.stubGlobal('fetch', device.fetch);
    return { device, config: { host: NVR_HOST, port: 80, username: `user${++configSeq}`, password: 'pw' } };
  };
  /** The snapshot URLs asked for since `since`, with their queries. */
  const pictures = (device, since) => device.urls.slice(since).filter(u => u.includes('/picture'));
  const plain = (ch) => `GET /ISAPI/Streaming/channels/${ch}01/picture`;
  const sized = (ch) => `${plain(ch)}?videoResolutionWidth=2688&videoResolutionHeight=1520`;

  it('reads each camera’s main stream size from the NVR’s stream list', () => {
    const sizes = readMainStreamSizes(parseXml(fixtures.streamingChannelsNvr).documentElement);
    expect([...sizes]).toEqual(['1', '2', '3', '4'].map(id => [id, mainStream]));
    const list = '<StreamingChannelList><StreamingChannel><id>1201</id><Video><videoResolutionWidth>1280</videoResolutionWidth>' +
      '<videoResolutionHeight>720</videoResolutionHeight></Video></StreamingChannel>' +
      '<StreamingChannel><id>1202</id><Video><videoResolutionWidth>640</videoResolutionWidth>' +
      '<videoResolutionHeight>480</videoResolutionHeight></Video></StreamingChannel>' +
      '<StreamingChannel><id>301</id><Video><videoResolutionWidth>auto</videoResolutionWidth></Video></StreamingChannel>' +
      '</StreamingChannelList>';
    expect([...readMainStreamSizes(parseXml(list).documentElement)]).toEqual([['12', { width: 1280, height: 720 }]]);
    expect(applyStreamSizes([digital('12'), digital('3')], new Map([['12', mainStream]])))
      .toEqual([{ ...digital('12'), mainStreamSize: mainStream }, digital('3')]);
  });

  it('reads the stream list once per device, until the cache is cleared', async () => {
    const calls = mockDevice({ '/ISAPI/Streaming/channels': { body: fixtures.streamingChannelsNvr } });
    const config = testConfig();
    expect((await Isapi.getStreamSizes(config)).get('2')).toEqual(mainStream);
    await Isapi.getStreamSizes(config);
    expect(calls).toEqual(['/ISAPI/Streaming/channels']);
    Isapi.clearDeviceCache();
    await Isapi.getStreamSizes(config);
    expect(calls).toHaveLength(2);
  });

  it('leaves the sizes unknown when the list can’t be read, asking again next time, unless the login is rejected', async () => {
    const config = testConfig();
    let calls = mockDevice({ '/ISAPI/Streaming/channels': statusRoute(403, 4, 'lowPrivilege') });
    expect((await Isapi.getStreamSizes(config)).size).toBe(0);
    expect(calls).toHaveLength(1);
    // Asked again each time, each answer only as good as the last
    calls = mockDevice({ '/ISAPI/Streaming/channels': { body: '<!DOCTYPE html><html><head><meta charset="utf-8"></head></html>' } });
    expect((await Isapi.getStreamSizes(config)).size).toBe(0);
    expect(calls).toHaveLength(1);
    calls = mockDevice({ '/ISAPI/Streaming/channels': { body: '<StreamingChannelList/>' } });
    expect((await Isapi.getStreamSizes(config)).size).toBe(0);
    expect(calls).toHaveLength(1);
    // Nothing answering, or not in time (a long list), leaves them unknown too
    calls = mockDevice({ '/ISAPI/Streaming/channels': { unreachable: true } });
    expect((await Isapi.getStreamSizes(config)).size).toBe(0);
    expect(calls).toHaveLength(1);
    const request = vi.spyOn(Isapi, 'request').mockRejectedValueOnce(
      new TimeoutError({ method: 'GET', path: '/ISAPI/Streaming/channels', address: '10.9.9.9:80', timeoutMs: TIMEOUT_MS.read }));
    try {
      expect((await Isapi.getStreamSizes(config)).size).toBe(0);
    } finally {
      request.mockRestore();
    }
    calls = mockDevice({ '/ISAPI/Streaming/channels': { body: fixtures.streamingChannelsNvr } });
    expect((await Isapi.getStreamSizes(config)).get('1')).toEqual(mainStream);
    expect(calls).toHaveLength(1);

    mockDevice({ '/ISAPI/Streaming/channels': { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } } });
    await expect(Isapi.getStreamSizes(testConfig())).rejects.toBeInstanceOf(AuthError);
  });

  it('switches an NVR camera’s HD feed to the full-size still once, then asks for it straight away', async () => {
    const { device, config } = nvr();
    const camera = { ...digital('1'), mainStreamSize: mainStream };
    expect(jpegSize(await Isapi.snapshotSource(config, camera, 'main').next())).toEqual({ width: 1920, height: 1088 });
    expect(pictures(device, 0)).toEqual([plain(1), sized(1)]);

    // A later feed of the same channel, e.g. after switching channels and back
    let since = device.urls.length;
    expect(jpegSize(await Isapi.snapshotSource(config, camera, 'main').next())).toEqual({ width: 1920, height: 1088 });
    expect(pictures(device, since)).toEqual([sized(1)]);

    // The grid's sub stream is never asked for a size
    since = device.urls.length;
    expect(jpegSize(await Isapi.snapshotSource(config, digital('3'), 'sub').next())).toEqual({ width: 704, height: 576 });
    expect(pictures(device, since)).toEqual(['GET /ISAPI/Streaming/channels/302/picture']);

    // Reconnecting finds out again
    Isapi.clearDeviceCache();
    since = device.urls.length;
    await Isapi.snapshotSource(config, camera, 'main').next();
    expect(pictures(device, since)).toEqual([plain(1), sized(1)]);
  });

  it('keeps the plain URL, and remembers to, on firmware that ignores the size', async () => {
    const { device, config } = nvr();
    device.fullSizeStill = null;
    const camera = { ...digital('2'), mainStreamSize: mainStream };
    expect(jpegSize(await Isapi.snapshotSource(config, camera, 'main').next())).toEqual({ width: 704, height: 576 });
    const since = device.urls.length;
    await Isapi.snapshotSource(config, camera, 'main').next();
    expect(pictures(device, 0)).toEqual([plain(2), sized(2), plain(2)]);
    expect(pictures(device, since)).toEqual([plain(2)]);
  });

  it('asks for 1920×1080 when the stream list didn’t say', async () => {
    const { device, config } = nvr();
    await Isapi.snapshotSource(config, digital('4'), 'main').next();
    expect(pictures(device, 0)).toEqual([plain(4), `${plain(4)}?videoResolutionWidth=1920&videoResolutionHeight=1080`]);
  });
});

describe('request time limits', () => {
  it('gives each kind of request its own budget', () => {
    expect(defaultTimeoutMs('GET', '/ISAPI/Streaming/channels/102/picture')).toBe(TIMEOUT_MS.picture);
    expect(defaultTimeoutMs('GET', '/ISAPI/Streaming/channels/1202/picture')).toBe(TIMEOUT_MS.picture);
    expect(defaultTimeoutMs('GET', '/ISAPI/ContentMgmt/StreamingProxy/channels/102/picture')).toBe(TIMEOUT_MS.picture);
    expect(defaultTimeoutMs('GET', '/ISAPI/ContentMgmt/StreamingProxy/channel/102/Picture?snapShotImageType=JPEG'))
      .toBe(TIMEOUT_MS.fullPicture);
    // Full-size JPEGs may take seconds to download over a slow link
    expect(defaultTimeoutMs('GET', '/ISAPI/Streaming/channels/101/picture')).toBe(TIMEOUT_MS.fullPicture);
    expect(defaultTimeoutMs('GET', '/ISAPI/Streaming/channels/101/picture?videoResolutionWidth=2688&videoResolutionHeight=1520'))
      .toBe(TIMEOUT_MS.fullPicture);
    expect(defaultTimeoutMs('GET', '/ISAPI/Streaming/channels/1/picture')).toBe(TIMEOUT_MS.fullPicture);
    expect(defaultTimeoutMs('GET', '/picture/Streaming/tracks/103/?name=x')).toBe(TIMEOUT_MS.fullPicture);
    expect(defaultTimeoutMs('GET', '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture?starttime=x')).toBe(TIMEOUT_MS.fullPicture);
    expect(TIMEOUT_MS.fullPicture).toBeGreaterThan(TIMEOUT_MS.picture);
    expect(defaultTimeoutMs('GET', '/ISAPI/Event/triggers/VMD-1')).toBe(TIMEOUT_MS.read);
    expect(defaultTimeoutMs('POST', '/ISAPI/ContentMgmt/search')).toBe(TIMEOUT_MS.search);
    expect(defaultTimeoutMs('PUT', '/ISAPI/Event/triggers/VMD-1')).toBe(TIMEOUT_MS.write);
    expect(defaultTimeoutMs('DELETE', '/x')).toBe(TIMEOUT_MS.write);
  });

  it('times out instead of hanging, without counting it as a failed login', async () => {
    mockDevice({ '/ISAPI/Event/triggers/VMD-1': { hang: true } });
    const hook = vi.fn();
    Isapi.onAuthFailure = hook;
    const err = await Isapi.request(testConfig(), 'GET', '/ISAPI/Event/triggers/VMD-1', null, { timeoutMs: 30 }).catch(e => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ method: 'GET', path: '/ISAPI/Event/triggers/VMD-1', address: '10.9.9.9:80', timeoutMs: 30 });
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('saving privacy masks', () => {
  const channel = { id: '3', kind: 'digital' };
  const path = '/ISAPI/ContentMgmt/InputProxy/channels/3/video/privacyMask';
  const top = { x1: 0, y1: 576, x2: 704, y2: 432 };
  const notSupport = { httpStatus: 403, ...STATUS.notSupport };
  const badContent = { httpStatus: 400, statusCode: 6, statusString: 'Invalid XML Content', subStatusCode: 'badXmlContent' };

  /** The mock NVR (privacy masks merge by id, as on the real one), loaded with its two stored masks. */
  async function loadNvr() {
    const device = createMockNvr();
    vi.stubGlobal('fetch', device.fetch);
    const config = { host: NVR_HOST, port: 80, username: `user${++configSeq}`, password: 'pw' };
    const loaded = await Isapi.getPrivacyMask(config, channel);
    expect(readPrivacyMask(loaded.doc).regions).toHaveLength(2);
    device.requests.length = 0;
    const stored = () => readPrivacyMask(parseXml(device.privacy.read(path)));
    return { device, config, original: loaded.doc, stored };
  }

  it('deletes the stored regions, then PUTs exactly the new list', async () => {
    const { device, config, original, stored } = await loadNvr();
    const { doc, result } = await Isapi.savePrivacyMask(config, path, original, { enabled: true, rects: [top] });

    expect(device.requests).toEqual([`DELETE ${path}/regions`, `PUT ${path}`]);
    expect(device.puts[0].body).toMatch(/<PrivacyMaskRegion><id>1<\/id><enabled>true<\/enabled><RegionCoordinatesList>/);
    expect(stored().regions).toEqual([[{ x: 0, y: 576 }, { x: 704, y: 576 }, { x: 704, y: 432 }, { x: 0, y: 432 }]]);
    expect(readPrivacyMask(doc).regions).toEqual(stored().regions);
    expect(result).toEqual({ rebootRequired: false });
    expect(readPrivacyMask(original).regions).toHaveLength(2); // the loaded document is left alone

    // Removing every mask leaves none stored
    await Isapi.savePrivacyMask(config, path, doc, { enabled: false, rects: [] });
    expect([stored().enabled, stored().regions]).toEqual([false, []]);
  });

  it('puts the loaded masks back when the new list is refused after the delete', async () => {
    const { device, config, original, stored } = await loadNvr();
    device.failures[`PUT ${path}`] = { ...badContent, times: 1 };
    const err = await Isapi.savePrivacyMask(config, path, original, { enabled: true, rects: [top] }).catch(e => e);

    expect(err).toBeInstanceOf(IsapiError);
    expect(err).toMatchObject({ method: 'PUT', subStatusCode: 'badXmlContent' });
    expect(device.requests).toEqual([`DELETE ${path}/regions`, `PUT ${path}`, `PUT ${path}`]);
    expect(device.puts.at(-1).body).toBe(serializeXml(original));
    expect(stored().regions).toEqual(readPrivacyMask(original).regions);
  });

  it('says the masks may be gone when putting them back fails too', async () => {
    const { device, config, original, stored } = await loadNvr();
    device.failures[`PUT ${path}`] = { ...badContent, times: 2 };
    const err = await Isapi.savePrivacyMask(config, path, original, { enabled: true, rects: [top] }).catch(e => e);

    expect(err).toBeInstanceOf(WriteRollbackError);
    expect(err.cause).toBeInstanceOf(IsapiError);
    expect(err.rollbackError).toBeInstanceOf(IsapiError);
    expect(err.message).toMatch(/^The device rejected the settings that were sent as invalid\..*Putting the previous privacy masks back failed too \(.*\), so the camera may have no privacy masks now\. Save them again\.$/);
    expect(stored().regions).toEqual([]);
  });

  it('falls back to one PUT that disables unused slots when the regions can’t be deleted', async () => {
    const methodNotAllowed = { httpStatus: 405, statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'methodNotAllowed' };
    // Also when the device reports notSupport inside an HTTP 200
    for (const failure of [notSupport, methodNotAllowed, { ...notSupport, httpStatus: 200 }]) {
      const { device, config, original, stored } = await loadNvr();
      device.failures[`DELETE ${path}/regions`] = failure;
      await Isapi.savePrivacyMask(config, path, original, { enabled: true, rects: [top] });

      expect(device.requests).toEqual([`DELETE ${path}/regions`, `PUT ${path}`]);
      const body = device.puts[0].body;
      expect(body.match(/<PrivacyMaskRegion\b/g)).toHaveLength(2);
      expect(body).toMatch(/<id>2<\/id>\s*<enabled>false<\/enabled>\s*<RegionCoordinatesList><\/RegionCoordinatesList>/);
      // Slot 2 was overwritten by id, so only the new mask has an area
      expect(stored().regions).toHaveLength(1);
    }
  });

  it('leaves the masks alone when the delete fails for another reason', async () => {
    const { device, config, original, stored } = await loadNvr();
    device.failures[`DELETE ${path}/regions`] = { httpStatus: 503, statusCode: 2, statusString: 'Device Busy', subStatusCode: 'deviceBusy' };
    await expect(Isapi.savePrivacyMask(config, path, original, { enabled: true, rects: [top] }))
      .rejects.toMatchObject({ method: 'DELETE', subStatusCode: 'deviceBusy' });
    expect(device.requests).toEqual([`DELETE ${path}/regions`]);
    expect(stored().regions).toHaveLength(2);
  });

  it('reports a reboot the delete or the PUT asks for', async () => {
    const { device, config, original } = await loadNvr();
    device.writeStatus = { statusCode: 7, statusString: 'Reboot Required', subStatusCode: 'rebootRequired' };
    const { result } = await Isapi.savePrivacyMask(config, path, original, { enabled: true, rects: [top] });
    expect(result).toEqual({ rebootRequired: true });
  });

  it('PUTs a bare region list back to /regions without deleting', async () => {
    const regionsPath = `${path}/regions`;
    const calls = mockDevice({ [`PUT ${regionsPath}`]: { body: responseStatusXml(regionsPath, STATUS.ok) } });
    const original = parseXml('<PrivacyMaskRegionList xmlns="http://www.isapi.org/ver20/XMLSchema"><PrivacyMaskRegion><id>1</id><enabled>true</enabled>' +
      '<RegionCoordinatesList><RegionCoordinates><positionX>0</positionX><positionY>0</positionY></RegionCoordinates>' +
      '<RegionCoordinates><positionX>100</positionX><positionY>100</positionY></RegionCoordinates></RegionCoordinatesList></PrivacyMaskRegion></PrivacyMaskRegionList>');
    const { doc } = await Isapi.savePrivacyMask(testConfig(), regionsPath, original, { enabled: true, rects: [top, top] });
    expect(calls).toEqual([regionsPath]);
    expect(readPrivacyMask(doc)).toMatchObject({ enabled: true, regions: [expect.any(Array), expect.any(Array)] });
  });
});

describe('event actions', () => {
  /** The DS-7604NI's answers about its motion actions, outputs, lights and speakers. */
  const nvrRoutes = () => ({
    '/ISAPI/Event/triggersCap': { body: fixtures.triggersCapNvr },
    '/ISAPI/System/IO/outputs/capabilities': { body: fixtures.ioOutputsCapabilitiesNvr },
    '/ISAPI/System/IO/outputs': { body: fixtures.ioOutputsNvr },
    '/ISAPI/Event/triggers/notifications/channels/whiteLightAlarm': { body: fixtures.whiteLightAlarmChannelsNvr },
    '/ISAPI/Event/triggers/notifications/channels/AudioAlarm': { body: fixtures.audioAlarmChannelsNvr },
  });
  const nvrRequests = new Set([
    '/ISAPI/Event/triggersCap',
    '/ISAPI/System/IO/outputs/capabilities',
    '/ISAPI/System/IO/outputs',
    '/ISAPI/Event/triggers/notifications/channels/whiteLightAlarm?format=json',
    '/ISAPI/Event/triggers/notifications/channels/AudioAlarm?format=json',
  ]);

  it('reads what the NVR offers once per device, until the cache is cleared', async () => {
    const calls = mockDevice(nvrRoutes());
    const config = testConfig();
    const support = await Isapi.getEventActionSupport(config);
    expect(support.triggerCap).toMatchObject({ isSupportIO: true, isSupportWhiteLightOut: true, isSupportAudioOut: true });
    expect(support.alarmOutputs.map(o => o.id)).toEqual(['301', '401']);
    expect([[...support.whiteLightChannels], [...support.audioChannels]]).toEqual([['3', '4'], ['3', '4']]);
    // outputs/capabilities mentions IOType, so the merged list is all it reads (no IOProxy)
    expect(calls[0]).toBe('/ISAPI/Event/triggersCap');
    expect(new Set(calls)).toEqual(nvrRequests);
    expect(calls).toHaveLength(nvrRequests.size);

    calls.length = 0;
    expect(await Isapi.getEventActionSupport(config)).toBe(support);
    expect(calls).toEqual([]);

    Isapi.clearDeviceCache();
    await Isapi.getEventActionSupport(config);
    expect(new Set(calls)).toEqual(nvrRequests);
  });

  it('reads own and IP cameras’ outputs separately when they carry no IOType', async () => {
    const calls = mockDevice({
      '/ISAPI/System/IO/outputs': { body: '<IOOutputPortList><IOOutputPort><id>1</id></IOOutputPort></IOOutputPortList>' },
      '/ISAPI/ContentMgmt/IOProxy/outputs': { body: fixtures.ioProxyOutputsNvr },
    });
    const support = await Isapi.getEventActionSupport(testConfig());
    expect(support.triggerCap).toBeNull(); // no triggersCap: every action offered, as before
    expect(support.alarmOutputs).toEqual([
      { id: '1', type: 'local', ipAddress: null },
      { id: '301', type: 'digital', ipAddress: '192.168.254.4' },
      { id: '401', type: 'digital', ipAddress: '192.168.254.3' },
    ]);
    // Without the *Out flags there are no NVR light or speaker lists to read
    expect(calls.filter(c => c.includes('/notifications/channels/'))).toEqual([]);
  });

  it('asks again after a busy answer, and fails when the device doesn’t answer', async () => {
    const config = testConfig();
    mockDevice({ ...nvrRoutes(), '/ISAPI/Event/triggersCap': statusRoute(503, 2, 'deviceBusy') });
    expect((await Isapi.getEventActionSupport(config)).triggerCap).toBeNull();
    let calls = mockDevice(nvrRoutes());
    expect((await Isapi.getEventActionSupport(config)).triggerCap).not.toBeNull();
    expect(new Set(calls)).toEqual(nvrRequests);

    const offline = testConfig();
    mockDevice({ ...nvrRoutes(), '/ISAPI/Event/triggersCap': { unreachable: true } });
    await expect(Isapi.getEventActionSupport(offline)).rejects.toBeInstanceOf(NetworkError);
    calls = mockDevice(nvrRoutes());
    await Isapi.getEventActionSupport(offline);
    expect(new Set(calls)).toEqual(nvrRequests);
  });

  it('treats a lookup answered with something other than XML as absent, for that load only', async () => {
    const config = testConfig();
    mockDevice({ ...nvrRoutes(), '/ISAPI/Event/triggersCap': { body: '' } });
    const support = await Isapi.getEventActionSupport(config);
    expect(support.triggerCap).toBeNull(); // every action offered, as without triggersCap
    expect(support.alarmOutputs.map(o => o.id)).toEqual(['301', '401']);
    const calls = mockDevice(nvrRoutes());
    expect((await Isapi.getEventActionSupport(config)).triggerCap).not.toBeNull();
    expect(new Set(calls)).toEqual(nvrRequests);

    const htmlPage = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>Not found</body></html>';
    mockDevice({ ...nvrRoutes(), '/ISAPI/System/IO/outputs': { body: htmlPage } });
    const other = await Isapi.getEventActionSupport(testConfig());
    expect(other.alarmOutputs).toEqual([]);
    expect(other.triggerCap).toMatchObject({ isSupportIO: true });
  });

  it('reads IP cameras’ addresses and online state from the NVR’s lists', async () => {
    const calls = mockDevice({
      '/ISAPI/System/Video/inputs/channels': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsNvr },
      '/ISAPI/ContentMgmt/InputProxy/channels/status': { body: fixtures.inputProxyChannelsStatusNvr },
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => [ch.id, ch.kind, ch.ipAddress, ch.online])).toEqual([
      ['1', 'digital', '192.168.254.2', true], ['2', 'digital', '192.168.254.9', true],
      ['3', 'digital', '192.168.254.4', true], ['4', 'digital', '192.168.254.3', true],
    ]);
    expect(calls).toEqual([
      '/ISAPI/System/Video/inputs/channels', '/ISAPI/ContentMgmt/InputProxy/channels',
      '/ISAPI/ContentMgmt/InputProxy/channels/status',
    ]);

    // Matched by id, not position: the status list leaves channel 2 out and has camera 3 disconnected
    const status = fixtures.inputProxyChannelsStatusNvr
      .replace(/<InputProxyChannelStatus [^>]*>\s*<id>2<\/id>[\s\S]*?<\/InputProxyChannelStatus>/, '')
      .replace(/(<id>3<\/id>[\s\S]*?<online>)true/, '$1false');
    mockDevice({
      '/ISAPI/System/Video/inputs/channels': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsNvr },
      '/ISAPI/ContentMgmt/InputProxy/channels/status': { body: status },
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => [ch.id, ch.online])).toEqual([
      ['1', true], ['2', undefined], ['3', false], ['4', true],
    ]);
  });

  it('lists a hybrid DVR’s analog inputs, then its IP cameras', async () => {
    const status = '<InputProxyChannelStatusList>' +
      '<InputProxyChannelStatus><id>5</id><online>true</online></InputProxyChannelStatus>' +
      '<InputProxyChannelStatus><id>6</id><online>false</online></InputProxyChannelStatus>' +
      '</InputProxyChannelStatusList>';
    mockDevice({
      '/ISAPI/System/Video/inputs/channels': { body: fixtures.videoInputChannelsHybrid },
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsHybrid },
      '/ISAPI/ContentMgmt/InputProxy/channels/status': { body: status },
    });
    expect(await Isapi.getChannels(testConfig())).toStrictEqual([
      { id: '1', name: 'Gate', kind: 'analog', online: true },
      { id: '2', name: 'Yard', kind: 'analog', online: true },
      { id: '3', name: '', kind: 'analog', online: true },
      // Switched off on the DVR
      { id: '4', name: 'Garage', kind: 'analog', online: false },
      { id: '5', name: 'Driveway', kind: 'digital', ipAddress: '192.168.254.5', online: true },
      { id: '6', name: 'Back door', kind: 'digital', ipAddress: '192.168.254.6', online: false },
    ]);
  });

  it('keeps an analog input over an IP camera listed with the same id', async () => {
    const ipList = '<InputProxyChannelList><InputProxyChannel><id>2</id><name>Twin</name></InputProxyChannel>' +
      '<InputProxyChannel><id>5</id><name>Driveway</name></InputProxyChannel></InputProxyChannelList>';
    mockDevice({
      '/ISAPI/System/Video/inputs/channels': { body: fixtures.videoInputChannelsHybrid },
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: ipList },
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => [ch.id, ch.name, ch.kind])).toEqual([
      ['1', 'Gate', 'analog'], ['2', 'Yard', 'analog'], ['3', '', 'analog'], ['4', 'Garage', 'analog'], ['5', 'Driveway', 'digital'],
    ]);

    // Every IP camera repeats an analog input: the analog list alone, as before IP lists were read too
    const calls = mockDevice({
      '/ISAPI/System/Video/inputs/channels': { body: fixtures.videoInputChannelsHybrid },
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsNvr },
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => [ch.id, ch.kind])).toEqual([
      ['1', 'analog'], ['2', 'analog'], ['3', 'analog'], ['4', 'analog'],
    ]);
    // No IP camera listed, so no IP camera status to ask for
    expect(calls).toEqual(['/ISAPI/System/Video/inputs/channels', '/ISAPI/ContentMgmt/InputProxy/channels']);
  });

  it('keeps the channels a list has when the other list is refused', async () => {
    mockDevice({
      '/ISAPI/System/Video/inputs/channels': statusRoute(503, 2, 'deviceBusy'),
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsHybrid },
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => ch.id)).toEqual(['5', '6']);

    mockDevice({
      '/ISAPI/System/Video/inputs/channels': { body: fixtures.videoInputChannelsHybrid },
      '/ISAPI/ContentMgmt/InputProxy/channels': statusRoute(403, 4, 'lowPrivilege'),
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => ch.id)).toEqual(['1', '2', '3', '4']);

    // An HTML page for a list the device doesn't have counts as no list
    mockDevice({
      '/ISAPI/System/Video/inputs/channels': { body: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>Not found</body></html>' },
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsHybrid },
    });
    expect((await Isapi.getChannels(testConfig())).map(ch => ch.id)).toEqual(['5', '6']);
  });

  it('leaves IP cameras’ online state unknown when the status can’t be read, unless nothing answers', async () => {
    const htmlPage = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>Not found</body></html>';
    for (const answer of [{ status: 404 }, statusRoute(403, 4, 'notSupport'), statusRoute(403, 4, 'lowPrivilege'),
      statusRoute(503, 2, 'serviceUnavailable'), { body: htmlPage }]) {
      mockDevice({
        '/ISAPI/System/Video/inputs/channels': statusRoute(403, 4, 'notSupport'),
        '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsNvr },
        '/ISAPI/ContentMgmt/InputProxy/channels/status': answer,
      });
      const channels = await Isapi.getChannels(testConfig());
      expect(channels).toHaveLength(4);
      expect(channels.some(ch => 'online' in ch)).toBe(false);
    }

    mockDevice({
      '/ISAPI/System/Video/inputs/channels': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/ContentMgmt/InputProxy/channels': { body: fixtures.inputProxyChannelsNvr },
      '/ISAPI/ContentMgmt/InputProxy/channels/status': { unreachable: true },
    });
    await expect(Isapi.getChannels(testConfig())).rejects.toBeInstanceOf(NetworkError);
  });

  it('finds an NVR trigger in the full list by its dyn channel, and saves it to its own id', async () => {
    const ns = 'xmlns="http://www.isapi.org/ver20/XMLSchema"';
    mockDevice({
      '/ISAPI/Event/triggers': { body: `<EventTriggerList ${ns}>` +
        '<EventTrigger><id>VMD-1</id><eventType>VMD</eventType><dynVideoInputChannelID>1</dynVideoInputChannelID></EventTrigger>' +
        '<EventTrigger><id>motion 3</id><eventType>VMD</eventType><dynVideoInputChannelID>3</dynVideoInputChannelID></EventTrigger>' +
        '</EventTriggerList>' },
    });
    const doc = await Isapi.getEventTrigger(testConfig(), '3');
    expect(childText(doc.documentElement, 'id')).toBe('motion 3');
    expect(Isapi.eventTriggerSavePath(doc, '3')).toBe('/ISAPI/Event/triggers/motion%203');

    expect(Isapi.eventTriggerSavePath(parseXml(fixtures.eventTriggerNvrVmd3), '3')).toBe('/ISAPI/Event/triggers/VMD-3');
    expect(Isapi.eventTriggerSavePath(parseXml('<EventTrigger/>'), '3')).toBe('/ISAPI/Event/triggers/VMD-3');
  });
});
