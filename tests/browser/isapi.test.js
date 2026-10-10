/**
 * ISAPI client routing, fallbacks, write results and time limits, with fetch
 * replaced by a fake device.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../extension/lib/digest-auth.js';
import { IsapiError, NetworkError, TimeoutError } from '../../extension/lib/errors.js';
import { Isapi, TIMEOUT_MS, defaultTimeoutMs } from '../../extension/lib/isapi.js';
import { childText, parseXml, serializeXml } from '../../extension/lib/xml.js';
import { STATUS, responseStatusXml } from '../support/mock-nvr.js';

/**
 * Replace fetch with a router keyed by path, or by "METHOD path" for one
 * method; unknown paths return 404. A route with `hang` never answers until
 * the request's signal aborts it, like a stalled device; one with
 * `unreachable` fails like a wrong IP address.
 * @returns {string[]} the requested paths, in order
 */
function mockDevice(routes) {
  const calls = [];
  vi.stubGlobal('fetch', async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const r = routes[`${opts.method ?? 'GET'} ${path}`] ?? routes[path];
    if (!r) return new Response('', { status: 404 });
    if (r.unreachable) throw new TypeError('Failed to fetch');
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

let configSeq = 0;
/** Fresh credentials per test so the rejected-credentials guard doesn't leak between tests. */
const testConfig = () => ({ host: '10.9.9.9', port: 80, username: `user${++configSeq}`, password: 'pw' });

afterEach(() => {
  vi.unstubAllGlobals();
  Isapi.onAuthFailure = null;
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

  it('falls back to the main stream when a camera has no sub-stream', async () => {
    const calls = mockDevice({ '/ISAPI/Streaming/channels/301/picture': { body: new Uint8Array([0xff, 0xd8]) } });
    const blob = await Isapi.getSnapshot(testConfig(), '3', 'sub');
    expect(blob.size).toBe(2);
    expect(calls).toEqual(['/ISAPI/Streaming/channels/302/picture', '/ISAPI/Streaming/channels/301/picture']);
  });

  it('returns snapshots as JPEG blobs', async () => {
    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { body: new Uint8Array([0xff, 0xd8, 0xff]) } });
    const blob = await Isapi.getSnapshot(testConfig(), '1');
    expect([blob.type, blob.size]).toEqual(['image/jpeg', 3]);
  });

  it('stops snapshot fallbacks when the camera isn’t available (503) or the device is slow', async () => {
    let calls = mockDevice({ '/ISAPI/Streaming/channels/501/picture': statusRoute(503, 2, 'serviceUnavailable', 'Device Busy') });
    await expect(Isapi.getSnapshot(testConfig(), '5')).rejects.toMatchObject({ httpStatus: 503, subStatusCode: 'serviceUnavailable' });
    expect(calls).toEqual(['/ISAPI/Streaming/channels/501/picture']);

    calls = mockDevice({ '/ISAPI/Streaming/channels/102/picture': { hang: true } });
    await expect(Isapi.getSnapshot(testConfig(), '1', 'sub', { timeoutMs: 50 })).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toEqual(['/ISAPI/Streaming/channels/102/picture']);
  });

  it('tries the bare channel ID after a "not here" answer, keeping the candidate order', async () => {
    const calls = mockDevice({
      '/ISAPI/Streaming/channels/101/picture': statusRoute(403, 4, 'notSupport'),
      '/ISAPI/Streaming/channels/1/picture': { body: new Uint8Array([0xff, 0xd8]) },
    });
    expect((await Isapi.getSnapshot(testConfig(), '1')).size).toBe(2);
    expect(calls).toEqual(['/ISAPI/Streaming/channels/101/picture', '/ISAPI/Streaming/channels/1/picture']);
  });

  it('aborts a snapshot when the caller’s signal fires', async () => {
    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { hang: true } });
    const controller = new AbortController();
    const pending = Isapi.getSnapshot(testConfig(), '1', 'main', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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

  it('applies the policy to channel lists, capabilities and event triggers', async () => {
    let calls = mockDevice({ '/ISAPI/System/Video/inputs/channels': statusRoute(403, 4, 'lowPrivilege') });
    await expect(Isapi.getChannels(testConfig())).rejects.toBeInstanceOf(IsapiError);
    expect(calls).toEqual(['/ISAPI/System/Video/inputs/channels']);

    const channel = { id: '1', kind: 'digital' };
    const caps = '/ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection/capabilities';
    mockDevice({ [caps]: statusRoute(403, 4, 'notSupport') });
    expect(await Isapi.getMotionCapabilities(testConfig(), channel)).toBeNull();
    mockDevice({ [caps]: statusRoute(503, 2, 'deviceBusy') });
    await expect(Isapi.getMotionCapabilities(testConfig(), channel)).rejects.toMatchObject({ subStatusCode: 'deviceBusy' });

    calls = mockDevice({ '/ISAPI/Event/triggers/VMD-1': statusRoute(503, 2, 'deviceBusy') });
    await expect(Isapi.getEventTrigger(testConfig(), '1')).rejects.toMatchObject({ httpStatus: 503 });
    expect(calls).toEqual(['/ISAPI/Event/triggers/VMD-1']);
  });

  it('treats any error answer as "no recorded frame", but not a missing answer', async () => {
    const time = new Date(2024, 0, 1, 12);
    mockDevice({}); // 404 everywhere
    expect(await Isapi.getRecordedFrame(testConfig(), '1', time)).toBeNull();

    mockDevice({ '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture': statusRoute(503, 2, 'serviceUnavailable') });
    expect(await Isapi.getRecordedFrame(testConfig(), '1', time)).toBeNull();

    mockDevice({ '/ISAPI/ContentMgmt/StreamingProxy/channels/101/picture': { unreachable: true } });
    await expect(Isapi.getRecordedFrame(testConfig(), '1', time)).rejects.toBeInstanceOf(NetworkError);
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

describe('request time limits', () => {
  it('gives each kind of request its own budget', () => {
    expect(defaultTimeoutMs('GET', '/ISAPI/Streaming/channels/101/picture')).toBe(TIMEOUT_MS.picture);
    expect(defaultTimeoutMs('GET', '/picture/Streaming/tracks/103/?name=x')).toBe(TIMEOUT_MS.picture);
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

