/**
 * Browser tests for lib/xml.js, lib/config-xml.js and lib/isapi.js.
 * Results render on the page and are exposed as window.testResults.
 */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}

/** Fetch a fixture, or null when it doesn't exist (e.g. no local captures). */
async function fixture(path) {
  const resp = await fetch(`../fixtures/${path}`, { cache: 'no-store' });
  return resp.ok ? resp.text() : null;
}

/** Motion fixtures: the synthetic one plus any captured from a real device. */
async function motionFixtures() {
  const found = [['synthetic', await fixture('motionDetection.xml')]];
  for (let ch = 1; ch <= 4; ch++) {
    const xml = await fixture(`local/System_Video_inputs_channels_${ch}_motionDetection.xml`);
    if (xml) found.push([`device channel ${ch}`, xml]);
  }
  return found;
}

/**
 * The regex-based motion save this refactor replaces (v1.5.0). Its output
 * was verified against a real NVR, so the new DOM-based save must produce
 * the same XML.
 */
function legacyMotionSave(rawXml, { enabled, sensitivity, dynamicAnalysis, regions }) {
  let regionListXml = `<RegionList size="${regions.length}">`;
  regions.forEach((points, i) => {
    let coordsXml = '';
    points.forEach(p => {
      coordsXml += `<RegionCoordinates><positionX>${Math.round(p.x)}</positionX><positionY>${Math.round(p.y)}</positionY></RegionCoordinates>`;
    });
    regionListXml += `<Region xmlns=""><id>${i + 1}</id><RegionCoordinatesList>${coordsXml}</RegionCoordinatesList></Region>`;
  });
  regionListXml += '</RegionList>';

  let xml = rawXml;
  xml = xml.replace(/<enabled>[^<]*<\/enabled>/, `<enabled>${enabled}</enabled>`);
  xml = xml.replace(/<sensitivityLevel>[^<]*<\/sensitivityLevel>/, `<sensitivityLevel>${sensitivity}</sensitivityLevel>`);
  xml = xml.replace(/<regionType>[^<]*<\/regionType>/, '<regionType>region</regionType>');
  xml = xml.replace(/<gridMap>([^<]*)<\/gridMap>/, (_, hex) => `<gridMap>${'0'.repeat(hex.length)}</gridMap>`);
  xml = xml.replace(/<RegionList[^>]*>[\s\S]*?<\/RegionList>/, regionListXml);
  if (xml.includes('<enableDynamicAnalysis>')) {
    xml = xml.replace(/<enableDynamicAnalysis>[^<]*<\/enableDynamicAnalysis>/, `<enableDynamicAnalysis>${dynamicAnalysis}</enableDynamicAnalysis>`);
  }
  return xml;
}

/* ── xml.js ─────────────────────────────────────────────────────────────── */

test('serializeXml keeps the declaration and writes empty elements as pairs', () => {
  const doc = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<A xmlns="urn:x"><b xmlns=""></b><c/></A>');
  eq(serializeXml(doc), '<?xml version="1.0" encoding="UTF-8"?>\n<A xmlns="urn:x"><b xmlns=""></b><c></c></A>');
});

test('parseXml rejects malformed XML', () => {
  let threw = false;
  try { parseXml('<a><b></a>'); } catch { threw = true; }
  assert(threw, 'expected an error');
});

test('lookups ignore namespaces', () => {
  const root = parseXml('<A xmlns="urn:x"><B><c xmlns="">1</c></B></A>').documentElement;
  eq(childText(xmlPath(root, 'B'), 'c'), '1');
  eq(findDescendant(root, 'c').textContent, '1');
});

/* ── Motion detection ───────────────────────────────────────────────────── */

test('readMotionConfig reads the device document', async () => {
  const md = readMotionConfig(parseXml(await fixture('motionDetection.xml')));
  eq([md.enabled, md.sensitivity, md.dynamicAnalysis, md.detectHuman, md.detectVehicle],
    [true, 60, false, true, false]);
  eq(md.regions, [[{ x: 100, y: 900 }, { x: 600, y: 900 }, { x: 600, y: 300 }, { x: 100, y: 300 }]]);
});

/** Same document structure and text, ignoring attribute order. */
const canonical = xml => new XMLSerializer().serializeToString(parseXml(xml));
const regionListMarkup = xml => /<RegionList[\s\S]*?<\/RegionList>/.exec(xml)[0];

test('motion save matches the verified v1.5.0 output', async () => {
  const settings = {
    enabled: false,
    sensitivity: 75,
    dynamicAnalysis: true,
    regions: [
      [{ x: 10.4, y: 20.6 }, { x: 500, y: 20 }, { x: 250, y: 700 }],
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }],
    ],
  };
  for (const [label, xml] of await motionFixtures()) {
    const doc = parseXml(xml);
    applyMotionConfig(doc, settings);
    const actual = serializeXml(doc);
    const expected = legacyMotionSave(xml, settings);
    eq(canonical(actual), canonical(expected), `${label}: document`);
    // The region markup was tuned by hand against a real NVR — keep it byte-identical
    eq(regionListMarkup(actual), regionListMarkup(expected), `${label}: RegionList bytes`);
    assert(actual.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<MotionDetection'), `${label}: declaration`);
  }
});

