/**
 * Reading and editing the device config documents behind each tool.
 */
import { describe, expect, it } from 'vitest';
import { childElements, childText, parseXml, serializeXml } from '../../extension/lib/xml.js';
import {
  DEFAULT_PRIVACY_SCREEN, alarmOutputNotification, applyMotionConfig, applyNotifications, canvasRectToPrivacy, decodeGridMap,
  encodeGridMap, applyPrivacyMask, hasNotification, lightAudioNotification, methodNotification, privacyRegionList,
  privacyRegionToCanvas, readAlarmOutputs, readLightAudioChannels, readMotionCapabilities, readMotionConfig,
  readMotionTriggerCap, readNotificationMethods, readPrivacyMask, recordNotification, resolveEventActions, triggerNotifications,
} from '../../extension/lib/config-xml.js';
import { fixtures, motionFixtures } from './fixtures.js';

/**
 * The regex-based motion save from v1.5.0. Its output was verified against
 * a real NVR, so the DOM-based save must produce the same document.
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

/** Same document structure and text, ignoring attribute order. */
const canonical = (xml) => new XMLSerializer().serializeToString(parseXml(xml));
const regionListMarkup = (xml) => /<RegionList[\s\S]*?<\/RegionList>/.exec(xml)[0];

describe('motion detection', () => {
  it('reads the device document', () => {
    const md = readMotionConfig(parseXml(fixtures.motionDetection));
    expect([md.enabled, md.sensitivity, md.dynamicAnalysis, md.detectHuman, md.detectVehicle])
      .toEqual([true, 60, false, true, false]);
    expect(md.regions).toEqual([[{ x: 100, y: 900 }, { x: 600, y: 900 }, { x: 600, y: 300 }, { x: 100, y: 300 }]]);
  });

  it('reads the target from layout targetType', () => {
    const doc = parseXml('<MotionDetection xmlns="urn:x"><enabled>true</enabled><MotionDetectionLayout>' +
      '<sensitivityLevel>40</sensitivityLevel><targetType>human,vehicle</targetType></MotionDetectionLayout></MotionDetection>');
    expect(readMotionConfig(doc).targetTypes).toEqual(['human', 'vehicle']);
  });

  it.each(motionFixtures)('save matches the verified v1.5.0 output (%s)', (label, xml) => {
    const settings = {
      enabled: false,
      sensitivity: 75,
      dynamicAnalysis: true,
      regions: [
        [{ x: 10.4, y: 20.6 }, { x: 500, y: 20 }, { x: 250, y: 700 }],
        [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }],
      ],
    };
    const doc = parseXml(xml);
    applyMotionConfig(doc, settings);
    const actual = serializeXml(doc);
    const expected = legacyMotionSave(xml, settings);
    expect(canonical(actual)).toBe(canonical(expected));
    // The region markup was tuned by hand against a real NVR — keep it byte-identical
    expect(regionListMarkup(actual)).toBe(regionListMarkup(expected));
    expect(actual.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<MotionDetection')).toBe(true);
  });

  it('empties the region list when there are no regions', () => {
    const doc = parseXml(fixtures.motionDetection);
    applyMotionConfig(doc, { enabled: true, sensitivity: 50, dynamicAnalysis: false, regions: [] });
    expect(serializeXml(doc)).toContain('<RegionList size="0"></RegionList>');
  });

  it('writes the detection target list', () => {
    const base = { enabled: true, sensitivity: 40, dynamicAnalysis: false, regions: [] };
    const doc = parseXml(fixtures.motionDetection);
    applyMotionConfig(doc, { ...base, targetTypes: ['human', 'vehicle'] });
    expect(readMotionConfig(doc).targetTypes).toEqual(['human', 'vehicle']);
    expect(serializeXml(doc)).toContain('<targetType xmlns="">human,vehicle</targetType>');
    applyMotionConfig(doc, { ...base, targetTypes: [] });
    expect(serializeXml(doc)).toContain('<targetType xmlns=""></targetType>');
  });

  it('creates targetType like the Hikvision client when missing', () => {
    const doc = parseXml('<MotionDetection xmlns="urn:x"><enabled>true</enabled><MotionDetectionLayout>' +
      '<sensitivityLevel>40</sensitivityLevel><layout><RegionList></RegionList></layout></MotionDetectionLayout></MotionDetection>');
    applyMotionConfig(doc, { enabled: true, sensitivity: 40, dynamicAnalysis: false, regions: [], targetTypes: ['human'] });
    expect(serializeXml(doc)).toContain('</layout><targetType xmlns="">human</targetType></MotionDetectionLayout>');
  });

  it('reads NVR capabilities, with defaults when there are none', () => {
    expect(readMotionCapabilities(parseXml(fixtures.motionCapabilitiesNvr))).toEqual({
      regionTypes: ['grid', 'region'],
      maxRegions: 4,
      minPoints: 4,
      maxPoints: 10,
      sensitivity: { min: 0, max: 100, step: 20 },
      targetTypes: ['human', 'vehicle'],
    });
    expect(readMotionCapabilities(null).maxRegions).toBe(4);
  });
});

