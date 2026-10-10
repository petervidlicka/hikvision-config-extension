/**
 * A fake Hikvision NVR behind fetch(), plus stubbed chrome.* APIs, for
 * running the real config page outside the extension. Mirrors the NVR this
 * extension was developed against: four IP cameras (analog channel list
 * returns 403 notSupport), configs via InputProxy, polygon motion regions,
 * privacy masks and event triggers stored the way the NVR stores them, the
 * cameras on channels 3 and 4 with a relay, white light and speaker,
 * errors and write results as <ResponseStatus> bodies, the userCheck
 * login check, and which cameras are online.
 *
 * Used by tests/browser/app.test.js and the manual harness in tests/harness/.
 */
import motionDetection from '../fixtures/motionDetection-nvr.xml?raw';
import motionCapabilities from '../fixtures/motionCapabilities-nvr.xml?raw';
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

/** What the DS-7604NI answers for a resource it doesn't have, or a write that succeeded. */
export const STATUS = {
  notSupport: { statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'notSupport' },
  ok: { statusCode: 1, statusString: 'OK', subStatusCode: 'ok' },
};

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

/** A small JPEG frame that changes every call. */
async function frame() {
  const canvas = new OffscreenCanvas(320, 180);
  const g = canvas.getContext('2d');
  g.fillStyle = `hsl(${(Date.now() / 20) % 360} 60% 40%)`;
  g.fillRect(0, 0, 320, 180);
  return canvas.convertToBlob({ type: 'image/jpeg' });
}

/** Today's recordings: continuous 08:00–08:30, a manual one at 10:00 and a motion event at 14:05. */
function todaysRecordings() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /** @param {string} start @param {string} end @param {string} type */
  const item = (start, end, type) => `<searchMatchItem><trackID>101</trackID>
    <timeSpan><startTime>${day}T${start}Z</startTime><endTime>${day}T${end}Z</endTime></timeSpan>
    <mediaSegmentDescriptor><playbackURI>rtsp://${NVR_HOST}/Streaming/tracks/101/?name=${start}</playbackURI></mediaSegmentDescriptor>
    <metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/${type}</metadataDescriptor></metadataMatches></searchMatchItem>`;
  return `<CMSearchResult><responseStatusStrg>OK</responseStatusStrg><numOfMatches>3</numOfMatches><matchList>
    ${item('08:00:00', '08:30:00', 'CMR')}${item('10:00:00', '10:05:00', 'manual')}${item('14:05:10', '14:06:40', 'VideoMotion')}</matchList></CMSearchResult>`;
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
 * wrong IP address, `rejectAuth` answers every request with a 401 like a
 * password changed on the device (each with a fresh nonce, like V4.75;
 * `failedLogins` counts the ones that carried credentials), `loginLock`
 * makes a rejected userCheck say the device has locked this computer out or
 * how many attempts are left, `failures` answers "METHOD /path" with an error status
 * (only the first `times` requests, when set), `holds` keeps "METHOD /path"
 * unanswered until its promise settles, `writeStatus` changes what a
 * successful PUT or DELETE reports (e.g. statusCode 7, reboot required), and
 * `offlineChannels` lists the cameras the NVR's status reports disconnected
 * (e.g. ['4']). `privacy.read(path)` shows the privacy masks a channel stores,
 * `triggers.read(channel)` its motion trigger.
 * @param {{snapshotDelayMs?: number, realFetch?: typeof fetch}} [options]
 */
export function createMockNvr({ snapshotDelayMs = 50, realFetch = fetch } = {}) {
  const device = {
    requests: [], puts: [], deletes: [], inFlightSnapshots: 0, maxInFlightSnapshots: 0, rejectAuth: false,
    unreachable: false, failedLogins: 0, noncesIssued: 0,
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
    /** How picture?starttime= behaves: real stills, the live image whatever the time (like the DS-7604), or no image */
    recordedFrames: /** @type {'real'|'ignoresTime'|'none'} */ ('real'),
  };
  const xml = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/xml; charset="UTF-8"' } });
  const json = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset="UTF-8"' } });

  device.fetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    if (u.hostname !== NVR_HOST) return realFetch(url, opts);
    const method = opts.method || 'GET';
    const p = u.pathname;
    device.requests.push(`${method} ${p}`);
    // Awaited only when set, so other requests reach the device in the same tick as before
    const hold = device.holds[`${method} ${p}`];
    if (hold) await hold;
    if (device.unreachable) throw new TypeError('Failed to fetch');
    if (device.rejectAuth) {
      const credentialed = new Headers(opts.headers).has('Authorization');
      if (credentialed) device.failedLogins++;
      const explained = credentialed && device.loginLock && p === '/ISAPI/Security/userCheck';
      return new Response(explained ? userCheckRejectedXml(device.loginLock) : UNAUTHORIZED_HTML, {
        status: 401,
        headers: {
          'Content-Type': explained ? 'application/xml' : 'text/html',
          'WWW-Authenticate': `Digest realm="r", qop="auth", nonce="n${++device.noncesIssued}", stale="FALSE"`,
        },
      });
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
    if (p === '/ISAPI/Security/userCheck') return xml(userCheck);
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
    if (p === '/ISAPI/ContentMgmt/InputProxy/channels/status') {
      // The DS-7604NI's status, with <online> false for each camera set offline
      return xml(channelStatus.replace(/(<id>(\d+)<\/id>[\s\S]*?<online>)true</g,
        (all, head, id) => (device.offlineChannels.includes(id) ? `${head}false<` : all)));
    }
    if (/^\/ISAPI\/Streaming\/channels\/\d+0[12]\/picture$/.test(p)) {
      opts.signal?.throwIfAborted();
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
        }, snapshotDelayMs);
        const onAbort = () => {
          clearTimeout(timer);
          settle();
          reject(opts.signal.reason);
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
      return new Response(await frame(), { status: 200 });
    }
    // Channel 2 is a camera that only supports the cell grid
    if (p.endsWith('/motionDetection/capabilities')) {
      return xml(p.includes('/channels/2/') ? motionCapabilities.replace('opt="grid,region"', 'opt="grid"') : motionCapabilities);
    }
    if (p.endsWith('/motionDetection')) return xml(motionDetection);
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
