/**
 * Read and edit the ISAPI config documents behind each tool.
 *
 * Every apply* function edits the document the device returned and changes
 * only the fields the UI controls. Anything else — firmware-specific fields,
 * notification methods we don't expose, a mask slot's maskType — is sent
 * back exactly as received. Coordinates in documents are raw device units;
 * the privacy mask helpers also map them to and from canvas pixels, because
 * that mapping (Y from the bottom) is easy to get wrong in the UI.
 *
 * Depends on lib/xml.js.
 */

import { appendElement, childElement, childElements, childText, findDescendant, setChildText, xmlPath } from './xml.js';

/* ── Motion detection ───────────────────────────────────────────────────── */

/**
 * Motion region coordinates are normalized to 0–1000 on both axes, with Y
 * measured from the bottom of the image (Hikvision web UI drawTools.js).
 */
export const MOTION_COORDINATE_SCALE = 1000;

/**
 * @typedef {object} MotionCapabilities
 * @property {string[]} regionTypes - e.g. ["grid", "region"]
 * @property {number} maxRegions
 * @property {number} minPoints - corners per polygon
 * @property {number} maxPoints
 * @property {{min: number, max: number, step: number}} sensitivity
 * @property {string[]} targetTypes - e.g. ["human", "vehicle"]; empty if unsupported
 */

/** Limits used when the device doesn't publish capabilities. */
export const DEFAULT_MOTION_CAPABILITIES = {
  regionTypes: ['region'],
  maxRegions: 4,
  minPoints: 3,
  maxPoints: 10,
  sensitivity: { min: 0, max: 100, step: 1 },
  targetTypes: [],
};

/**
 * Integer attribute of an element, or `fallback` when missing/invalid.
 * @param {Element|null} el
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function intAttr(el, name, fallback) {
  const value = parseInt(el?.getAttribute(name) ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
}

/**
 * Comma-separated `opt` attribute as a list.
 * @param {Element|null} el
 * @returns {string[]}
 */