describe('motion grid (grid-only cameras)', () => {
  // The device's own map from channel 1 (see docs/isapi-notes.md): 18 rows × 22 columns
  const deviceMap = '0000000000000000000000000000000003c00003e00007f80007f80007f80003f80001f80001f00000f0000070000020000000000000';

  it('decodes rows top-first and columns most-significant-bit first', () => {
    const cells = decodeGridMap(deviceMap, 18, 22);
    expect(cells).toHaveLength(18);
    expect(cells[5].map(Number).join('')).toBe('0000000000000011110000'); // 03c000
    expect(cells[15][18]).toBe(true); // 000020 → column 18
    expect(cells.flat().filter(Boolean)).toHaveLength(59);
  });

  it('encodes back to the same map', () => {
    expect(encodeGridMap(decodeGridMap(deviceMap, 18, 22), 22)).toBe(deviceMap);
  });

  it('reads the grid and dynamic-analysis support from the config', () => {
    const md = readMotionConfig(parseXml(fixtures.motionDetection));
    expect([md.regionType, md.grid?.rows, md.grid?.cols, md.supportsDynamicAnalysis]).toEqual(['grid', 18, 22, true]);
    const nvr = readMotionConfig(parseXml(fixtures.motionDetection.replace(/<enableDynamicAnalysis>[^<]*<\/enableDynamicAnalysis>/, '')));
    expect(nvr.supportsDynamicAnalysis).toBe(false);
  });

  it('saves only the grid in grid mode', () => {
    const doc = parseXml(fixtures.motionDetection);
    const before = readMotionConfig(doc);
    const cells = before.grid.cells.map(row => row.map(() => false));
    cells[0][0] = true;
    applyMotionConfig(doc, { mode: 'grid', grid: { ...before.grid, cells }, enabled: true, sensitivity: 40, dynamicAnalysis: false, regions: [] });
    const after = readMotionConfig(doc);
    expect(serializeXml(doc)).toContain('<gridMap>800000' + '0'.repeat(102) + '</gridMap>');
    expect(after.regionType).toBe('grid');
    expect(after.regions).toEqual(before.regions); // region list untouched
  });
});

