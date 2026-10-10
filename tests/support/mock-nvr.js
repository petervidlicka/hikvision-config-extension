/**
 * A fake Hikvision NVR behind fetch(), plus stubbed chrome.* APIs, for
 * running the real config page outside the extension. Mirrors the NVR this
 * extension was developed against: IP cameras only (analog channel list
 * returns 403 notSupport), configs via InputProxy, polygon motion regions,
 * and errors and write results as <ResponseStatus> bodies.
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

/**
 * A <ResponseStatus> body as the DS-7604NI sends it: hikvision.com ver20
 * namespace, for errors and for write results alike.
 * @param {string} path - echoed as requestURL
 * @param {{statusCode: number, statusString: string, subStatusCode: string, subStatusString?: string}} status
 */
export function responseStatusXml(path, { statusCode, statusString, subStatusCode, subStatusString }) {
  return '<?xml version="1.0" encoding="UTF-8" ?>\n' +
    '<ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">\n' +
    `<requestURL>${path}</requestURL>\n<statusCode>${statusCode}</statusCode>\n` +
    `<statusString>${statusString}</statusString>\n<subStatusCode>${subStatusCode}</subStatusCode>\n` +
    (subStatusString ? `<subStatusString>${subStatusString}</subStatusString>\n` : '') +
    '</ResponseStatus>\n';
}

/** What the DS-7604NI answers for a resource it doesn't have, or a write that succeeded. */
export const STATUS = {
  notSupport: { statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' },
  ok: { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' },
};

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

/** Today's picture track: one stored picture at 00:46:08. */
function todaysPictures() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `<CMSearchResult><responseStatusStrg>OK</responseStatusStrg><numOfMatches>1</numOfMatches><matchList>
    <searchMatchItem><trackID>103</trackID><timeSpan><startTime>${day}T00:46:08Z</startTime><endTime>${day}T00:46:08Z</endTime></timeSpan>
    <mediaSegmentDescriptor><contentType>picture</contentType>
    <playbackURI>http://${NVR_HOST}/picture/Streaming/tracks/103/?starttime=x&amp;name=ch00001_1</playbackURI></mediaSegmentDescriptor>
    </searchMatchItem></matchList></CMSearchResult>`;
}

/**
 * Create the fake device. Returns its observable state and a fetch
 * replacement; requests to other hosts go to `realFetch`.
 *
 * Tests can make it misbehave: `unreachable` fails every request like a
 * wrong IP address, `failures` answers "METHOD /path" with an error status,
 * and `writeStatus` changes what a successful PUT or DELETE reports (e.g.
 * statusCode 7, reboot required).
 * @param {{snapshotDelayMs?: number, realFetch?: typeof fetch}} [options]
 */
export function createMockNvr({ snapshotDelayMs = 50, realFetch = fetch } = {}) {
  const device = {
    requests: [], puts: [], deletes: [], inFlightSnapshots: 0, maxInFlightSnapshots: 0, rejectAuth: false,
    unreachable: false,
    /** @type {Record<string, {httpStatus: number, statusCode: number, statusString: string, subStatusCode: string, subStatusString?: string}>} */
    failures: {},
    writeStatus: STATUS.ok,
    /** How picture?starttime= behaves: real stills, the live image whatever the time (like the DS-7604), or no image */
    recordedFrames: /** @type {'real'|'ignoresTime'|'none'} */ ('real'),
  };
  const xml = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/xml; charset="UTF-8"' } });

  device.fetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    if (u.hostname !== NVR_HOST) return realFetch(url, opts);
    const method = opts.method || 'GET';
    const p = u.pathname;
    device.requests.push(`${method} ${p}`);
    if (device.unreachable) throw new TypeError('Failed to fetch');
    if (device.rejectAuth) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } });
    }
    const failure = device.failures[`${method} ${p}`];
    if (failure) return xml(responseStatusXml(p, failure), failure.httpStatus);
    if (method === 'PUT') {
      device.puts.push({ path: p, body: opts.body });
      return xml(responseStatusXml(p, device.writeStatus));
    }
    if (method === 'DELETE') {
      device.deletes.push(p);
      return xml(responseStatusXml(p, device.writeStatus));
    }
    if (method === 'POST' && p === '/ISAPI/ContentMgmt/search') {
      return xml(/<trackID>\d+03<\/trackID>/.test(String(opts.body)) ? todaysPictures() : todaysRecordings());
    }
    if (p.startsWith('/picture/Streaming/tracks/')) return new Response(await frame(), { status: 200 });
    if (method === 'POST' && p.endsWith('/dailyDistribution')) {
      return xml(`<trackDailyDistribution><dayList><day><dayOfMonth>${new Date().getDate()}</dayOfMonth><record>true</record></day></dayList></trackDailyDistribution>`);
    }
    if (u.searchParams.has('starttime') && p.endsWith('/picture')) {
      const before2001 = (u.searchParams.get('starttime') ?? '').startsWith('2000');
      const image = device.recordedFrames === 'ignoresTime' || (device.recordedFrames === 'real' && !before2001);
      return image ? new Response(await frame(), { status: 200 }) : new Response('<ResponseStatus/>', { status: 200 });
    }
    if (p === '/ISAPI/System/deviceInfo') return xml('<DeviceInfo><deviceName>Mock NVR</deviceName><model>DS-7604</model><firmwareVersion>V4.0</firmwareVersion></DeviceInfo>');
    if (p === '/ISAPI/System/Video/inputs/channels') return xml(responseStatusXml(p, STATUS.notSupport), 403);
    if (p === '/ISAPI/ContentMgmt/InputProxy/channels') {
      return xml('<InputProxyChannelList>' +
        '<InputProxyChannel><id>1</id><name>Front &amp; Gate</name></InputProxyChannel>' +
        '<InputProxyChannel><id>2</id><name>&lt;img src=x onerror=alert(1)&gt;</name></InputProxyChannel>' +
        '</InputProxyChannelList>');
    }
    if (/^\/ISAPI\/Streaming\/channels\/\d+0[12]\/picture$/.test(p)) {
      device.inFlightSnapshots++;
      device.maxInFlightSnapshots = Math.max(device.maxInFlightSnapshots, device.inFlightSnapshots);
      // Like a real connection, an aborted request stops occupying the device at once
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          device.inFlightSnapshots--;
          resolve();
        }, snapshotDelayMs);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          device.inFlightSnapshots--;
          reject(opts.signal.reason);
        });
      });
      return new Response(await frame(), { status: 200 });
    }
    // Channel 2 is a camera that only supports the cell grid
    if (p.endsWith('/motionDetection/capabilities')) {
      return xml(p.includes('/channels/2/') ? motionCapabilities.replace('opt="grid,region"', 'opt="grid"') : motionCapabilities);
    }
    if (p.endsWith('/motionDetection')) return xml(motionDetection);
    if (p.endsWith('/privacyMask')) return xml(privacyMask);
    if (/\/Event\/triggers\/VMD-\d+$/.test(p)) return xml(eventTrigger);
    // The DS-7604NI answers any path it doesn't have like this, not with 404
    return xml(responseStatusXml(p, STATUS.notSupport), 403);
  };
  return device;
}
