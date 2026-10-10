/**
 * Read and edit the ISAPI config documents behind each tool.
 *
 * Every apply* function edits the document the device returned and changes
 * only the fields the UI controls. Anything else — firmware-specific fields,
 * notification methods we don't expose, a mask slot's maskType — is sent
 * back exactly as received. Coordinates in documents are raw device units;
 * the motion and privacy helpers also map them to and from fractions of the
 * picture (lib/shapes.js), the units the tools keep their shapes in, because
 * that mapping (Y from the bottom) is easy to get wrong in the UI.
 *
 * For event actions this module also reads what a device offers (triggersCap,
 * alarm outputs, cameras with lights or speakers) and resolves which
 * notification entry each toggle stands for on a channel. Fetching those
 * documents is up to lib/isapi.js; everything here is pure.
 *
 * Depends on lib/xml.js.
 */

import { appendElement, childElement, childElements, childText, findDescendant, setChildText, xmlPath } from './xml.js';

/** @typedef {import('./shapes.js').ImagePoint} ImagePoint */
/** @typedef {import('./shapes.js').ImageRect} ImageRect */

/* ── Motion detection ───────────────────────────────────────────────────── */

/**
 * Motion region coordinates are normalized to 0–1000 on both axes, with Y
 * measured from the bottom of the image (Hikvision web UI drawTools.js).
 */
export const MOTION_COORDINATE_SCALE = 1000;

/**
 * The sensitivity levels a camera accepts: min to max in steps of `step`
 * (0–100 in steps of 20 on the DS-7604NI, the same six levels as the SDK's 0–5).
 * @typedef {{min: number, max: number, step: number}} SensitivityRange
 */

/**
 * What a camera's motion detection offers, from its capabilities. Parts the
 * camera doesn't state are left unknown rather than guessed, so the editor
 * doesn't write a value or switch a mode the camera never offered.
 * @typedef {object} MotionCapabilities
 * @property {string[]} regionTypes - e.g. ["grid", "region"]; empty when unknown
 * @property {number} maxRegions
 * @property {number} minPoints - corners per polygon
 * @property {number} maxPoints
 * @property {SensitivityRange|null} sensitivity - null when unknown: the stored level is kept
 * @property {string[]} targetTypes - e.g. ["human", "vehicle"]; empty if unsupported or unknown
 */

/**
 * Used when the device doesn't publish capabilities: the region limits of
 * Hikvision's web UI, and nothing else assumed.
 * @type {Readonly<MotionCapabilities>}
 */
export const DEFAULT_MOTION_CAPABILITIES = Object.freeze({
  regionTypes: [],
  maxRegions: 4,
  minPoints: 3,
  maxPoints: 10,
  sensitivity: null,
  targetTypes: [],
});

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
 *
 * The sensitivity levels come from it, or else from the
 * motionDetection/layout/capabilities document, where Hikvision's web UI
 * reads them; with neither, they stay unknown (null).
 * @param {XMLDocument|null} doc - the capabilities, or null when the device didn't give them
 * @param {XMLDocument|null} [layoutDoc] - the layout capabilities, when fetched
 * @returns {MotionCapabilities}
 */
export function readMotionCapabilities(doc, layoutDoc = null) {
  const d = DEFAULT_MOTION_CAPABILITIES;
  const sensitivity = readSensitivityRange(doc) ?? readSensitivityRange(layoutDoc);
  if (!doc) return { ...d, regionTypes: [], targetTypes: [], sensitivity };
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');
  const edges = childElement(layout, 'regionEdgesNum');
  return {
    regionTypes: optList(childElement(root, 'regionType')),
    maxRegions: intAttr(xmlPath(layout, 'layout', 'RegionList'), 'size', d.maxRegions),
    minPoints: intAttr(edges, 'min', d.minPoints),
    maxPoints: intAttr(edges, 'max', d.maxPoints),
    sensitivity,
    targetTypes: optList(childElement(layout, 'targetType')),
  };
}

/**
 * The sensitivity levels a capabilities document states: its
 * <sensitivityLevel> with min and max (a step of 1 when it gives none).
 * Works on both the motion capabilities and the layout capabilities.
 * @param {XMLDocument|null} doc
 * @returns {SensitivityRange|null} null when the document doesn't say
 * @example
 * // <MotionDetectionLayout><sensitivityLevel min="0" max="100" step="20">40</sensitivityLevel>…
 * readSensitivityRange(layoutCaps) // → {min: 0, max: 100, step: 20}
 */