describe('privacy mask', () => {
  /** [id, enabled, maskType] of each region in the document */
  const slotsOf = (doc) => childElements(privacyRegionList(doc), 'PrivacyMaskRegion')
    .map(r => [childText(r, 'id'), childText(r, 'enabled'), childText(r, 'maskType')]);

  it('shows every stored region with an area, whatever its own enabled flag', () => {
    // The NVR reads every region back with enabled=false, yet masks it
    const nvr = readPrivacyMask(parseXml(fixtures.privacyMaskNvrRegions));
    expect(nvr.enabled).toBe(true);
    expect(nvr.regions).toHaveLength(2);
    expect(nvr.regions[0]).toContainEqual({ x: 176, y: 432 });

    // An unused slot (no coordinates) isn't a mask
    const camera = readPrivacyMask(parseXml(fixtures.privacyMask));
    expect(camera.regions).toHaveLength(1);
    expect(camera.regions[0][2]).toEqual({ x: 110, y: 120 });
  });

  it('skips zero-area regions and reads a bare region list’s switch from its regions', () => {
    const ns = 'xmlns="http://www.isapi.org/ver20/XMLSchema"';
    const region = (id, enabled, points) => `<PrivacyMaskRegion><id>${id}</id><enabled>${enabled}</enabled><RegionCoordinatesList>${
      points.map(([x, y]) => `<RegionCoordinates><positionX>${x}</positionX><positionY>${y}</positionY></RegionCoordinates>`).join('')
    }</RegionCoordinatesList></PrivacyMaskRegion>`;
    const list = (...regions) => parseXml(`<PrivacyMaskRegionList ${ns}>${regions.join('')}</PrivacyMaskRegionList>`);

    const flat = readPrivacyMask(list(region(1, 'true', [[0, 0], [0, 0], [0, 0]]), region(2, 'false', [[10, 10], [90, 10], [90, 10]])));
    expect([flat.enabled, flat.regions]).toEqual([true, []]);
    expect(readPrivacyMask(list(region(1, 'false', [[0, 0], [50, 50]]))).enabled).toBe(false);
  });

  it('rebuilds the list with exactly the new rectangles, as the web UI does', () => {
    const doc = parseXml(fixtures.privacyMaskNvrRegions);
    applyPrivacyMask(doc, { enabled: true, rects: [{ x1: 0, y1: 576, x2: 704, y2: 432 }] });
    expect(slotsOf(doc)).toEqual([['1', 'true', null]]);
    const body = serializeXml(doc);
    expect(body).toMatch(new RegExp('<PrivacyMaskRegionList[^>]*><PrivacyMaskRegion><id>1</id><enabled>true</enabled>' +
      '<RegionCoordinatesList><RegionCoordinates><positionX>0</positionX><positionY>576</positionY></RegionCoordinates>'));
    expect(body).toContain('<normalizedScreenWidth>704</normalizedScreenWidth>');
    expect(readPrivacyMask(doc).regions).toEqual([[{ x: 0, y: 576 }, { x: 704, y: 576 }, { x: 704, y: 432 }, { x: 0, y: 432 }]]);
  });

  it('writes the global switch into every region and keeps fields like maskType', () => {
    const doc = parseXml(fixtures.privacyMask);
    const rect = { x1: 1, y1: 2, x2: 3, y2: 4 };
    applyPrivacyMask(doc, { enabled: false, rects: [rect, rect, rect] });
    expect(slotsOf(doc)).toEqual([['1', 'false', 'gray'], ['2', 'false', 'gray'], ['3', 'false', null]]);
    expect(childText(doc.documentElement, 'enabled')).toBe('false');
    expect(serializeXml(doc)).not.toContain('xmlns=""');

    applyPrivacyMask(doc, { enabled: true, rects: [] });
    expect(slotsOf(doc)).toEqual([]);
  });

  it('can disable and empty unused slots instead, for firmware that can’t delete regions', () => {
    const doc = parseXml(fixtures.privacyMaskNvrRegions);
    applyPrivacyMask(doc, { enabled: true, rects: [{ x1: 5, y1: 6, x2: 7, y2: 8 }], unused: 'disable' });
    expect(slotsOf(doc)).toEqual([['1', 'true', null], ['2', 'false', null]]);
    const regions = childElements(privacyRegionList(doc), 'PrivacyMaskRegion');
    expect(childElements(childElements(regions[1], 'RegionCoordinatesList')[0], 'RegionCoordinates')).toHaveLength(0);
    // A disabled slot keeps no stale coordinates, so it can't reappear as a mask
    expect(readPrivacyMask(doc).regions).toEqual([[{ x: 5, y: 6 }, { x: 7, y: 6 }, { x: 7, y: 8 }, { x: 5, y: 8 }]]);
  });

  it('uses the NVR’s declared screen size and fills an empty list', () => {
    const doc = parseXml(fixtures.privacyMaskNvr);
    expect(readPrivacyMask(doc).screen).toEqual({ width: 704, height: 576 });
    applyPrivacyMask(doc, { enabled: true, rects: [{ x1: 10, y1: 20, x2: 300, y2: 200 }] });
    const pm = readPrivacyMask(doc);
    expect([pm.enabled, pm.regions.length]).toEqual([true, 1]);
    expect(pm.regions[0][2]).toEqual({ x: 300, y: 200 });
  });
});

