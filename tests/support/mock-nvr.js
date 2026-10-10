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

/** Today's recordings: continuous 08:00–08:30 and a motion event at 14:05. */
function todaysRecordings() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /** @param {string} start @param {string} end @param {string} type */
  const item = (start, end, type) => `<searchMatchItem><trackID>101</trackID>
    <timeSpan><startTime>${day}T${start}Z</startTime><endTime>${day}T${end}Z</endTime></timeSpan>
    <mediaSegmentDescriptor><playbackURI>rtsp://${NVR_HOST}/Streaming/tracks/101/?name=${start}</playbackURI></mediaSegmentDescriptor>
    <metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/${type}</metadataDescriptor></metadataMatches></searchMatchItem>`;
  return `<CMSearchResult><responseStatusStrg>OK</responseStatusStrg><numOfMatches>2</numOfMatches><matchList>
    ${item('08:00:00', '08:30:00', 'CMR')}${item('14:05:10', '14:06:40', 'VideoMotion')}</matchList></CMSearchResult>`;
}

/**
 * Create the fake device. Returns its observable state and a fetch
 * replacement; requests to other hosts go to `realFetch`.
 * @param {{snapshotDelayMs?: number, realFetch?: typeof fetch}} [options]
 */
export function createMockNvr({ snapshotDelayMs = 50, realFetch = fetch } = {}) {
  const device = {
    requests: [], puts: [], inFlightSnapshots: 0, maxInFlightSnapshots: 0, rejectAuth: false,
    recordedFrames: true, // whether picture?starttime= returns images
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
    if (method === 'POST' && p === '/ISAPI/ContentMgmt/search') return xml(todaysRecordings());
    if (method === 'POST' && p.endsWith('/dailyDistribution')) {
      return xml(`<trackDailyDistribution><dayList><day><dayOfMonth>${new Date().getDate()}</dayOfMonth><record>true</record></day></dayList></trackDailyDistribution>`);
    }
    if (u.searchParams.has('starttime') && p.endsWith('/picture')) {
      return device.recordedFrames ? new Response(await frame(), { status: 200 }) : new Response('<ResponseStatus/>', { status: 200 });
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
