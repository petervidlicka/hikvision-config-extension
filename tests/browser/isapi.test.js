/**
 * ISAPI client routing and fallbacks, with fetch replaced by a fake device.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../extension/lib/digest-auth.js';
import { Isapi } from '../../extension/lib/isapi.js';
import { childText, serializeXml } from '../../extension/lib/xml.js';

/** Replace fetch with a router keyed by path; unknown paths return 404. */
function mockDevice(routes) {
  const calls = [];
  vi.stubGlobal('fetch', async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const r = routes[path];
    if (!r) return new Response('', { status: 404 });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  });
  return calls;
}

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

  it('returns snapshots as JPEG blobs', async () => {
    mockDevice({ '/ISAPI/Streaming/channels/101/picture': { body: new Uint8Array([0xff, 0xd8, 0xff]) } });
    const blob = await Isapi.getSnapshot(testConfig(), '1');
    expect([blob.type, blob.size]).toEqual(['image/jpeg', 3]);
  });
});