test('motion save with no regions empties the list', async () => {
  const doc = parseXml(await fixture('motionDetection.xml'));
  applyMotionConfig(doc, { enabled: true, sensitivity: 50, dynamicAnalysis: false, regions: [] });
  assert(serializeXml(doc).includes('<RegionList size="0"></RegionList>'));
});

/* ── Privacy mask ───────────────────────────────────────────────────────── */

test('readPrivacyMask returns only enabled regions', async () => {
  const pm = readPrivacyMask(parseXml(await fixture('privacyMask.xml')));
  eq(pm.enabled, true);
  eq(pm.regions.length, 1);
  eq(pm.regions[0][2], { x: 110, y: 120 });
});

test('privacy save fills existing slots and keeps device fields', async () => {
  const doc = parseXml(await fixture('privacyMask.xml'));
  applyPrivacyMask(doc, { enabled: true, rects: [{ x1: 1, y1: 2, x2: 3, y2: 4 }, { x1: 5, y1: 6, x2: 7, y2: 8 }] });
  const regions = childElements(privacyRegionList(doc), 'PrivacyMaskRegion');
  eq(regions.map(r => [childText(r, 'id'), childText(r, 'enabled'), childText(r, 'maskType')]),
    [['1', 'true', 'gray'], ['2', 'true', 'gray']]);
  eq(readPrivacyMask(doc).regions[1], [{ x: 5, y: 6 }, { x: 7, y: 6 }, { x: 7, y: 8 }, { x: 5, y: 8 }]);
  assert(serializeXml(doc).includes('<normalizedScreenWidth>704</normalizedScreenWidth>'), 'unrelated fields kept');
});

test('privacy save disables unused slots instead of deleting them', async () => {
  const doc = parseXml(await fixture('privacyMask.xml'));
  applyPrivacyMask(doc, { enabled: false, rects: [] });
  const regions = childElements(privacyRegionList(doc), 'PrivacyMaskRegion');
  eq(regions.map(r => childText(r, 'enabled')), ['false', 'false']);
  eq(childText(doc.documentElement, 'enabled'), 'false');
});

test('privacy save adds slots when the device has too few', async () => {
  const doc = parseXml(await fixture('privacyMask.xml'));
  const rect = { x1: 0, y1: 0, x2: 10, y2: 10 };
  applyPrivacyMask(doc, { enabled: true, rects: [rect, rect, rect] });
  const regions = childElements(privacyRegionList(doc), 'PrivacyMaskRegion');
  eq(regions.map(r => childText(r, 'id')), ['1', '2', '3']);
  assert(!serializeXml(doc).includes('xmlns=""'), 'new slots use the document namespace');
});

/* ── Event triggers ─────────────────────────────────────────────────────── */

const MANAGED = ['record', 'center', 'email', 'beep', 'IO', 'whiteLight', 'audio'];

test('readNotificationMethods lists every method', async () => {
  eq([...readNotificationMethods(parseXml(await fixture('eventTrigger.xml')))], ['record', 'IO', 'FTP']);
});

test('event save keeps unmanaged methods and existing settings', async () => {
  const doc = parseXml(await fixture('eventTrigger.xml'));
  applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['IO', 'center']), channelId: '1' });
  const byMethod = Object.fromEntries(triggerNotifications(doc).map(n => [childText(n, 'notificationMethod'), n]));
  eq(Object.keys(byMethod).sort(), ['FTP', 'IO', 'center']);
  eq(childText(byMethod.IO, 'outputIOPortID'), '2', 'existing IO port kept');
  eq(childText(byMethod.IO, 'id'), 'IO-2');
  eq(childText(doc.documentElement, 'dynVideoInputChannelID'), '1', 'unrelated fields kept');
});

test('event save adds a record entry for the channel', async () => {
  const doc = parseXml(await fixture('eventTrigger.xml'));
  applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(), channelId: '3' });
  applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['record']), channelId: '3' });
  const rec = triggerNotifications(doc).find(n => childText(n, 'notificationMethod') === 'record');
  eq([childText(rec, 'videoInputID'), childText(rec, 'dynVideoInputID')], ['3', '3']);
  eq([...readNotificationMethods(doc)], ['FTP', 'record']);
});

test('NVR trigger: new record entry uses dyn fields and device-style id', async () => {
  const doc = parseXml(await fixture('eventTrigger-nvr.xml'));
  applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['center']), channelId: '1' });
  eq([...readNotificationMethods(doc)], ['center'], 'record removed');
  applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['center', 'record', 'IO']), channelId: '1' });
  const rec = triggerNotifications(doc).find(n => childText(n, 'notificationMethod') === 'record');
  eq([childText(rec, 'id'), childText(rec, 'dynVideoInputID'), childText(rec, 'videoInputID')], ['record-1', '1', null]);
  const io = triggerNotifications(doc).find(n => childText(n, 'notificationMethod') === 'IO');
  eq(childText(io, 'id'), 'IO-1');
});

