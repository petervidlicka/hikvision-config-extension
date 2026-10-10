/**
 * A fake Hikvision NVR behind fetch(), plus stubbed chrome.* APIs, for
 * running the real config page outside the extension. Mirrors the NVR this
 * extension was developed against: four IP cameras (analog channel list
 * returns 403 notSupport), configs via InputProxy, polygon motion regions,
 * privacy masks and event triggers stored the way the NVR stores them, the
 * cameras on channels 3 and 4 with a relay, white light and speaker,
 * errors and write results as <ResponseStatus> bodies, the userCheck
 * login check, which cameras are online, their 2688×1520 main streams, the
 * NVR's squeezed 704×576 snapshots, and its clock with an offset that
 * leaves out daylight saving.
 *
 * Used by tests/browser/app.test.js, tests/timezones/ and the manual harness
 * in tests/harness/.
 */
import motionDetection from '../fixtures/motionDetection-nvr.xml?raw';
import motionCapabilities from '../fixtures/motionCapabilities-nvr.xml?raw';
import motionLayoutCapabilities from '../fixtures/motionLayoutCapabilities-nvr.xml?raw';
import privacyMaskRegions from '../fixtures/privacyMask-nvr-regions.xml?raw';
import eventTrigger from '../fixtures/eventTrigger.xml?raw';
import eventTriggerNvr from '../fixtures/eventTrigger-nvr.xml?raw';
import triggersCap from '../fixtures/triggersCap-nvr.xml?raw';
import ioOutputs from '../fixtures/ioOutputs-nvr.xml?raw';
import ioOutputsCapabilities from '../fixtures/ioOutputsCapabilities-nvr.xml?raw';
import whiteLightAlarmChannels from '../fixtures/whiteLightAlarmChannels-nvr.json?raw';
import audioAlarmChannels from '../fixtures/audioAlarmChannels-nvr.json?raw';
import userCheck from '../fixtures/userCheck-nvr.xml?raw';
import channelStatus from '../fixtures/inputProxyChannelsStatus-nvr.xml?raw';
import streamingChannels from '../fixtures/streamingChannels-nvr.xml?raw';
import systemTime from '../fixtures/systemTime-nvr.xml?raw';

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

/** The 401 page the DS-7604NI (V4.75) sends with every challenge. */
const UNAUTHORIZED_HTML = '<!DOCTYPE html>\n<head>\n    <title>Unauthorized</title>\n</head>\n<body>\n' +
  '<h2>Access Error: 401 -- Unauthorized</h2>\n<pre></pre>\n</body>\n</html>\n';

/**
 * A rejected userCheck that explains itself, in the form Hikvision's web UI
 * and HCNetSDK parse. Not captured from the DS-7604NI: that would cost a
 * failed login on the real device.
 * @param {{lockStatus: 'lock'|'unlock', unlockTime: number, retryLoginTime: number}} lock
 */
function userCheckRejectedXml({ lockStatus, unlockTime, retryLoginTime }) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<userCheck version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">\n' +
    '<statusValue>401</statusValue>\n<statusString>Unauthorized</statusString>\n' +
    `<lockStatus>${lockStatus}</lockStatus>\n<unlockTime>${unlockTime}</unlockTime>\n` +
    `<retryLoginTime>${retryLoginTime}</retryLoginTime>\n</userCheck>\n`;
}

/**
 * What the DS-7604NI answers for a resource it doesn't have, a write that
 * succeeded, or a snapshot of a channel without a camera (HTTP 503).
 */