describe('privacy mask coordinates', () => {
  const screen = DEFAULT_PRIVACY_SCREEN;
  const canvas = { width: 640, height: 360 };

  it('measures Y from the bottom: a region at positionY 432–576 is the top quarter', () => {
    const top = [{ x: 0, y: 576 }, { x: 704, y: 576 }, { x: 704, y: 432 }, { x: 0, y: 432 }];
    expect(privacyRegionToCanvas(top, screen, canvas)).toEqual({ x: 0, y: 0, w: 640, h: 90 });

    // The NVR fixture: region 1 top-left, region 2 bottom-right
    const [topLeft, bottomRight] = readPrivacyMask(parseXml(fixtures.privacyMaskNvrRegions)).regions;
    expect(privacyRegionToCanvas(topLeft, screen, canvas)).toEqual({ x: 0, y: 0, w: 160, h: 90 });
    expect(privacyRegionToCanvas(bottomRight, screen, canvas)).toEqual({ x: 480, y: 270, w: 160, h: 90 });
  });

  it('saves a rectangle at the top of the canvas near positionY = screen height', () => {
    expect(canvasRectToPrivacy({ x: 64, y: 0, w: 320, h: 36 }, screen, canvas))
      .toEqual({ x1: 70, y1: 576, x2: 422, y2: 518 });
    expect(canvasRectToPrivacy({ x: 0, y: 324, w: 640, h: 36 }, screen, canvas))
      .toEqual({ x1: 0, y1: 58, x2: 704, y2: 0 });
  });

  it('round-trips, rounding to whole units and clamping to the screen', () => {
    const rect = { x: 100, y: 50, w: 200, h: 120 };
    const device = canvasRectToPrivacy(rect, screen, canvas);
    expect(Object.values(device).every(Number.isInteger)).toBe(true);
    const corners = [{ x: device.x1, y: device.y1 }, { x: device.x2, y: device.y2 }];
    const back = privacyRegionToCanvas(corners, screen, canvas);
    for (const key of ['x', 'y', 'w', 'h']) expect(back[key]).toBeCloseTo(rect[key], 0);

    // Dragged past the edges of the image
    expect(canvasRectToPrivacy({ x: -20, y: -10, w: 700, h: 400 }, screen, canvas)).toEqual({ x1: 0, y1: 576, x2: 704, y2: 0 });
    expect(privacyRegionToCanvas([{ x: -50, y: 700 }, { x: 900, y: -5 }], screen, canvas)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });
});

/** Each notification entry as "field=value …", in document order. */
const entriesOf = (doc) => triggerNotifications(doc).map(n =>
  Array.from(n.children, c => `${c.localName}=${c.textContent}`).join(' '));

describe('event trigger notifications', () => {
  const methodsOf = (doc) => [...readNotificationMethods(doc)];

  it('lists every method', () => {
    expect(methodsOf(parseXml(fixtures.eventTrigger))).toEqual(['record', 'IO', 'FTP']);
  });

  it('keeps unmanaged methods, other ports and existing settings', () => {
    const doc = parseXml(fixtures.eventTrigger);
    applyNotifications(doc, [
      { spec: recordNotification(doc, '1'), enabled: false },
      { spec: alarmOutputNotification({ port: '1', field: 'outputIOPortID' }), enabled: false },
      { spec: methodNotification('center'), enabled: true },
    ]);
    // Turning port 1 off leaves port 2's entry, which the user set up elsewhere
    expect(entriesOf(doc)).toEqual([
      'id=IO-2 notificationMethod=IO notificationRecurrence=beginning outputIOPortID=2',
      'id=FTP notificationMethod=FTP notificationRecurrence=beginning',
      'id=center notificationMethod=center notificationRecurrence=beginning',
    ]);
    expect(childText(doc.documentElement, 'dynVideoInputChannelID')).toBe('1');
  });

  it('gives new entries notificationRecurrence only where the trigger’s own entries have it', () => {
    // Camera-style trigger: every entry has it, so new ones copy it
    const camera = parseXml(fixtures.eventTrigger);
    applyNotifications(camera, [{ spec: methodNotification('email'), enabled: true }]);
    expect(entriesOf(camera).at(-1)).toBe('id=email notificationMethod=email notificationRecurrence=beginning');

    // The DS-7604NI stores none (and drops it on save): new entries look like its web UI's
    const nvr = parseXml(fixtures.eventTriggerNvrVmd3);
    const record = recordNotification(nvr, '3');
    applyNotifications(nvr, [{ spec: record, enabled: false }]);
    applyNotifications(nvr, [{ spec: record, enabled: true }]);
    expect(entriesOf(nvr)).toEqual([
      'id=center notificationMethod=center',
      'id=record-3 notificationMethod=record dynVideoInputID=3',
    ]);
  });

  it('addresses a new record entry the way the trigger does', () => {
    const doc = parseXml(fixtures.eventTrigger);
    const record = recordNotification(doc, '3');
    applyNotifications(doc, [{ spec: record, enabled: true }]);
    const rec = triggerNotifications(doc).find(n => childText(n, 'id') === 'record-3');
    expect([childText(rec, 'videoInputID'), childText(rec, 'dynVideoInputID')]).toEqual(['3', '3']);
  });

  it('records per channel: another channel’s record link neither reads as on nor gets removed', () => {
    const ns = 'xmlns="http://www.isapi.org/ver20/XMLSchema"';
    const doc = parseXml(`<EventTrigger ${ns}><id>VMD-1</id><eventType>VMD</eventType>` +
      '<dynVideoInputChannelID>1</dynVideoInputChannelID><EventTriggerNotificationList>' +
      '<EventTriggerNotification><id>record-2</id><notificationMethod>record</notificationMethod>' +
      '<dynVideoInputID>2</dynVideoInputID></EventTriggerNotification></EventTriggerNotificationList></EventTrigger>');
    const own = recordNotification(doc, '1');
    expect(hasNotification(doc, own)).toBe(false);

    applyNotifications(doc, [{ spec: own, enabled: true }]);
    expect(entriesOf(doc)).toEqual([
      'id=record-2 notificationMethod=record dynVideoInputID=2',
      'id=record-1 notificationMethod=record dynVideoInputID=1',
    ]);
    expect(hasNotification(doc, own)).toBe(true);

    applyNotifications(doc, [{ spec: own, enabled: false }]);
    expect(entriesOf(doc)).toEqual(['id=record-2 notificationMethod=record dynVideoInputID=2']);
  });

  it('switches only its own alarm output port', () => {
    const doc = parseXml(fixtures.eventTriggerNvrVmd3Io301);
    const port301 = alarmOutputNotification({ port: '301', field: 'dynOutputIOPortID' });
    const port401 = alarmOutputNotification({ port: '401', field: 'dynOutputIOPortID' });
    expect([hasNotification(doc, port301), hasNotification(doc, port401)]).toEqual([true, false]);

    applyNotifications(doc, [{ spec: port301, enabled: false }, { spec: port401, enabled: true }]);
    expect(entriesOf(doc)).toEqual([
      'id=record-3 notificationMethod=record dynVideoInputID=3',
      'id=center notificationMethod=center',
      'id=IO-401 notificationMethod=IO dynOutputIOPortID=401',
    ]);
  });

  it('reads the NVR’s light and speaker entries per channel', () => {
    const doc = parseXml(fixtures.eventTriggerNvrVmd3WhiteLight); // as the NVR stored its web UI's linkage
    expect(hasNotification(doc, lightAudioNotification('whiteLightOut', '3'))).toBe(true);
    expect(hasNotification(doc, lightAudioNotification('whiteLightOut', '4'))).toBe(false);
    expect(hasNotification(doc, lightAudioNotification('audioOut', '3'))).toBe(false);
  });
});

describe('event actions a device and channel offer', () => {
  /** What the DS-7604NI offers, from its captured answers. */
  const nvrSupport = () => ({
    triggerCap: readMotionTriggerCap(parseXml(fixtures.triggersCapNvr)),
    alarmOutputs: readAlarmOutputs(parseXml(fixtures.ioOutputsNvr), null),
    whiteLightChannels: readLightAudioChannels(JSON.parse(fixtures.whiteLightAlarmChannelsNvr), 'WhiteLightAlarmList'),
    audioChannels: readLightAudioChannels(JSON.parse(fixtures.audioAlarmChannelsNvr), 'AudioAlarmList'),
  });
  const reasons = (actions) => Object.fromEntries(Object.entries(actions).map(([key, a]) => [key, a.unavailable]));

  it('reads the motion flags of triggersCap, and nothing when it has none', () => {
    expect(readMotionTriggerCap(parseXml(fixtures.triggersCapNvr))).toEqual({
      isSupportCenter: true, isSupportRecord: true, isSupportMonitorAlarm: true, isSupportBeep: true,
      isSupportIO: true, isSupportEmail: true, isSupportAudioOut: true, isSupportWhiteLightOut: true,
    });
    const otherEventsOnly = '<EventTriggersCap><IOTriggerCap><isSupportIO>true</isSupportIO></IOTriggerCap></EventTriggersCap>';
    expect(readMotionTriggerCap(parseXml(otherEventsOnly))).toBeNull();
    expect(readMotionTriggerCap(null)).toBeNull();
  });

  it('lists the cameras’ relays, without the light and speaker pseudo outputs', () => {
    const relays = [
      { id: '301', type: 'digital', ipAddress: '192.168.254.4' },
      { id: '401', type: 'digital', ipAddress: '192.168.254.3' },
    ];
    expect(readAlarmOutputs(parseXml(fixtures.ioOutputsNvr), null)).toEqual(relays);
    expect(readAlarmOutputs(parseXml(fixtures.ioProxyOutputsNvr), 'digital')).toEqual(relays);

    // A camera's own relay has no IOType; a switched-off analog output is left out
    const own = '<IOOutputPortList><IOOutputPort><id>1</id></IOOutputPort>' +
      '<IOOutputPort><id>9</id><IOUseType>disable</IOUseType><IOType>analogChannel</IOType></IOOutputPort></IOOutputPortList>';
    expect(readAlarmOutputs(parseXml(own), 'local')).toEqual([{ id: '1', type: 'local', ipAddress: null }]);
  });

  it('reads which channels’ cameras have a light or a speaker', () => {
    expect([...nvrSupport().whiteLightChannels]).toEqual(['3', '4']);
    expect([...nvrSupport().audioChannels]).toEqual(['3', '4']);
    expect(readLightAudioChannels(null, 'AudioAlarmList').size).toBe(0);
    expect(readLightAudioChannels({ AudioAlarmList: 'none' }, 'AudioAlarmList').size).toBe(0);
  });

  it('points the NVR’s channel 3 at its own camera’s relay, light and speaker', () => {
    const doc = parseXml(fixtures.eventTriggerNvrVmd3);
    const actions = resolveEventActions(doc, nvrSupport(), { id: '3', ipAddress: '192.168.254.4' });
    expect(Object.values(reasons(actions)).every(r => r === null)).toBe(true);

    applyNotifications(doc, Object.values(actions).map(a => ({ spec: a.spec, enabled: true })));
    // Exactly the shapes the NVR's web UI writes and the device accepted
    expect(entriesOf(doc)).toEqual([
      'id=record-3 notificationMethod=record dynVideoInputID=3',
      'id=center notificationMethod=center',
      'id=email notificationMethod=email',
      'id=beep notificationMethod=beep',
      'id=IO-301 notificationMethod=IO dynOutputIOPortID=301',
      'id=whiteLightOut-3 notificationMethod=whiteLightOut lightAudioOutID=3',
      'id=audioOut-3 notificationMethod=audioOut lightAudioOutID=3',
    ]);
    expect(serializeXml(doc)).not.toMatch(/<notificationMethod>(whiteLight|audio)</);
  });

  it('disables the relay, light and speaker on a channel whose camera has none', () => {
    const actions = resolveEventActions(parseXml(fixtures.eventTriggerNvr), nvrSupport(), { id: '1', ipAddress: '192.168.254.2' });
    expect(reasons(actions)).toEqual({
      record: null, center: null, email: null, beep: null,
      IO: 'noAlarmOutput', whiteLight: 'noWhiteLight', audio: 'noSpeaker',
    });
    expect([actions.IO.spec, actions.whiteLight.spec, actions.audio.spec]).toEqual([null, null, null]);
  });

  it('offers only what triggersCap flags true for motion', () => {
    const support = {
      ...nvrSupport(),
      triggerCap: { isSupportRecord: true, isSupportCenter: false, isSupportIO: true, isSupportWhiteLightOut: false },
    };
    const actions = resolveEventActions(parseXml(fixtures.eventTriggerNvrVmd3), support, { id: '3', ipAddress: '192.168.254.4' });
    expect(reasons(actions)).toEqual({
      record: null, center: 'notSupported', email: 'notSupported', beep: 'notSupported', IO: null,
      whiteLight: 'notSupported',
      audio: null, // the flag isn't named at all: the bare method, as before
    });
    // An unsupported action still knows its entry, so its toggle can show the state
    expect(actions.center.spec?.method).toBe('center');
    expect(actions.audio.spec?.method).toBe('audio');
  });

  it('keeps the old behaviour on a device without triggersCap', () => {
    const support = {
      triggerCap: null, alarmOutputs: [{ id: '1', type: 'local', ipAddress: null }],
      whiteLightChannels: new Set(), audioChannels: new Set(),
    };
    const doc = parseXml(fixtures.eventTrigger);
    const actions = resolveEventActions(doc, support, { id: '1' });
    expect(Object.values(reasons(actions)).every(r => r === null)).toBe(true);
    expect([actions.IO.spec?.id, actions.whiteLight.spec?.method, actions.audio.spec?.method]).toEqual(['IO-1', 'whiteLight', 'audio']);

    applyNotifications(doc, [{ spec: actions.IO.spec, enabled: true }]);
    expect(entriesOf(doc).at(-1)).toBe('id=IO-1 notificationMethod=IO notificationRecurrence=beginning outputIOPortID=1');
  });

  it('falls back to the device’s own relay, and addresses every port by outputIOPortID when ports are unified', () => {
    const alarmOutputs = [
      { id: '301', type: 'digital', ipAddress: '192.168.254.4' },
      { id: '1', type: 'local', ipAddress: null },
    ];
    const doc = parseXml(fixtures.eventTriggerNvr);
    const support = { ...nvrSupport(), alarmOutputs };
    expect(resolveEventActions(doc, support, { id: '1', ipAddress: '192.168.254.2' }).IO.spec)
      .toMatchObject({ id: 'IO-1', writeFields: ['outputIOPortID'] });

    const unified = { ...support, triggerCap: { ...support.triggerCap, isSupportIOOutputUnify: true } };
    expect(resolveEventActions(doc, unified, { id: '3', ipAddress: '192.168.254.4' }).IO.spec)
      .toMatchObject({ id: 'IO-301', writeFields: ['outputIOPortID'] });
  });
});