export function readSensitivityRange(doc) {
  const el = doc ? findDescendant(doc.documentElement, 'sensitivityLevel') : null;
  const min = intAttr(el, 'min', NaN);
  const max = intAttr(el, 'max', NaN);
  if (Number.isNaN(min) || Number.isNaN(max) || max < min) return null;
  return { min, max, step: Math.max(1, intAttr(el, 'step', 1)) };
}

/**
 * The sensitivity level nearest to a value that the camera accepts.
 * @param {number} value - e.g. where the slider is
 * @param {SensitivityRange} range
 * @returns {number}
 * @example
 * snapSensitivity(50, {min: 0, max: 100, step: 20}) // → 60
 */
export function snapSensitivity(value, { min, max, step }) {
  return clamp(min + Math.round((value - min) / step) * step, min, max);
}

/**
 * @typedef {{x: number, y: number}} DevicePoint
 * @typedef {object} MotionConfig
 * @property {boolean} enabled
 * @property {number|null} sensitivity
 * @property {boolean} dynamicAnalysis - "Dynamic Analysis for Motion": the root <enableHighlight>
 * @property {boolean} supportsDynamicAnalysis - the device sends <enableHighlight> at all
 * @property {string|null} regionType - "region" (polygons) or "grid" (cells)
 * @property {MotionGrid|null} grid - the cell grid, when the device sends one
 * @property {string[]} targetTypes - enabled detection targets, e.g. ["human"]
 * @property {boolean} detectHuman
 * @property {boolean} detectVehicle
 * @property {DevicePoint[][]} regions - polygons, device coordinates
 * @property {Size|null} screen - the coordinate space the document declares
 *   (normalizedScreenWidth/Height, as legacy ROI-mode cameras do), or null
 *   for the usual 0–1000; a dimension it leaves out counts as 1000
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
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
 * A stored motion region as corners on the picture, the units the motion
 * tool keeps it in. Device units are 0–1000 on both axes with Y from the
 * BOTTOM (MOTION_COORDINATE_SCALE); the picture has Y=0 at the top, so Y is
 * flipped. Values off the 0–1000 range are clamped onto the picture.
 *
 * A document that declares another coordinate space (MotionConfig.screen)
 * is scaled by it instead, with Y from the bottom as in the privacy masks'
 * space. That is an assumption, used only to show such regions: the editor
 * never saves them (see motionEditMode).
 * @param {DevicePoint[]} points - one region, as readMotionConfig returns it
 * @param {Size|null} [screen] - the document's coordinate space; null for 0–1000
 * @returns {ImagePoint[]}
 * @example
 * motionRegionToImage([{x: 250, y: 1000}, {x: 500, y: 0}])
 * // → [{x: 0.25, y: 0}, {x: 0.5, y: 1}]: the top edge, then the bottom edge
 */
export function motionRegionToImage(points, screen = null) {
  const width = screen?.width ?? MOTION_COORDINATE_SCALE;
  const height = screen?.height ?? MOTION_COORDINATE_SCALE;
  return points.map(p => ({ x: clamp(p.x, 0, width) / width, y: 1 - clamp(p.y, 0, height) / height }));
}

/**
 * Corners on the picture as the device region to save: the inverse of
 * motionRegionToImage, rounded to whole units and clamped to 0–1000.
 * @param {ImagePoint[]} points
 * @returns {DevicePoint[]}
 * @example
 * imageToMotionRegion([{x: 0.25, y: 0}, {x: 1.2, y: 0.5}]) // → [{x: 250, y: 1000}, {x: 1000, y: 500}]
 */
