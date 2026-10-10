/**
 * A fake Hikvision NVR behind fetch(), plus stubbed chrome.* APIs, for
 * running the real config page outside the extension. Mirrors the NVR this
 * extension was developed against: IP cameras only (analog channel list
 * returns 403), configs via InputProxy, polygon motion regions.
 *
 * Used by tests/browser/app.test.js and the manual harness in tests/harness/.
 */
import motionDetection from '../fixtures/motionDetection.xml?raw';
import motionCapabilities from '../fixtures/motionCapabilities-nvr.xml?raw';
import privacyMask from '../fixtures/privacyMask.xml?raw';
import eventTrigger from '../fixtures/eventTrigger.xml?raw';

export const NVR_HOST = '192.168.0.108';

/** In-memory chrome.storage areas, chrome.permissions that always grant. */
export function createChromeStub() {
  const store = { local: {}, session: {} };
  const area = (name) => ({
    get: (keys, cb) => {
      const out = {};
      for (const k of [].concat(keys)) if (k in store[name]) out[k] = store[name][k];
      return cb ? cb(out) : Promise.resolve(out);
    },
    set: (obj) => { Object.assign(store[name], obj); return Promise.resolve(); },
    remove: (k) => { delete store[name][k]; return Promise.resolve(); },
  });
  return {
    store,
    chrome: {
      storage: { local: area('local'), session: area('session') },
      permissions: { request: async () => true, remove: async () => true },
      runtime: { id: 'test', getURL: (p) => p },
    },
  };
}

/** A small JPEG frame that changes every call. */
async function frame() {
  const canvas = new OffscreenCanvas(320, 180);
  const g = canvas.getContext('2d');
  g.fillStyle = `hsl(${(Date.now() / 20) % 360} 60% 40%)`;
  g.fillRect(0, 0, 320, 180);
  return canvas.convertToBlob({ type: 'image/jpeg' });
}

/**
 * Create the fake device. Returns its observable state and a fetch
 * replacement; requests to other hosts go to `realFetch`.
 * @param {{snapshotDelayMs?: number, realFetch?: typeof fetch}} [options]
 */
export function createMockNvr({ snapshotDelayMs = 50, realFetch = fetch } = {}) {
  const device = {
    requests: [], puts: [], inFlightSnapshots: 0, maxInFlightSnapshots: 0, rejectAuth: false,
  };
  const xml = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });

  device.fetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    if (u.hostname !== NVR_HOST) return realFetch(url, opts);
    const method = opts.method || 'GET';
    const p = u.pathname;
    device.requests.push(`${method} ${p}`);
    if (device.rejectAuth) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } });
    }
    if (method === 'PUT') {
      device.puts.push({ path: p, body: opts.body });
      return xml('<ResponseStatus><statusCode>1</statusCode></ResponseStatus>');
    }
    if (p === '/ISAPI/System/deviceInfo') return xml('<DeviceInfo><deviceName>Mock NVR</deviceName><model>DS-7604</model><firmwareVersion>V4.0</firmwareVersion></DeviceInfo>');
    if (p === '/ISAPI/System/Video/inputs/channels') return new Response('', { status: 403 });
    if (p === '/ISAPI/ContentMgmt/InputProxy/channels') {
      return xml('<InputProxyChannelList>' +
        '<InputProxyChannel><id>1</id><name>Front &amp; Gate</name></InputProxyChannel>' +
        '<InputProxyChannel><id>2</id><name>&lt;img src=x onerror=alert(1)&gt;</name></InputProxyChannel>' +
        '</InputProxyChannelList>');
    }
    if (/^\/ISAPI\/Streaming\/channels\/\d+0[12]\/picture$/.test(p)) {
      device.inFlightSnapshots++;
      device.maxInFlightSnapshots = Math.max(device.maxInFlightSnapshots, device.inFlightSnapshots);
      await new Promise(r => setTimeout(r, snapshotDelayMs));
      device.inFlightSnapshots--;
      return new Response(await frame(), { status: 200 });
    }
    // Channel 2 is a camera that only supports the cell grid
    if (p.endsWith('/motionDetection/capabilities')) {
      return xml(p.includes('/channels/2/') ? motionCapabilities.replace('opt="grid,region"', 'opt="grid"') : motionCapabilities);
    }
    if (p.endsWith('/motionDetection')) return xml(motionDetection);
    if (p.endsWith('/privacyMask')) return xml(privacyMask);
    if (/\/Event\/triggers\/VMD-\d+$/.test(p)) return xml(eventTrigger);
    return new Response('', { status: 404 });
  };
  return device;
}
