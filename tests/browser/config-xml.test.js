/**
 * Reading and editing the device config documents behind each tool.
 */
import { describe, expect, it } from 'vitest';
import { childElements, childText, parseXml, serializeXml } from '../../extension/lib/xml.js';
import {
  DEFAULT_PRIVACY_SCREEN, applyMotionConfig, applyNotificationMethods, canvasRectToPrivacy, decodeGridMap, encodeGridMap,
  applyPrivacyMask, privacyRegionList, privacyRegionToCanvas, readMotionCapabilities, readMotionConfig,
  readNotificationMethods, readPrivacyMask, triggerNotifications,
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

describe('event trigger notifications', () => {
  const MANAGED = ['record', 'center', 'email', 'beep', 'IO', 'whiteLight', 'audio'];
  const methodsOf = (doc) => [...readNotificationMethods(doc)];

  it('lists every method', () => {
    expect(methodsOf(parseXml(fixtures.eventTrigger))).toEqual(['record', 'IO', 'FTP']);
  });

  it('keeps unmanaged methods and existing settings', () => {
    const doc = parseXml(fixtures.eventTrigger);
    applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['IO', 'center']), channelId: '1' });
    const byMethod = Object.fromEntries(triggerNotifications(doc).map(n => [childText(n, 'notificationMethod'), n]));
    expect(Object.keys(byMethod).sort()).toEqual(['FTP', 'IO', 'center']);
    expect(childText(byMethod.IO, 'outputIOPortID')).toBe('2');
    expect(childText(byMethod.IO, 'id')).toBe('IO-2');
    expect(childText(doc.documentElement, 'dynVideoInputChannelID')).toBe('1');
  });

  it('addresses a new record entry the way the trigger does', () => {
    const doc = parseXml(fixtures.eventTrigger);
    applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(), channelId: '3' });
    applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['record']), channelId: '3' });
    const rec = triggerNotifications(doc).find(n => childText(n, 'notificationMethod') === 'record');
    expect([childText(rec, 'videoInputID'), childText(rec, 'dynVideoInputID')]).toEqual(['3', '3']);
    expect(methodsOf(doc)).toEqual(['FTP', 'record']);
  });

  it('uses NVR conventions for new entries', () => {
    const doc = parseXml(fixtures.eventTriggerNvr);
    applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['center']), channelId: '1' });
    expect(methodsOf(doc)).toEqual(['center']);
    applyNotificationMethods(doc, { managed: MANAGED, enabled: new Set(['center', 'record', 'IO']), channelId: '1' });
    const find = (m) => triggerNotifications(doc).find(n => childText(n, 'notificationMethod') === m);
    expect([childText(find('record'), 'id'), childText(find('record'), 'dynVideoInputID'), childText(find('record'), 'videoInputID')])
      .toEqual(['record-1', '1', null]);
    expect(childText(find('IO'), 'id')).toBe('IO-1');
  });
});