test('NVR privacy mask: declared screen size, first region added to an empty list', async () => {
  const doc = parseXml(await fixture('privacyMask-nvr.xml'));
  eq(readPrivacyMask(doc).screen, { width: 704, height: 576 });
  applyPrivacyMask(doc, { enabled: true, rects: [{ x1: 10, y1: 20, x2: 300, y2: 200 }] });
  const pm = readPrivacyMask(doc);
  eq([pm.enabled, pm.regions.length], [true, 1]);
  eq(pm.regions[0][2], { x: 300, y: 200 });
});

test('motion target read from layout targetType', () => {
  const doc = parseXml('<MotionDetection xmlns="urn:x"><enabled>true</enabled><MotionDetectionLayout>' +
    '<sensitivityLevel>40</sensitivityLevel><targetType>human,vehicle</targetType></MotionDetectionLayout></MotionDetection>');
  const md = readMotionConfig(doc);
  eq([md.detectHuman, md.detectVehicle], [true, true]);
});

/* ── isapi.js (mocked network) ──────────────────────────────────────────── */

/** Replace fetch with a router keyed by path; unknown paths return 404. */
function mockFetch(routes) {
  const calls = [];
  const original = window.fetch;
  window.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const r = routes[path];
    if (!r) return new Response('', { status: 404 });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { calls, restore: () => { window.fetch = original; } };
}
let configSeq = 0;
const testConfig = () => ({ host: '10.9.9.9', port: 80, username: `user${++configSeq}`, password: 'pw' });

test('getEventTrigger falls back to the trigger list and isolates one trigger', async () => {
  const ns = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"';
  const mock = mockFetch({
    '/ISAPI/Event/triggers': { body: `<EventTriggerList ${ns}>` +
      `<EventTrigger><id>VMD-1</id><eventType>VMD</eventType><videoInputChannelID>1</videoInputChannelID></EventTrigger>` +
      `<EventTrigger><id>VMD-2</id><eventType>VMD</eventType><videoInputChannelID>2</videoInputChannelID></EventTrigger>` +
      `</EventTriggerList>` },
  });
  try {
    const doc = await Isapi.getEventTrigger(testConfig(), '2');
    eq(doc.documentElement.localName, 'EventTrigger');
    eq(childText(doc.documentElement, 'id'), 'VMD-2');
    assert(serializeXml(doc).includes(`<EventTrigger ${ns}>`), 'keeps the namespace');
  } finally { mock.restore(); }
});

test('getChannels de-duplicates streaming channels', async () => {
  const mock = mockFetch({
    '/ISAPI/Streaming/channels': { body: '<StreamingChannelList>' +
      '<StreamingChannel><id>101</id><channelName>Front</channelName></StreamingChannel>' +
      '<StreamingChannel><id>102</id><channelName>Front</channelName></StreamingChannel>' +
      '<StreamingChannel><id>201</id></StreamingChannel></StreamingChannelList>' },
  });
  try {
    eq(await Isapi.getChannels(testConfig()), [{ id: '1', name: 'Front' }, { id: '2', name: '' }]);
  } finally { mock.restore(); }
});

test('auth failure stops endpoint fallbacks and fires the hook once', async () => {
  const challenge = { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n", qop="auth"' } };
  const mock = mockFetch({
    '/ISAPI/System/Video/inputs/channels': challenge,
    '/ISAPI/ContentMgmt/InputProxy/channels': challenge,
  });
  let hookCalls = 0;
  Isapi.onAuthFailure = () => hookCalls++;
  try {
    let error;
    try { await Isapi.getChannels(testConfig()); } catch (err) { error = err; }
    assert(error instanceof AuthError, 'expected AuthError');
    eq(hookCalls, 1);
    eq(mock.calls, ['/ISAPI/System/Video/inputs/channels', '/ISAPI/System/Video/inputs/channels']);
  } finally { mock.restore(); Isapi.onAuthFailure = null; }
});

test('getSnapshot returns a JPEG blob', async () => {
  const mock = mockFetch({ '/ISAPI/Streaming/channels/101/picture': { body: new Uint8Array([0xff, 0xd8, 0xff]) } });
  try {
    const blob = await Isapi.getSnapshot(testConfig(), '1');
    eq([blob.type, blob.size], ['image/jpeg', 3]);
  } finally { mock.restore(); }
});

/* ── Runner ─────────────────────────────────────────────────────────────── */

(async () => {
  const out = document.getElementById('out');
  const results = [];
  for (const t of tests) {
    const row = document.createElement('div');
    try {
      await t.fn();
      row.className = 'pass';
      row.textContent = `✓ ${t.name}`;
      results.push({ name: t.name, ok: true });
    } catch (err) {
      row.className = 'fail';
      row.textContent = `✗ ${t.name}\n  ${err.message}`;
      results.push({ name: t.name, ok: false, error: err.message });
    }
    out.appendChild(row);
  }
  const failed = results.filter(r => !r.ok).length;
  const fixtures = (await motionFixtures()).map(([label]) => label).join(', ');
  document.getElementById('summary').textContent =
    `${results.length - failed}/${results.length} passed — motion fixtures: ${fixtures}`;
  window.testResults = { results, failed };
})();