export const STATUS = {
  notSupport: { statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' },
  ok: { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' },
  serviceUnavailable: { statusCode: 2, statusString: 'Device Busy', subStatusCode: 'serviceUnavailable' },
};

/** The channel id in a per-channel path such as …/channels/2/video/motionDetection. @param {string} path */
const channelOf = (path) => /\/channels\/(\d+)\//.exec(path)?.[1] ?? '';

/** Direct children of `el` with the given local name. */
const children = (el, name) => (el ? [...el.children].filter(c => c.localName === name) : []);

/**
 * Privacy masks per channel, stored the way the DS-7604NI stores them (write
 * tests on channel 3): a PUT of /privacyMask sets the global <enabled> and
 * MERGES the regions it sends into the stored ones by id, so a region left
 * out stays stored; DELETE /privacyMask/regions clears them all; and every
 * region reads back with <enabled>false</enabled>, whatever was sent. Each
 * channel starts with the two regions of privacyMask-nvr-regions.xml.
 */
function createPrivacyStore() {
  /** @type {Map<string, XMLDocument>} */
  const docs = new Map();
  /** @param {string} path - …/privacyMask */
  const stored = (path) => {
    if (!docs.has(path)) docs.set(path, new DOMParser().parseFromString(privacyMaskRegions, 'application/xml'));
    return docs.get(path);
  };
  const regionList = (doc) => children(doc.documentElement, 'PrivacyMaskRegionList')[0];
  const idOf = (region) => children(region, 'id')[0]?.textContent.trim();

  return {
    /** The document a GET returns. @param {string} path */
    read: (path) => new XMLSerializer().serializeToString(stored(path)),
    /** @param {string} path @param {string} body */
    put(path, body) {
      const doc = stored(path);
      const sent = new DOMParser().parseFromString(body, 'application/xml').documentElement;
      const enabled = children(sent, 'enabled')[0];
      if (enabled) children(doc.documentElement, 'enabled')[0].textContent = enabled.textContent;
      const list = regionList(doc);
      for (const region of children(children(sent, 'PrivacyMaskRegionList')[0], 'PrivacyMaskRegion')) {
        const copy = doc.importNode(region, true);
        for (const flag of children(copy, 'enabled')) flag.textContent = 'false';
        const existing = children(list, 'PrivacyMaskRegion').find(r => idOf(r) === idOf(region));
        if (existing) existing.replaceWith(copy);
        else list.appendChild(copy);
      }
    },
    /** @param {string} path - …/privacyMask */
    clear: (path) => regionList(stored(path)).replaceChildren(),
  };
}

/**
 * Motion (VMD) triggers per channel; a PUT replaces what a GET returns.
 * Channel 1 starts camera-style (eventTrigger.xml: notificationRecurrence on
 * every entry, a local relay IO-2), the others the way the DS-7604NI stores
 * an IP channel's (record-N and center). Like the DS-7604NI, a PUT with a
 * bare "whiteLight" or "audio" method fails as a whole (400 badXmlContent).
 */
function createTriggerStore() {
  /** @type {Map<string, string>} */
  const docs = new Map();
  /** @param {string} channel */
  const initial = (channel) => (channel === '1'
    ? eventTrigger
    : eventTriggerNvr.replace(/>(VMD-|record-)?1</g, `>$1${channel}<`));
  return {
    /** @param {string} channel */
    read: (channel) => docs.get(channel) ?? initial(channel),
    /**
     * @param {string} body - a PUT of a trigger
     * @returns {boolean} whether the device would accept it
     */
    accepts: (body) => !/<notificationMethod>(whiteLight|audio)<\/notificationMethod>/.test(body),
    /** @param {string} channel @param {string} body */
    write: (channel, body) => { docs.set(channel, body); },
  };
}

let framesDrawn = 0;

/** The DS-7604NI's plain snapshot: 4CIF, whatever the camera's aspect. */
export const STILL_SIZE = Object.freeze({ width: 704, height: 576 });
/** The DS-7604NI's snapshot when asked for any other size. */
export const FULL_SIZE_STILL = Object.freeze({ width: 1920, height: 1088 });

/**
 * A JPEG frame of a 16:9 scene, a different one every call: its colour
 * drifts, it shows the time and a counter, and a circle. Drawn into any size
 * the way the DS-7604NI does, the whole scene stretched to fill it, so in a
 * 704×576 frame the circle is a tall ellipse until shown at 16:9.
 * @param {{width: number, height: number}} size
 */
async function frame({ width, height }) {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  g.scale(width / 320, height / 180);
  g.fillStyle = `hsl(${(Date.now() / 20) % 360} 60% 40%)`;
  g.fillRect(0, 0, 320, 180);
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(160, 100, 50, 0, 2 * Math.PI);
  g.stroke();
  g.fillStyle = '#fff';
  g.font = '14px sans-serif';
  g.fillText(`${new Date().toISOString().slice(11, 23)} #${++framesDrawn}`, 8, 20);
  return canvas.convertToBlob({ type: 'image/jpeg' });
}

/**
 * A moment on the browser's wall clock, as a device writes its own time.
 * @param {Date} moment
 * @returns {string} "YYYY-MM-DDThh:mm:ss"
 */
function wallClock(moment) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}` +
    `T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`;
}

/**
 * Every day's recordings: continuous 08:00–08:30, a manual one at 10:00 and
 * a motion event at 14:05.
 * @type {{start: string, end: string, type: string}[]}
 */
const DAILY_RECORDINGS = [
  { start: '08:00:00', end: '08:30:00', type: 'CMR' },
  { start: '10:00:00', end: '10:05:00', type: 'manual' },
  { start: '14:05:10', end: '14:06:40', type: 'VideoMotion' },
];

/**
 * A video search's answer: the recordings at these wall-clock times on a day.
 * @param {string} day - "YYYY-MM-DD", the day the search starts on
 * @param {{start: string, end: string, type: string}[]} recordings
 */
function recordingsOn(day, recordings) {
  /** @param {{start: string, end: string, type: string}} r */
  const item = ({ start, end, type }) => `<searchMatchItem><trackID>101</trackID>
    <timeSpan><startTime>${day}T${start}Z</startTime><endTime>${day}T${end}Z</endTime></timeSpan>
    <mediaSegmentDescriptor><playbackURI>rtsp://${NVR_HOST}/Streaming/tracks/101/?name=${start}</playbackURI></mediaSegmentDescriptor>
    <metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/${type}</metadataDescriptor></metadataMatches></searchMatchItem>`;
  return `<CMSearchResult><responseStatusStrg>OK</responseStatusStrg><numOfMatches>${recordings.length}</numOfMatches><matchList>
    ${recordings.map(item).join('')}</matchList></CMSearchResult>`;
}

/**
 * A picture search's answer: one stored picture at 00:46:08 on a day.
 * @param {string} day - "YYYY-MM-DD"
 */
function picturesOn(day) {
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
 * It accepts any request unless `digestAuth` is set: then, like V4.75, it
 * answers a request without credentials, or with a nonce it never issued,
 * with a 401 challenge carrying a fresh nonce (not a failed login), and
 * accepts any nonce it issued (`authorized` counts those requests), so the
 * page keeps a cached challenge as with the real NVR.
 *
 * Tests can make it misbehave: `unreachable` fails every request like a
 * wrong IP address, `rejectAuth` answers every request with a 401 like a
 * password changed on the device (each with a fresh nonce, like V4.75;
 * `failedLogins` counts the ones that carried credentials), `loginLock`
 * makes a rejected userCheck say the device has locked this computer out or
 * how many attempts are left, `failures` answers "METHOD /path" with an error status
 * (only the first `times` requests, when set), `holds` keeps "METHOD /path"
 * unanswered until its promise settles, `writeStatus` changes what a
 * successful PUT or DELETE reports (e.g. statusCode 7, reboot required), and
 * `offlineChannels` lists the cameras the NVR's status reports disconnected
 * (e.g. ['4']); their snapshots answer 503 serviceUnavailable, as an empty
 * channel's do on the DS-7604NI. `privacy.read(path)` shows the privacy
 * masks a channel stores, `triggers.read(channel)` its motion trigger.
 * `motionDocs` replaces a channel's motion document (by channel id; the
 * others are the DS-7604NI's channel 1).
 *
 * Every day has `recordings` (wall-clock times; the search answers for the
 * day it starts on) and a stored picture at 00:46:08, and `searches` lists
 * the search bodies. The device's clock (/ISAPI/System/time) is the
 * browser's wall clock, or `localTime` when set: e.g. a device in another
 * time zone, or on a daylight-saving changeover day.
 *
 * Live snapshots take `snapshotDelayMs` to answer (changeable later) and
 * are a new picture every time, like a camera's, unless `snapshotRefreshMs`
 * is set: then each channel serves the same cached still until it is
 * refreshed, every that many ms, the same on the main and sub stream and
 * through StreamingProxy, like the DS-7604NI (about every 1000 ms). Like
 * its, they are `stillSize` (704×576, a 16:9 scene squeezed), and
 * `fullSizeStill` (1920×1088) when the request asks for any other size with
 * videoResolutionWidth/Height; set `fullSizeStill` to null for firmware that
 * ignores the size. `urls` lists each request with its query, as `requests`
 * does without.
 * @param {{snapshotDelayMs?: number, realFetch?: typeof fetch}} [options]
 */
export function createMockNvr({ snapshotDelayMs = 50, realFetch = fetch } = {}) {
  /** Each channel's cached still per size, when snapshotRefreshMs is set. @type {Map<string, {refresh: number, blob: Blob}>} */
  const stills = new Map();
  const device = {
    snapshotDelayMs,
    /** 0: a new picture every request; else how often each channel's still changes */
    snapshotRefreshMs: 0,
    /** @type {{width: number, height: number}} */
    stillSize: STILL_SIZE,
    /** @type {{width: number, height: number}|null} */
    fullSizeStill: FULL_SIZE_STILL,
    requests: [], urls: [], puts: [], deletes: [], inFlightSnapshots: 0, maxInFlightSnapshots: 0, rejectAuth: false,
    unreachable: false, failedLogins: 0, noncesIssued: 0, digestAuth: false, authorized: 0,
    /** @type {null | {lockStatus: 'lock'|'unlock', unlockTime: number, retryLoginTime: number}} */
    loginLock: null,
    /** @type {Record<string, {httpStatus: number, statusCode: number, statusString: string, subStatusCode: string, subStatusString?: string, times?: number}>} */
    failures: {},
    /** @type {Record<string, Promise<void>>} */
    holds: {},
    writeStatus: STATUS.ok,
    /** @type {string[]} */
    offlineChannels: [],
    privacy: createPrivacyStore(),
    triggers: createTriggerStore(),
    /** @type {Record<string, string>} a channel's motion document instead of the DS-7604NI's */
    motionDocs: {},
    /** How picture?starttime= behaves: real stills, the live image whatever the time (like the DS-7604), or no image */
    recordedFrames: /** @type {'real'|'ignoresTime'|'none'} */ ('real'),
    /** What /ISAPI/System/time says, e.g. "2026-10-25T15:00:00+01:00"; null: the browser's wall clock */
    localTime: /** @type {string|null} */ (null),
    /** Each day's recordings, by wall-clock time */
    recordings: DAILY_RECORDINGS,
    /** @type {string[]} the bodies of recording and picture searches */
    searches: [],
  };
  /** Every nonce the device has issued; it accepts each of them again, like V4.75. */
  const nonces = new Set();
  /**
   * A 401 with a fresh nonce, as V4.75 answers every request it doesn't accept.
   * @param {string} [body]
   * @param {string} [type]
   */
  const unauthorized = (body = UNAUTHORIZED_HTML, type = 'text/html') => {
    const nonce = `n${++device.noncesIssued}`;
    nonces.add(nonce);
    return new Response(body, {
      status: 401,
      headers: { 'Content-Type': type, 'WWW-Authenticate': `Digest realm="r", qop="auth", nonce="${nonce}", stale="FALSE"` },
    });
  };
  const xml = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/xml; charset="UTF-8"' } });
  const json = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset="UTF-8"' } });
  /**
   * The size of the still a snapshot request gets: the full-size one when it
   * asks for a size other than the plain still's, like the DS-7604NI.
   * @param {URLSearchParams} query
   */
  const stillSizeFor = (query) => {
    const width = Number(query.get('videoResolutionWidth'));
    const height = Number(query.get('videoResolutionHeight'));
    const asksOtherSize = width > 0 && height > 0 && (width !== device.stillSize.width || height !== device.stillSize.height);
    return asksOtherSize && device.fullSizeStill ? device.fullSizeStill : device.stillSize;
  };
  /**
   * A channel's live picture as it is now.
   * @param {string} channel
   * @param {{width: number, height: number}} size
   */
  const livePicture = async (channel, size) => {
    if (!device.snapshotRefreshMs) return frame(size);
    const refresh = Math.floor(performance.now() / device.snapshotRefreshMs);
    const key = `${channel}|${size.width}x${size.height}`;
    const still = stills.get(key);
    if (still?.refresh === refresh) return still.blob;
    const blob = await frame(size);
    stills.set(key, { refresh, blob });
    return blob;
  };

  device.fetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    if (u.hostname !== NVR_HOST) return realFetch(url, opts);
    const method = opts.method || 'GET';
    const p = u.pathname;
    device.requests.push(`${method} ${p}`);
    device.urls.push(`${method} ${p}${u.search}`);
    // Awaited only when set, so other requests reach the device in the same tick as before
    const hold = device.holds[`${method} ${p}`];
    if (hold) await hold;
    if (device.unreachable) throw new TypeError('Failed to fetch');
    const authorization = new Headers(opts.headers).get('Authorization');
    if (device.rejectAuth) {
      if (authorization) device.failedLogins++;
      const explained = authorization && device.loginLock && p === '/ISAPI/Security/userCheck';
      return explained ? unauthorized(userCheckRejectedXml(device.loginLock), 'application/xml') : unauthorized();
    }
    if (device.digestAuth) {
      const nonce = /\bnonce="([^"]*)"/.exec(authorization ?? '')?.[1];
      if (!nonce || !nonces.has(nonce)) return unauthorized();
      device.authorized++;
    }
    const failure = device.failures[`${method} ${p}`];
    if (failure) {
      if (failure.times !== undefined && --failure.times <= 0) delete device.failures[`${method} ${p}`];
      return xml(responseStatusXml(p, failure), failure.httpStatus);
    }
    // A write the device reports as stored (OK, or OK after a reboot) changes what it stores
    const stores = device.writeStatus.statusCode === STATUS.ok.statusCode || device.writeStatus.statusCode === 7;
    if (method === 'PUT') {
      device.puts.push({ path: p, body: opts.body });
      if (stores && p.endsWith('/privacyMask')) device.privacy.put(p, String(opts.body));
      const trigger = p.match(/^\/ISAPI\/Event\/triggers\/VMD-(\d+)$/);
      if (trigger && !device.triggers.accepts(String(opts.body))) {
        return xml(responseStatusXml(p, {
          statusCode: 6, statusString: 'Invalid XML Content', subStatusCode: 'badXmlContent',
          subStatusString: 'Tag 16 is invalid (two root tags)',
        }), 400);
      }
      if (stores && trigger) device.triggers.write(trigger[1], String(opts.body));
      return xml(responseStatusXml(p, device.writeStatus));
    }
    if (method === 'DELETE') {
      device.deletes.push(p);
      if (stores && p.endsWith('/privacyMask/regions')) device.privacy.clear(p.slice(0, -'/regions'.length));
      return xml(responseStatusXml(p, device.writeStatus));
    }
    if (method === 'POST' && p === '/ISAPI/ContentMgmt/search') {
      const body = String(opts.body);
      const day = /<startTime>(\d{4}-\d{2}-\d{2})T/.exec(body)?.[1] ?? '';
      device.searches.push(body);
      return xml(/<trackID>\d+03<\/trackID>/.test(body) ? picturesOn(day) : recordingsOn(day, device.recordings));
    }
    // A stored picture is 1280×720 on the DS-7604NI
    if (p.startsWith('/picture/Streaming/tracks/')) return new Response(await frame({ width: 1280, height: 720 }), { status: 200 });
    if (method === 'POST' && p.endsWith('/dailyDistribution')) {
      // Every day has recordings, as every day's search finds some
      const year = Number(/<year>(\d+)</.exec(String(opts.body))?.[1]);
      const month = Number(/<monthOfYear>(\d+)</.exec(String(opts.body))?.[1]);
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return xml('<trackDailyDistribution><dayList>' + Array.from({ length: days }, (_, i) =>
        `<day><dayOfMonth>${i + 1}</dayOfMonth><record>true</record></day>`).join('') + '</dayList></trackDailyDistribution>');
    }
    if (u.searchParams.has('starttime') && p.endsWith('/picture')) {
      const before2001 = (u.searchParams.get('starttime') ?? '').startsWith('2000');
      const image = device.recordedFrames === 'ignoresTime' || (device.recordedFrames === 'real' && !before2001);
      return image ? new Response(await frame(device.stillSize), { status: 200 }) : new Response('<ResponseStatus/>', { status: 200 });
    }
    if (p === '/ISAPI/Security/userCheck') return xml(userCheck);
    if (p === '/ISAPI/System/time') {
      // Like the DS-7604NI's: the right wall-clock time with a "+01:00" that
      // leaves out daylight saving
      return xml(systemTime.replace(/<localTime>[^<]*</, `<localTime>${device.localTime ?? `${wallClock(new Date())}+01:00`}<`));
    }
    if (p === '/ISAPI/System/deviceInfo') return xml('<DeviceInfo><deviceName>Mock NVR</deviceName><model>DS-7604</model><firmwareVersion>V4.0</firmwareVersion></DeviceInfo>');
    if (p === '/ISAPI/System/Video/inputs/channels') return xml(responseStatusXml(p, STATUS.notSupport), 403);
    if (p === '/ISAPI/ContentMgmt/InputProxy/channels') {
      // The DS-7604NI's camera addresses: channels 3 and 4 own outputs 301 and 401
      const channel = (id, name, ip) => `<InputProxyChannel><id>${id}</id><name>${name}</name>` +
        `<sourceInputPortDescriptor><ipAddress>${ip}</ipAddress></sourceInputPortDescriptor></InputProxyChannel>`;
      return xml('<InputProxyChannelList>' +
        channel(1, 'Front &amp; Gate', '192.168.254.2') +
        channel(2, '&lt;img src=x onerror=alert(1)&gt;', '192.168.254.9') +
        channel(3, 'Garage', '192.168.254.4') +
        channel(4, 'Slide', '192.168.254.3') +
        '</InputProxyChannelList>');
    }
    if (p === '/ISAPI/Streaming/channels') return xml(streamingChannels);
    if (p === '/ISAPI/ContentMgmt/InputProxy/channels/status') {
      // The DS-7604NI's status, with <online> false for each camera set offline
      return xml(channelStatus.replace(/(<id>(\d+)<\/id>[\s\S]*?<online>)true</g,
        (all, head, id) => (device.offlineChannels.includes(id) ? `${head}false<` : all)));
    }
    // Live frames, directly or through StreamingProxy (the DS-7604NI serves the same frame on both)
    const snapshot = p.match(/^\/ISAPI\/(?:Streaming|ContentMgmt\/StreamingProxy)\/channels\/(\d+)0[12]\/picture$/);
    if (snapshot) {
      opts.signal?.throwIfAborted();
      // What a disconnected camera's snapshot answers isn't verified; an empty channel's is this
      if (device.offlineChannels.includes(snapshot[1])) return xml(responseStatusXml(p, STATUS.serviceUnavailable), 503);
      device.inFlightSnapshots++;
      device.maxInFlightSnapshots = Math.max(device.maxInFlightSnapshots, device.inFlightSnapshots);
      // Like a real connection, an aborted request stops occupying the device
      // at once. Only while it's in flight: a signal can still fire after the
      // frame was sent (its time limit, or the feed stopping later).
      await new Promise((resolve, reject) => {
        const settle = () => {
          device.inFlightSnapshots--;
          opts.signal?.removeEventListener('abort', onAbort);
        };
        const timer = setTimeout(() => {
          settle();
          resolve();
        }, device.snapshotDelayMs);
        const onAbort = () => {
          clearTimeout(timer);
          settle();
          reject(opts.signal.reason);
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
      return new Response(await livePicture(snapshot[1], stillSizeFor(u.searchParams)), { status: 200 });
    }
    // Channel 2 is a camera that only supports the cell grid
    if (p.endsWith('/motionDetection/capabilities')) {
      return xml(p.includes('/channels/2/') ? motionCapabilities.replace('opt="grid,region"', 'opt="grid"') : motionCapabilities);
    }
    if (p.endsWith('/motionDetection/layout/capabilities')) return xml(motionLayoutCapabilities);
    if (p.endsWith('/motionDetection')) return xml(device.motionDocs[channelOf(p)] ?? motionDetection);
    if (p.endsWith('/privacyMask')) return xml(device.privacy.read(p));
    const trigger = p.match(/^\/ISAPI\/Event\/triggers\/VMD-(\d+)$/);
    if (trigger) return xml(device.triggers.read(trigger[1]));
    if (p === '/ISAPI/Event/triggersCap') return xml(triggersCap);
    if (p === '/ISAPI/System/IO/outputs/capabilities') return xml(ioOutputsCapabilities);
    if (p === '/ISAPI/System/IO/outputs') return xml(ioOutputs);
    if (p === '/ISAPI/Event/triggers/notifications/channels/whiteLightAlarm') return json(whiteLightAlarmChannels);
    if (p === '/ISAPI/Event/triggers/notifications/channels/AudioAlarm') return json(audioAlarmChannels);
    // The DS-7604NI answers any path it doesn't have like this, not with 404
    return xml(responseStatusXml(p, STATUS.notSupport), 403);
  };
  return device;
}