export function imageToMotionRegion(points) {
  /** @param {number} v - fraction of the picture */
  const toDevice = v => clamp(Math.round(v * MOTION_COORDINATE_SCALE), 0, MOTION_COORDINATE_SCALE);
  return points.map(p => ({ x: toDevice(p.x), y: toDevice(1 - p.y) }));
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
 *
 * The Dynamic Analysis toggle is the root <enableHighlight>, which the web UI
 * labels "Dynamic Analysis for Motion" (it marks moving objects in live
 * view). The similarly named enableDynamicAnalysis is the face-detection
 * setting and doesn't belong to motion documents.
 *
 * Detection targets are only the layout's comma-separated <targetType>, the
 * one shape applyMotionConfig writes and the one devices were seen sending.
 *
 * @param {XMLDocument} doc
 * @returns {MotionConfig}
 */
export function readMotionConfig(doc) {
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');
  const sensitivity = intText(layout, 'sensitivityLevel');
  const targetTypes = [...new Set((childText(layout, 'targetType') || '').split(',').map(t => t.trim()).filter(Boolean))];

  const gridEl = childElement(root, 'Grid');
  const rows = intText(gridEl, 'rowGranularity');
  const cols = intText(gridEl, 'columnGranularity');
  const gridMap = findDescendant(root, 'gridMap')?.textContent?.trim();
  const highlight = childText(root, 'enableHighlight');
  const screenWidth = parseInt(findDescendant(root, 'normalizedScreenWidth')?.textContent ?? '', 10);
  const screenHeight = parseInt(findDescendant(root, 'normalizedScreenHeight')?.textContent ?? '', 10);

  return {
    enabled: childText(root, 'enabled') === 'true',
    sensitivity: Number.isNaN(sensitivity) ? null : sensitivity,
    targetTypes,
    dynamicAnalysis: highlight === 'true',
    supportsDynamicAnalysis: highlight !== null,
    regionType: findDescendant(root, 'regionType')?.textContent?.trim() || null,
    grid: rows > 0 && cols > 0 && gridMap !== undefined
      ? { rows, cols, cells: decodeGridMap(gridMap, rows, cols) }
      : null,
    detectHuman: targetTypes.includes('human'),
    detectVehicle: targetTypes.includes('vehicle'),
    regions: childElements(xmlPath(layout, 'layout', 'RegionList'), 'Region')
      .map(readCoordinates)
      .filter(points => points.length >= 3),
    screen: screenWidth > 0 || screenHeight > 0
      ? { width: screenWidth > 0 ? screenWidth : MOTION_COORDINATE_SCALE, height: screenHeight > 0 ? screenHeight : MOTION_COORDINATE_SCALE }
      : null,
  };
}

/**
 * How the motion editor works on a camera: polygons ('region'), the cell
 * grid ('grid'), or the stored regions shown but not edited ('readonly'),
 * with the area sent back as loaded.
 * @typedef {'region'|'grid'|'readonly'} MotionEditMode
 */

/**
 * Which editor a camera's motion area gets.
 *
 * Polygons, in the 0–1000 space, only when the capabilities offer both
 * region and grid, as in Hikvision's web UI ("multi-region"). A camera that
 * offers region without grid is in the legacy ROI mode, whose rectangles
 * the web UI scales by normalizedScreenWidth/Height; so is a document that
 * declares a space other than 0–1000. No camera seen so far works that way,
 * so their regions are shown read-only rather than saved at a guessed scale.
 *
 * The grid when the capabilities offer only it. Without capabilities (or a
 * regionType list in them), the grid whenever the document has one, as the
 * web UI falls back to: saving polygons switches the camera to region mode
 * and zeroes its gridMap, which on a grid-only camera would wipe the real
 * detection area. Polygons then only for a document without a grid.
 * @param {MotionCapabilities} caps
 * @param {MotionConfig} md - the loaded document
 * @returns {MotionEditMode}
 */
export function motionEditMode(caps, md) {
  const usualScale = !md.screen ||
    (md.screen.width === MOTION_COORDINATE_SCALE && md.screen.height === MOTION_COORDINATE_SCALE);
  const types = caps.regionTypes;
  if (!types.length) {
    if (md.grid) return 'grid';
    return usualScale ? 'region' : 'readonly';
  }
  if (types.includes('region') && types.includes('grid')) return usualScale ? 'region' : 'readonly';
  return types.includes('grid') && md.grid ? 'grid' : 'readonly';
}

/**
 * Write motion settings into the device's MotionDetection document.
 *
 * Matches what Hikvision's own client sends: regionType switched to
 * "region" (the device ignores RegionList in grid mode), gridMap zeroed, and
 * each <Region> in an empty namespace (`<Region xmlns="">`).
 *
 * In grid mode (`mode: "grid"`, for cameras without polygon support) only
 * gridMap changes and the region list is left alone. In `mode: "readonly"`
 * the detection area (regionType, gridMap, RegionList) is sent back exactly
 * as loaded and `regions` is ignored.
 *
 * Detection targets go in the layout's <targetType> as a comma-separated
 * list ("human,vehicle", or empty for none), created in an empty namespace
 * when missing — again as the Hikvision client does. Pass `targetTypes`
 * only when the device supports targets.
 *
 * `dynamicAnalysis` goes in the root <enableHighlight> in both modes, and
 * only when the device sent that field (the web UI shows the toggle only then).
 * Without `sensitivity` (the camera doesn't say which levels it accepts) the
 * stored level is sent back as loaded.
 *
 * @param {XMLDocument} doc - edited in place
 * @param {{enabled: boolean, sensitivity?: number, dynamicAnalysis: boolean, regions: DevicePoint[][], targetTypes?: string[], mode?: MotionEditMode, grid?: MotionGrid}} config
 */
export function applyMotionConfig(doc, config) {
  const root = doc.documentElement;
  const layout = childElement(root, 'MotionDetectionLayout');

  setChildText(root, 'enabled', config.enabled);
  if (config.sensitivity !== undefined && !setChildText(layout, 'sensitivityLevel', config.sensitivity)) {
    const sens = findDescendant(root, 'sensitivityLevel');
    if (sens) sens.textContent = String(config.sensitivity);
  }
  writeTargetTypes(layout, config.targetTypes);
  setChildText(root, 'enableHighlight', config.dynamicAnalysis);
  if (config.mode === 'readonly') return;

  if (config.mode === 'grid') {
    const grid = config.grid;
    const gridMap = findDescendant(root, 'gridMap');
    if (!grid || !gridMap) throw new Error('This device did not return a motion grid, so the grid cannot be saved');
    gridMap.textContent = encodeGridMap(grid.cells, grid.cols);
    const regionType = findDescendant(root, 'regionType');
    if (regionType) regionType.textContent = 'grid';
    return;
  }

  const regionType = findDescendant(root, 'regionType');
  if (regionType) regionType.textContent = 'region';

  const gridMap = findDescendant(root, 'gridMap');
  if (gridMap) gridMap.textContent = '0'.repeat(gridMap.textContent.length);

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
 * The detection targets to save. The panel has a checkbox for only some
 * targets (person and vehicle); a camera can offer more (targetType@opt),
 * and Hikvision's web UI lets each be switched. So every target the panel
 * controls is saved as ticked, and every other one stays as the camera had
 * it, rather than being switched off without the user seeing it. Targets go
 * in the capabilities' order, as the web UI writes them; one the camera had
 * on that its capabilities don't list goes last, in the order it was stored.
 * @param {string[]} capTypes - the targets the camera offers (targetType@opt), in order
 * @param {string[]} loaded - the targets on in the document as loaded (MotionConfig.targetTypes)
 * @param {Partial<Record<string, boolean>>} chosen - each target the panel controls: ticked or not
 * @returns {string[]} what to pass as applyMotionConfig's `targetTypes`
 * @example
 * mergeTargetTypes(['human', 'vehicle', 'nonMotorVehicle'], ['nonMotorVehicle'], {human: true, vehicle: false})
 * // → ['human', 'nonMotorVehicle']
 */
export function mergeTargetTypes(capTypes, loaded, chosen) {
  /** @param {string} type */
  const isOn = type => chosen[type] ?? loaded.includes(type);
  return [...capTypes.filter(isOn), ...loaded.filter(type => !capTypes.includes(type))];
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
 * Where a stored privacy mask is on the picture, as the rectangle the
 * privacy tool keeps.
 *
 * Privacy coordinates are in the document's normalizedScreenSize units,
 * stretched over the whole picture, with Y measured from the BOTTOM: on the
 * DS-7604NI a region at positionY 432–576 masks the top quarter of the
 * picture. The picture has Y=0 at the top, so Y is flipped. The tool edits
 * rectangles, so a polygon becomes its bounding box.
 * @param {DevicePoint[]} points - one region, as readPrivacyMask returns it
 * @param {Size} screen - the document's normalizedScreenSize, or DEFAULT_PRIVACY_SCREEN
 * @returns {ImageRect}
 * @example
 * privacyRegionToImage([{x: 0, y: 432}, {x: 704, y: 576}], {width: 704, height: 576})
 * // → {x: 0, y: 0, w: 1, h: 0.25}: the top quarter
 */
export function privacyRegionToImage(points, screen) {
  const box = boundingBox(points.map(p => ({
    x: clamp(p.x, 0, screen.width),
    y: clamp(p.y, 0, screen.height),
  })));
  return {
    x: box.minX / screen.width,
    y: 1 - box.maxY / screen.height,
    w: (box.maxX - box.minX) / screen.width,
    h: (box.maxY - box.minY) / screen.height,
  };
}

/**
 * A rectangle on the picture as the device rectangle to save: the inverse
 * of privacyRegionToImage, rounded to whole units and clamped to the
 * screen. Y counts from the bottom, so y1 (the top edge) is the larger.
 * @param {ImageRect} rect
 * @param {Size} screen - the document's normalizedScreenSize, or DEFAULT_PRIVACY_SCREEN
 * @returns {DeviceRect}
 * @example
 * imageRectToPrivacy({x: 0, y: 0, w: 1, h: 0.25}, {width: 704, height: 576})
 * // → {x1: 0, y1: 576, x2: 704, y2: 432}
 */
export function imageRectToPrivacy(rect, screen) {
  /** @param {number} fx - fraction of the picture's width */
  const toX = fx => clamp(Math.round(fx * screen.width), 0, screen.width);
  /** @param {number} fy - fraction of the picture's height, from the top */
  const toY = fy => clamp(Math.round((1 - fy) * screen.height), 0, screen.height);
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
 * One notification entry the UI switches on or off. Untargeted methods
 * (center, email, beep) have one entry per trigger. Targeted ones have one
 * entry per target — record channel 3, switch output 301, flash channel 3's
 * light — and a trigger may hold several (the web UI can link motion on one
 * camera to another camera's recording or relay), so a toggle must touch
 * only the entry for its own target.
 * @typedef {object} NotificationSpec
 * @property {string} method - <notificationMethod>, e.g. "record", "IO", "whiteLightOut"
 * @property {string} id - <id> of a new entry, e.g. "record-3", "IO-301", "center"
 * @property {string|null} target - the channel or port the entry points at; null for untargeted methods
 * @property {string[]} matchFields - where an existing entry may name the target (any of them counts)
 * @property {string[]} writeFields - where a new entry names the target
 */

/**
 * An untargeted method, written as Hikvision's web UI and SDK write it:
 * the method name is also the entry's id.
 * @param {string} method - e.g. "center"
 * @returns {NotificationSpec}
 */
export function methodNotification(method) {
  return { method, id: method, target: null, matchFields: [], writeFields: [] };
}

/**
 * Recording of one channel. Any entry recording that channel counts,
 * whether it names it by videoInputID or dynVideoInputID; a new entry names
 * it the way the trigger names its own channel (dyn* for IP channels behind
 * an NVR, as the web UI and SDK do).
 * @param {XMLDocument} doc - the trigger
 * @param {string} channelId
 * @returns {NotificationSpec}
 */
export function recordNotification(doc, channelId) {
  const root = doc.documentElement;
  /** @type {string[]} */
  const writeFields = [];
  if (childElement(root, 'videoInputChannelID')) writeFields.push('videoInputID');
  if (childElement(root, 'dynVideoInputChannelID')) writeFields.push('dynVideoInputID');
  if (writeFields.length === 0) writeFields.push('videoInputID');
  return {
    method: 'record', id: `record-${channelId}`, target: channelId,
    matchFields: ['videoInputID', 'dynVideoInputID'], writeFields,
  };
}

/**
 * An alarm output port, and the field that addresses it in a notification.
 * @typedef {{port: string, field: 'outputIOPortID'|'dynOutputIOPortID'}} AlarmOutputTarget
 */

/**
 * Switching one alarm output, e.g. <id>IO-301</id> with
 * <dynOutputIOPortID>301</dynOutputIOPortID>. An existing entry for the port
 * counts whichever field names it.
 * @param {AlarmOutputTarget} output
 * @returns {NotificationSpec}
 */
export function alarmOutputNotification({ port, field }) {
  return {
    method: 'IO', id: `IO-${port}`, target: port,
    matchFields: ['outputIOPortID', 'dynOutputIOPortID'], writeFields: [field],
  };
}

/**
 * Flashing the white light, or sounding the speaker, of the camera on an NVR
 * channel: <id>whiteLightOut-3</id>, <notificationMethod>whiteLightOut</…>,
 * <lightAudioOutID>3</…> (audioOut likewise). This is what the DS-7604NI's
 * web UI writes and the device accepted in write tests.
 * @param {'whiteLightOut'|'audioOut'} method
 * @param {string} channelId
 * @returns {NotificationSpec}
 */
export function lightAudioNotification(method, channelId) {
  return {
    method, id: `${method}-${channelId}`, target: channelId,
    matchFields: ['lightAudioOutID'], writeFields: ['lightAudioOutID'],
  };
}

/**
 * The trigger's entries a spec stands for: same method, and for a targeted
 * spec, naming the same target.
 * @param {XMLDocument} doc
 * @param {NotificationSpec} spec
 * @returns {Element[]}
 */
function matchingNotifications(doc, spec) {
  return triggerNotifications(doc).filter(n =>
    childText(n, 'notificationMethod') === spec.method &&
    (spec.target === null || spec.matchFields.some(field => childText(n, field) === spec.target)));
}

/**
 * Whether the trigger has the entry a spec stands for, i.e. whether its
 * toggle is on.
 * @param {XMLDocument} doc
 * @param {NotificationSpec} spec
 * @returns {boolean}
 */
export function hasNotification(doc, spec) {
  return matchingNotifications(doc, spec).length > 0;
}

/**
 * Switch notification entries on or off on an EventTrigger document. Only
 * the entries the specs stand for change: other methods (FTP, monitorAlarm,
 * ...), other targets of the same method (another channel's recording,
 * another output) and existing entries' own fields are sent back as
 * received.
 *
 * New entries follow the trigger's own convention for
 * <notificationRecurrence>: camera firmware puts it on every entry, so new
 * ones copy the first existing value; the DS-7604NI, its web UI and the SDK
 * never use it (the NVR drops it on save), so there new ones get none.
 *
 * @param {XMLDocument} doc - edited in place
 * @param {{spec: NotificationSpec, enabled: boolean}[]} changes
 * @example
 * applyNotifications(doc, [{spec: alarmOutputNotification({port: '301', field: 'dynOutputIOPortID'}), enabled: true}])
 */
export function applyNotifications(doc, changes) {
  const root = doc.documentElement;
  const list = childElement(root, 'EventTriggerNotificationList') ?? appendElement(root, 'EventTriggerNotificationList');
  const recurrence = triggerNotifications(doc)
    .map(n => childText(n, 'notificationRecurrence'))
    .find(value => value !== null) ?? null;

  for (const { spec, enabled } of changes) {
    const existing = matchingNotifications(doc, spec);
    if (!enabled) {
      existing.forEach(n => n.remove());
    } else if (existing.length === 0) {
      const n = appendElement(list, 'EventTriggerNotification');
      appendElement(n, 'id', spec.id);
      appendElement(n, 'notificationMethod', spec.method);
      if (recurrence !== null) appendElement(n, 'notificationRecurrence', recurrence);
      if (spec.target !== null) spec.writeFields.forEach(field => appendElement(n, field, /** @type {string} */ (spec.target)));
    }
  }
}

/* ── Event actions a device and channel offer ───────────────────────────── */

/**
 * Motion-event action flags from /ISAPI/Event/triggersCap: the
 * MotionDetectionTriggerCap block's children by name, e.g.
 * {isSupportRecord: true, isSupportWhiteLightOut: true}. Hikvision's web UI
 * offers only the actions flagged true. Null when the document has no such
 * block, which means "unknown", not "nothing supported".
 * @param {XMLDocument|null} doc
 * @returns {Record<string, boolean>|null}
 */
export function readMotionTriggerCap(doc) {
  const block = findDescendant(doc?.documentElement, 'MotionDetectionTriggerCap');
  if (!block) return null;
  return Object.fromEntries(Array.from(block.children, el => [el.localName, (el.textContent ?? '').trim() === 'true']));
}

/**
 * A relay an event can switch.
 * @typedef {object} AlarmOutput
 * @property {string} id - port id, e.g. "1" for a device's own relay, "301" for an IP camera's behind an NVR
 * @property {'local'|'digital'|'analog'} type - on the device itself, on an IP camera, or on an analog channel
 * @property {string|null} ipAddress - the IP camera a digital output belongs to
 */

/** @type {Record<string, AlarmOutput['type']>} */
const IO_TYPES = { local: 'local', digitalChannel: 'digital', analogChannel: 'analog' };

/**
 * Alarm outputs listed by /ISAPI/System/IO/outputs or
 * /ISAPI/ContentMgmt/IOProxy/outputs. Like Hikvision's web UI, leaves out
 * the pseudo outputs that stand for a camera's white light or speaker
 * (IOUseType whiteLight / audio, e.g. 302 and 303 on the DS-7604NI) and
 * analog outputs that are switched off (IOUseType disable). A digital output
 * marked "disable" is still a working relay: the DS-7604NI reports its
 * cameras' relays 301 and 401 that way.
 * @param {XMLDocument} doc - IOOutputPortList or IOProxyOutputPortList
 * @param {AlarmOutput['type']|null} untyped - the type of ports without a known <IOType>; null leaves them out
 * @returns {AlarmOutput[]}
 */
export function readAlarmOutputs(doc, untyped) {
  return Array.from(doc.documentElement.children).flatMap(port => {
    if (port.localName !== 'IOOutputPort' && port.localName !== 'IOProxyOutputPort') return [];
    const id = childText(port, 'id');
    const type = IO_TYPES[childText(port, 'IOType') ?? ''] ?? untyped;
    const use = childText(port, 'IOUseType');
    if (!id || !type || use === 'whiteLight' || use === 'audio' || (type === 'analog' && use === 'disable')) return [];
    return [{ id, type, ipAddress: childText(childElement(port, 'IODescriptor'), 'ipAddress') || null }];
  });
}

/**
 * Channels whose camera has a white light or a speaker the NVR can switch,
 * from GET /ISAPI/Event/triggers/notifications/channels/whiteLightAlarm (or
 * AudioAlarm) ?format=json, e.g. {"WhiteLightAlarmList": [{"channelID": 3,
 * …}]}. Hikvision's web UI offers those actions for exactly these channels.
 * @param {unknown} json
 * @param {'WhiteLightAlarmList'|'AudioAlarmList'} listName
 * @returns {Set<string>} channel ids
 */
export function readLightAudioChannels(json, listName) {
  const list = json !== null && typeof json === 'object' ? /** @type {Record<string, unknown>} */ (json)[listName] : null;
  /** @type {Set<string>} */
  const channels = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const id = entry !== null && typeof entry === 'object' ? /** @type {{channelID?: unknown}} */ (entry).channelID : null;
    if (typeof id === 'number' || typeof id === 'string') channels.add(String(id));
  }
  return channels;
}

/**
 * What a device offers for motion-event actions, read once per connection
 * (Isapi.getEventActionSupport).
 * @typedef {object} EventActionSupport
 * @property {Record<string, boolean>|null} triggerCap - readMotionTriggerCap; null when unknown
 * @property {AlarmOutput[]} alarmOutputs - relays an event can switch
 * @property {Set<string>} whiteLightChannels - channels whose camera has a light the NVR can switch
 * @property {Set<string>} audioChannels - channels whose camera has a speaker the NVR can sound
 */

/** @typedef {'record'|'center'|'email'|'beep'|'IO'|'whiteLight'|'audio'} EventActionKey */

/**
 * Why an action can't be used on a channel: the device doesn't offer it for
 * motion events (notSupported), or it does but this channel's camera has no
 * relay, light or speaker to point it at.
 * @typedef {'notSupported'|'noAlarmOutput'|'noWhiteLight'|'noSpeaker'} EventActionUnavailable
 */

/**
 * An action resolved for one channel: the entry its toggle reads and writes
 * (null when there is nothing to point it at), and why it can't be used, if
 * it can't. An unavailable action with a spec still shows its state.
 * @typedef {{spec: NotificationSpec|null, unavailable: EventActionUnavailable|null}} EventActionTarget
 */

/**
 * Resolve each motion-event action for one channel: which notification entry
 * its toggle stands for, or why it's unavailable.
 *
 * - With triggersCap, an action is offered only when its MotionDetectionTriggerCap
 *   flag is true, as in Hikvision's web UI. Without it, everything is offered,
 *   as this extension always did.
 * - Record records this channel.
 * - Alarm Output switches the channel's own camera relay (an output on the
 *   camera's IP address, e.g. DS-7604NI channel 3 → 301), else the device's
 *   first local output, else nothing.
 * - White Light and Audio Alarm, on a device whose triggersCap names
 *   isSupportWhiteLightOut or isSupportAudioOut (NVRs), switch the channel's
 *   own camera, if the NVR lists it; one of the two the device doesn't flag
 *   true is unavailable. A device that names neither flag keeps the bare
 *   "whiteLight" / "audio" methods this extension always wrote. Those are
 *   unverified: the DS-7604NI rejects them (badXmlContent, failing the whole
 *   save), and no standalone camera has been tested.
 *
 * @param {XMLDocument} doc - the channel's trigger, for how it names channels
 * @param {EventActionSupport} support
 * @param {{id: string, ipAddress?: string}} channel
 * @returns {Record<EventActionKey, EventActionTarget>}
 */
export function resolveEventActions(doc, support, channel) {
  const cap = support.triggerCap;
  /**
   * @param {NotificationSpec|null} spec
   * @param {string} flag
   * @param {EventActionUnavailable} [missing] - why, when there's no spec
   * @returns {EventActionTarget}
   */
  const gate = (spec, flag, missing = 'notSupported') => ({
    spec,
    unavailable: cap !== null && cap[flag] !== true ? 'notSupported' : spec ? null : missing,
  });
  const output = alarmOutputFor(support.alarmOutputs, channel.ipAddress, cap?.isSupportIOOutputUnify === true);
  // Either flag marks a device that addresses lights and speakers per camera,
  // so neither action may fall back to the bare method there
  const outFlavour = cap !== null && ('isSupportWhiteLightOut' in cap || 'isSupportAudioOut' in cap);
  /** @param {string} flag */
  const outFlag = flag => (outFlavour ? cap?.[flag] === true : undefined);

  return {
    record: gate(recordNotification(doc, channel.id), 'isSupportRecord'),
    center: gate(methodNotification('center'), 'isSupportCenter'),
    email: gate(methodNotification('email'), 'isSupportEmail'),
    beep: gate(methodNotification('beep'), 'isSupportBeep'),
    IO: gate(output && alarmOutputNotification(output), 'isSupportIO', 'noAlarmOutput'),
    whiteLight: lightAudioAction(outFlag('isSupportWhiteLightOut'), 'whiteLight', 'whiteLightOut',
      support.whiteLightChannels, channel.id, 'noWhiteLight'),
    audio: lightAudioAction(outFlag('isSupportAudioOut'), 'audio', 'audioOut',
      support.audioChannels, channel.id, 'noSpeaker'),
  };
}

/**
 * The alarm output motion on a channel switches by default, in the order
 * resolveEventActions describes, and how to address it: <outputIOPortID>
 * for the device's own ports, or for every port when the device unifies
 * them (isSupportIOOutputUnify); <dynOutputIOPortID> for IP cameras' ports.
 * @param {AlarmOutput[]} outputs
 * @param {string|undefined} ipAddress - the channel's camera, for IP channels
 * @param {boolean} unify
 * @returns {AlarmOutputTarget|null}
 */
function alarmOutputFor(outputs, ipAddress, unify) {
  const own = ipAddress ? outputs.find(o => o.type === 'digital' && o.ipAddress === ipAddress) : undefined;
  const output = own ?? outputs.find(o => o.type === 'local');
  if (!output) return null;
  return { port: output.id, field: output.type === 'digital' && !unify ? 'dynOutputIOPortID' : 'outputIOPortID' };
}

/**
 * White Light or Audio Alarm for one channel (see resolveEventActions).
 * @param {boolean|undefined} flag - the device's isSupport…Out flag (false when only the other one is
 *   named); undefined when it names neither
 * @param {string} bareMethod - what devices without the flag get
 * @param {'whiteLightOut'|'audioOut'} outMethod
 * @param {Set<string>} channels - channels the NVR lists for this action
 * @param {string} channelId
 * @param {EventActionUnavailable} missing
 * @returns {EventActionTarget}
 */
function lightAudioAction(flag, bareMethod, outMethod, channels, channelId, missing) {
  if (flag === undefined) return { spec: methodNotification(bareMethod), unavailable: null };
  if (!flag) return { spec: null, unavailable: 'notSupported' };
  return channels.has(channelId)
    ? { spec: lightAudioNotification(outMethod, channelId), unavailable: null }
    : { spec: null, unavailable: missing };
}