export function optList(el) {
  return (el?.getAttribute('opt') || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Read a motionDetection/capabilities document.
 * @param {XMLDocument|null} doc
 * @returns {MotionCapabilities}
 */
export function readMotionCapabilities(doc) {
  const d = DEFAULT_MOTION_CAPABILITIES;
  if (!doc) return { ...d, sensitivity: { ...d.sensitivity } };
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');
  const sens = childElement(layout, 'sensitivityLevel');
  const edges = childElement(layout, 'regionEdgesNum');
  const regionTypes = optList(childElement(root, 'regionType'));
  return {
    regionTypes: regionTypes.length ? regionTypes : d.regionTypes,
    maxRegions: intAttr(xmlPath(layout, 'layout', 'RegionList'), 'size', d.maxRegions),
    minPoints: intAttr(edges, 'min', d.minPoints),
    maxPoints: intAttr(edges, 'max', d.maxPoints),
    sensitivity: {
      min: intAttr(sens, 'min', d.sensitivity.min),
      max: intAttr(sens, 'max', d.sensitivity.max),
      step: Math.max(1, intAttr(sens, 'step', d.sensitivity.step)),
    },
    targetTypes: optList(childElement(layout, 'targetType')),
  };
}

/**
 * @typedef {{x: number, y: number}} DevicePoint
 * @typedef {object} MotionConfig
 * @property {boolean} enabled
 * @property {number|null} sensitivity
 * @property {boolean} dynamicAnalysis
 * @property {boolean} supportsDynamicAnalysis - the device has the field at all
 * @property {string|null} regionType - "region" (polygons) or "grid" (cells)
 * @property {MotionGrid|null} grid - the cell grid, when the device sends one
 * @property {string[]} targetTypes - enabled detection targets, e.g. ["human"]
 * @property {boolean} detectHuman
 * @property {boolean} detectVehicle
 * @property {DevicePoint[][]} regions - polygons, device coordinates
 */

/**
 * Integer text of a child element; NaN when missing or not a number.
 * @param {Element|null} el
 * @param {string} name
 */
function intText(el, name) {
  return parseInt(childText(el, name) ?? '', 10);
}

/**
 * Read the RegionCoordinates points under an element.
 * @param {Element} el
 * @returns {DevicePoint[]}
 */
export function readCoordinates(el) {
  return childElements(childElement(el, 'RegionCoordinatesList'), 'RegionCoordinates').map(c => ({
    x: intText(c, 'positionX') || 0,
    y: intText(c, 'positionY') || 0,
  }));
}

/**
 * Grid-mode detection area: which cells of a rows × cols grid are active,
 * row 0 at the top of the image.
 * @typedef {{rows: number, cols: number, cells: boolean[][]}} MotionGrid
 */

/** Hex digits per grid row: each row is padded to whole bytes. @param {number} cols */
function hexDigitsPerRow(cols) {
  return Math.ceil(cols / 8) * 2;
}

/**
 * Decode a gridMap: one row after another, each row's cells as bits, most
 * significant bit first (column 0), padded to whole bytes.
 * @param {string} hex
 * @param {number} rows
 * @param {number} cols
 * @returns {boolean[][]}
 */
export function decodeGridMap(hex, rows, cols) {
  const perRow = hexDigitsPerRow(cols);
  return Array.from({ length: rows }, (_, r) => {
    const rowHex = hex.slice(r * perRow, (r + 1) * perRow).padEnd(perRow, '0');
    return Array.from({ length: cols }, (_cell, c) => ((parseInt(rowHex[c >> 2], 16) >> (3 - (c & 3))) & 1) === 1);
  });
}

/**
 * Encode cells back into a gridMap (inverse of decodeGridMap).
 * @param {boolean[][]} cells
 * @param {number} cols
 * @returns {string} lowercase hex
 */
export function encodeGridMap(cells, cols) {
  const perRow = hexDigitsPerRow(cols);
  return cells.map(row => {
    let rowHex = '';
    for (let d = 0; d < perRow; d++) {
      let digit = 0;
      for (let b = 0; b < 4; b++) if (row[d * 4 + b]) digit |= 8 >> b;
      rowHex += digit.toString(16);
    }
    return rowHex;
  }).join('');
}

/**
 * Read a MotionDetection document.
 * @param {XMLDocument} doc
 * @returns {MotionConfig}
 */
export function readMotionConfig(doc) {
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');
  const sensitivity = intText(layout, 'sensitivityLevel');

  // Firmware stores the detection target either as TargetDetection blocks
  // (top level or under the layout) or as a layout <targetType>, e.g. "human"
  /** @type {Record<string, boolean>} */
  const targets = {};
  for (const parent of [root, layout]) {
    for (const t of childElements(childElement(parent, 'TargetDetection'), 'detectionTarget')) {
      const type = childText(t, 'targetType');
      if (type) targets[type] = childText(t, 'enabled') === 'true';
    }
  }
  for (const type of (childText(layout, 'targetType') || '').split(',')) {
    if (type.trim()) targets[type.trim()] = true;
  }

  const gridEl = childElement(root, 'Grid');
  const rows = intText(gridEl, 'rowGranularity');
  const cols = intText(gridEl, 'columnGranularity');
  const gridMap = findDescendant(root, 'gridMap')?.textContent?.trim();
  const dynamic = findDescendant(root, 'enableDynamicAnalysis');

  return {
    enabled: childText(root, 'enabled') === 'true',
    sensitivity: Number.isNaN(sensitivity) ? null : sensitivity,
    targetTypes: Object.keys(targets).filter(t => targets[t]),
    dynamicAnalysis: dynamic?.textContent?.trim() === 'true',
    supportsDynamicAnalysis: dynamic !== null,
    regionType: findDescendant(root, 'regionType')?.textContent?.trim() || null,
    grid: rows > 0 && cols > 0 && gridMap !== undefined
      ? { rows, cols, cells: decodeGridMap(gridMap, rows, cols) }
      : null,
    detectHuman: targets.human ?? false,
    detectVehicle: targets.vehicle ?? false,
    regions: childElements(xmlPath(layout, 'layout', 'RegionList'), 'Region')
      .map(readCoordinates)
      .filter(points => points.length >= 3),
  };
}

/**
 * Write motion settings into the device's MotionDetection document.
 *
 * Matches what Hikvision's own client sends: regionType switched to
 * "region" (the device ignores RegionList in grid mode), gridMap zeroed, and
 * each <Region> in an empty namespace (`<Region xmlns="">`).
 *
 * In grid mode (`mode: "grid"`, for cameras without polygon support) only
 * gridMap changes and the region list is left alone.
 *
 * Detection targets go in the layout's <targetType> as a comma-separated
 * list ("human,vehicle", or empty for none), created in an empty namespace
 * when missing — again as the Hikvision client does. Pass `targetTypes`
 * only when the device supports targets.
 *
 * @param {XMLDocument} doc - edited in place
 * @param {{enabled: boolean, sensitivity: number, dynamicAnalysis: boolean, regions: DevicePoint[][], targetTypes?: string[], mode?: 'region'|'grid', grid?: MotionGrid}} config
 */
export function applyMotionConfig(doc, config) {
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');

  setChildText(root, 'enabled', config.enabled);
  if (!setChildText(layout, 'sensitivityLevel', config.sensitivity)) {
    const sens = findDescendant(root, 'sensitivityLevel');
    if (sens) sens.textContent = String(config.sensitivity);
  }
  writeTargetTypes(layout, config.targetTypes);

  if (config.mode === 'grid') {
    const grid = config.grid;
    const gridMap = findDescendant(root, 'gridMap');
    if (!grid || !gridMap) throw new Error('This device did not return a motion grid, so the grid cannot be saved');
    gridMap.textContent = encodeGridMap(grid.cells, grid.cols);
    const regionType = findDescendant(root, 'regionType');
    if (regionType) regionType.textContent = 'grid';
    const dynamicField = findDescendant(root, 'enableDynamicAnalysis');
    if (dynamicField) dynamicField.textContent = String(config.dynamicAnalysis);
    return;
  }

  const regionType = findDescendant(root, 'regionType');
  if (regionType) regionType.textContent = 'region';

  const gridMap = findDescendant(root, 'gridMap');
  if (gridMap) gridMap.textContent = '0'.repeat(gridMap.textContent.length);

  // Only touch the field if this firmware has it
  const dynamic = findDescendant(root, 'enableDynamicAnalysis');
  if (dynamic) dynamic.textContent = String(config.dynamicAnalysis);

  let regionList = findDescendant(root, 'RegionList');
  if (!regionList) {
    const layoutInner = childElement(layout, 'layout');
    if (!layoutInner) {
      throw new Error('This device did not return a motion region layout, so regions cannot be saved');
    }
    regionList = appendElement(layoutInner, 'RegionList');
  }
  regionList.replaceChildren();
  regionList.setAttribute('size', String(config.regions.length));


  config.regions.forEach((points, i) => {
    const region = appendElement(regionList, 'Region', undefined, null);
    appendElement(region, 'id', i + 1, null);
    const coordList = appendElement(region, 'RegionCoordinatesList', undefined, null);
    for (const p of points) {
      const coord = appendElement(coordList, 'RegionCoordinates', undefined, null);
      appendElement(coord, 'positionX', Math.round(p.x), null);
      appendElement(coord, 'positionY', Math.round(p.y), null);
    }
  });
}

/**
 * Write the detection targets as the Hikvision client does: a comma-separated
 * list in the layout's <targetType>, created in an empty namespace if missing.
 * Leaves the document alone when `targetTypes` is undefined (unsupported).
 * @param {Element|null} layout
 * @param {string[]|undefined} targetTypes
 */
function writeTargetTypes(layout, targetTypes) {
  if (!targetTypes || !layout) return;
  const targetType = childElement(layout, 'targetType') ?? appendElement(layout, 'targetType', undefined, null);
  targetType.textContent = targetTypes.join(',');
}

/* ── Privacy mask ───────────────────────────────────────────────────────── */

/**
 * The coordinate space to assume when a PrivacyMask document doesn't declare
 * its normalizedScreenSize: the 704×576 grid Hikvision's web UI falls back to
 * (privacyMask.js), and the one the DS-7604NI declares.
 */
export const DEFAULT_PRIVACY_SCREEN = Object.freeze({ width: 704, height: 576 });

/**
 * A width and height, e.g. a document's normalizedScreenSize or a canvas.
 * @typedef {{width: number, height: number}} Size
 */

/**
 * A rectangle on the drawn image in pixels, Y=0 at the top, as the privacy
 * tool keeps it.
 * @typedef {{x: number, y: number, w: number, h: number}} PixelRect
 */

/**
 * A mask rectangle in device units, given by two opposite corners.
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} DeviceRect
 */

/**
 * The region list, whether the document is a PrivacyMask or the bare list.
 * @param {XMLDocument} doc
 * @returns {Element|null}
 */
export function privacyRegionList(doc) {
  const root = doc.documentElement;
  return root.localName === 'PrivacyMaskRegionList' ? root : childElement(root, 'PrivacyMaskRegionList');
}

/**
 * Read a PrivacyMask (or bare PrivacyMaskRegionList) document.
 *
 * Every region with an area is a mask, whatever its own <enabled>: the
 * DS-7604NI reads every stored region back with enabled=false yet still
 * masks it, and Hikvision's web UI ignores the per-region flag as well.
 * Empty or zero-area slots (unused slots on fixed-slot cameras) are skipped.
 *
 * `enabled` is the document's global switch. A bare region list has none, so
 * there it reports whether any region is enabled — the flag a save writes to
 * each region. `screen` is the coordinate space the device declares, when it
 * does (see DEFAULT_PRIVACY_SCREEN otherwise).
 * @param {XMLDocument} doc
 * @returns {{enabled: boolean, screen: Size|null, regions: DevicePoint[][]}}
 */
export function readPrivacyMask(doc) {
  const root = doc.documentElement;
  const size = childElement(root, 'normalizedScreenSize');
  const width = intText(size, 'normalizedScreenWidth');
  const height = intText(size, 'normalizedScreenHeight');
  const slots = childElements(privacyRegionList(doc), 'PrivacyMaskRegion');
  const globalFlag = childText(root, 'enabled');
  return {
    enabled: globalFlag !== null
      ? globalFlag === 'true'
      : slots.some(r => childText(r, 'enabled') === 'true'),
    screen: width > 0 && height > 0 ? { width, height } : null,
    regions: slots.map(readCoordinates).filter(hasArea),
  };
}

/**
 * Smallest box around a region's points.
 * @param {DevicePoint[]} points
 */
function boundingBox(points) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * Whether the points enclose an area: an unused slot has no points, or all
 * of them at one spot.
 * @param {DevicePoint[]} points
 */
function hasArea(points) {
  if (points.length < 2) return false;
  const box = boundingBox(points);
  return box.maxX > box.minX && box.maxY > box.minY;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Where a stored privacy mask appears on the image, as a canvas rectangle.
 *
 * Privacy coordinates are in the document's normalizedScreenSize units,
 * stretched over the whole image, with Y measured from the BOTTOM: on the
 * DS-7604NI a region at positionY 432–576 masks the top quarter of the
 * picture. The canvas has Y=0 at the top, so Y is flipped. The tool edits
 * rectangles, so a polygon becomes its bounding box.
 * @param {DevicePoint[]} points - one region, as readPrivacyMask returns it
 * @param {Size} screen - the document's normalizedScreenSize, or DEFAULT_PRIVACY_SCREEN
 * @param {Size} canvas - canvas size in pixels
 * @returns {PixelRect}
 * @example
 * privacyRegionToCanvas([{x: 0, y: 432}, {x: 704, y: 576}], {width: 704, height: 576}, {width: 1408, height: 1152})
 * // → {x: 0, y: 0, w: 1408, h: 288}: the top quarter
 */
export function privacyRegionToCanvas(points, screen, canvas) {
  const box = boundingBox(points.map(p => ({
    x: clamp(p.x, 0, screen.width),
    y: clamp(p.y, 0, screen.height),
  })));
  return {
    x: (box.minX / screen.width) * canvas.width,
    y: (1 - box.maxY / screen.height) * canvas.height,
    w: ((box.maxX - box.minX) / screen.width) * canvas.width,
    h: ((box.maxY - box.minY) / screen.height) * canvas.height,
  };
}

/**
 * A rectangle drawn on the canvas as the device rectangle to save: the
 * inverse of privacyRegionToCanvas, rounded to whole units and clamped to
 * the screen. Y counts from the bottom, so y1 (the top edge) is the larger.
 * @param {PixelRect} rect
 * @param {Size} screen - the document's normalizedScreenSize, or DEFAULT_PRIVACY_SCREEN
 * @param {Size} canvas - canvas size in pixels
 * @returns {DeviceRect}
 * @example
 * canvasRectToPrivacy({x: 0, y: 0, w: 1408, h: 288}, {width: 704, height: 576}, {width: 1408, height: 1152})
 * // → {x1: 0, y1: 576, x2: 704, y2: 432}
 */
export function canvasRectToPrivacy(rect, screen, canvas) {
  /** @param {number} px */
  const toX = px => clamp(Math.round((px / canvas.width) * screen.width), 0, screen.width);
  /** @param {number} py */
  const toY = py => clamp(Math.round((1 - py / canvas.height) * screen.height), 0, screen.height);
  return { x1: toX(rect.x), y1: toY(rect.y), x2: toX(rect.x + rect.w), y2: toY(rect.y + rect.h) };
}

/**
 * Replace a region's coordinates with the four corners of a rectangle.
 * @param {Element} regionEl
 * @param {DeviceRect} rect
 */
export function writeRectangle(regionEl, rect) {
  let list = childElement(regionEl, 'RegionCoordinatesList');
  if (!list) list = appendElement(regionEl, 'RegionCoordinatesList');
  list.replaceChildren();
  const corners = [[rect.x1, rect.y1], [rect.x2, rect.y1], [rect.x2, rect.y2], [rect.x1, rect.y2]];
  for (const [x, y] of corners) {
    const coord = appendElement(list, 'RegionCoordinates');
    appendElement(coord, 'positionX', Math.round(x));
    appendElement(coord, 'positionY', Math.round(y));
  }
}

/** Children of a PrivacyMaskRegion that applyPrivacyMask writes itself. */
const PRIVACY_REGION_FIELDS = new Set(['id', 'enabled', 'RegionCoordinatesList']);

/**
 * What to do with region slots no rectangle needs (see applyPrivacyMask).
 * @typedef {'remove'|'disable'} UnusedPrivacySlots
 */

/**
 * Write privacy mask rectangles into the device's document. Like Hikvision's
 * web UI, each region's <enabled> is set to the global switch.
 *
 * `unused` decides what happens to region slots no rectangle needs:
 * - "remove" (default): the list is rebuilt to hold exactly the rectangles,
 *   ids 1..n, in the web UI's element order (id, enabled,
 *   RegionCoordinatesList). Other children of the slot a region takes over,
 *   e.g. maskType, are kept. Use it only after the stored regions have been
 *   deleted: the DS-7604NI merges a PUT into its stored regions by id, so a
 *   region left out of the list would stay stored and keep masking.
 * - "disable": for firmware that can't delete regions (fixed slots). Every
 *   slot stays in place; slots without a rectangle are disabled and their
 *   coordinates emptied, as such cameras show an unused slot. Emptying them
 *   matters because readPrivacyMask shows a region whatever its own flag, and
 *   because the NVR masks a disabled region anyway.
 *
 * @param {XMLDocument} doc - edited in place
 * @param {{enabled: boolean, rects: DeviceRect[], unused?: UnusedPrivacySlots}} config
 */
export function applyPrivacyMask(doc, { enabled, rects, unused = 'remove' }) {
  const root = doc.documentElement;
  setChildText(root, 'enabled', enabled);

  const list = privacyRegionList(doc) ?? appendElement(root, 'PrivacyMaskRegionList');
  const slots = childElements(list, 'PrivacyMaskRegion');

  if (unused === 'remove') {
    list.replaceChildren(...rects.map((rect, i) => buildPrivacyRegion(list, i + 1, enabled, rect, slots[i])));
    return;
  }

  rects.forEach((rect, i) => {
    let region = slots[i];
    if (!region) {
      region = appendElement(list, 'PrivacyMaskRegion');
      appendElement(region, 'id', i + 1);
      appendElement(region, 'enabled', enabled);
    }
    setChildText(region, 'enabled', enabled);
    writeRectangle(region, rect);
  });
  for (const slot of slots.slice(rects.length)) {
    setChildText(slot, 'enabled', false);
    childElement(slot, 'RegionCoordinatesList')?.replaceChildren();
  }
}

/**
 * A new PrivacyMaskRegion in the list's namespace, keeping the fields we
 * don't manage (e.g. maskType) from the slot it replaces.
 * @param {Element} list
 * @param {number} id
 * @param {boolean} enabled
 * @param {DeviceRect} rect
 * @param {Element|undefined} previous
 * @returns {Element}
 */
function buildPrivacyRegion(list, id, enabled, rect, previous) {
  const region = list.ownerDocument.createElementNS(list.namespaceURI, 'PrivacyMaskRegion');
  appendElement(region, 'id', id);
  appendElement(region, 'enabled', enabled);
  writeRectangle(region, rect);
  for (const extra of Array.from(previous?.children ?? [])) {
    if (!PRIVACY_REGION_FIELDS.has(extra.localName)) region.appendChild(extra.cloneNode(true));
  }
  return region;
}

/* ── Event trigger notifications ────────────────────────────────────────── */

/**
 * The <EventTriggerNotification> elements of a trigger.
 * @param {XMLDocument} doc
 * @returns {Element[]}
 */
export function triggerNotifications(doc) {
  return childElements(
    childElement(doc.documentElement, 'EventTriggerNotificationList'),
    'EventTriggerNotification');
}

/**
 * Notification methods ("record", "center", "email", ...) enabled on a trigger.
 * @param {XMLDocument} doc
 * @returns {Set<string>}
 */
export function readNotificationMethods(doc) {
  return new Set(triggerNotifications(doc).map(n => childText(n, 'notificationMethod') ?? ''));
}

/**
 * Turn the given notification methods on or off on an EventTrigger document.
 * Methods not listed in `managed` (FTP, extra alarm outputs, ...) are left
 * as they are, and existing entries keep their settings (which channel to
 * record, which output port to trigger). New entries follow the device's
 * conventions: NVRs address channels with dyn* fields and ids like "record-1".
 *
 * @param {XMLDocument} doc - edited in place
 * @param {object} options
 * @param {string[]} options.managed - methods the UI controls
 * @param {Set<string>} options.enabled - which of those should be on
 * @param {string} options.channelId - for new "record" entries
 */
export function applyNotificationMethods(doc, { managed, enabled, channelId }) {
  const root = doc.documentElement;
  // Address the channel the same way(s) the trigger itself does
  /** @type {string[]} */
  const channelFields = [];
  if (childElement(root, 'videoInputChannelID')) channelFields.push('videoInputID');
  if (childElement(root, 'dynVideoInputChannelID')) channelFields.push('dynVideoInputID');
  if (channelFields.length === 0) channelFields.push('videoInputID');
  let list = childElement(root, 'EventTriggerNotificationList');
  if (!list) list = appendElement(root, 'EventTriggerNotificationList');

  for (const method of managed) {
    const existing = triggerNotifications(doc).filter(n => childText(n, 'notificationMethod') === method);

    if (!enabled.has(method)) {
      existing.forEach(n => n.remove());
      continue;
    }
    if (existing.length > 0) continue;

    const n = appendElement(list, 'EventTriggerNotification');
    if (method === 'record') {
      appendElement(n, 'id', `record-${channelId}`);
      appendElement(n, 'notificationMethod', method);
      appendElement(n, 'notificationRecurrence', 'beginning');
      channelFields.forEach(field => appendElement(n, field, channelId));
    } else if (method === 'IO') {
      appendElement(n, 'id', 'IO-1');
      appendElement(n, 'notificationMethod', method);
      appendElement(n, 'outputIOPortID', 1);
    } else {
      appendElement(n, 'id', method);
      appendElement(n, 'notificationMethod', method);
    }
  }
}
