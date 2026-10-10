/**
 * Shared UI state and cached DOM elements for the config page.
 */

/** @typedef {import('../lib/digest-auth.js').DeviceConfig} DeviceConfig */
/** @typedef {import('../lib/isapi.js').Channel} Channel */
/** @typedef {import('../lib/config-xml.js').MotionCapabilities} MotionCapabilities */

/** A point in canvas pixels. @typedef {{x: number, y: number}} CanvasPoint */
/** A rectangle in canvas pixels. @typedef {{x: number, y: number, w: number, h: number}} CanvasRect */

/**
 * Everything the page keeps between events. Tool fields are filled in by
 * each tool's initState() when the registry starts (see tools/registry.js).
 * @typedef {object} AppState
 * @property {DeviceConfig|null} config - connection details while connected
 * @property {boolean} connected
 * @property {Channel[]} channels
 * @property {string|null} activeChannel - id of the selected channel
 * @property {string|null} activeTool - id of the active config tool
 * @property {boolean} isDrawing - a privacy rectangle drag is in progress
 * @property {CanvasPoint|null} drawStart
 * @property {CanvasPoint|null} drawCurrent
 * @property {CanvasPoint|null} mousePos - last pointer position over the canvas
 * @property {(() => void)|null} stopSnapshotFeed - stops the single-view loop
 * @property {'main'|'sub'} streamType - single view: main (HD) or sub (SD) stream
 * @property {number[]} frameTimes - when recent frames arrived, for the FPS readout
 * @property {'single'|'grid'} viewMode
 * @property {((() => void)|null)[]} gridFeedStops - per-cell loop stoppers
 * @property {(string|null)[]} gridCellChannels - channel id per grid cell
 * @property {'liveview'|'config'} activeSection
 * @property {number|null} gridExpandedCell - maximized grid cell
 * @property {boolean} configExpanded
 * @property {AbortController|null} scanAbort - cancels a running network scan
 *
 * Motion detection tool
 * @property {{points: CanvasPoint[]}[]} motionRegions
 * @property {CanvasPoint[]} drawingPoints - corners of the polygon being drawn
 * @property {MotionCapabilities} motionCaps - device limits, refreshed on load
 * @property {boolean} motionEnabled
 * @property {number} sensitivity
 * @property {boolean} dynamicAnalysis
 * @property {boolean} detectHuman
 * @property {boolean} detectVehicle
 * @property {XMLDocument|null} motionDoc - device XML from the last load
 *
 * Privacy mask tool
 * @property {boolean} privacyEnabled
 * @property {CanvasRect[]} privacyRegions
 * @property {number} privacyNormW - device coordinate space width
 * @property {number} privacyNormH
 * @property {XMLDocument|null} privacyDoc
 * @property {string|null} privacyPath - URL the privacy config came from
 *
 * Event actions tool
 * @property {Record<string, boolean>} eventActions - enabled actions by key
 * @property {XMLDocument|null} eventTriggerDoc
 */

// Tool fields are added by initToolRegistry() before anything reads them,
// hence the cast through unknown.
/** @type {AppState} */
export const state = /** @type {AppState} */ (/** @type {unknown} */ ({
  config: null,
  connected: false,
  channels: [],
  activeChannel: null,
  activeTool: null,
  isDrawing: false,
  drawStart: null,
  drawCurrent: null,
  mousePos: null,
  stopSnapshotFeed: null,
  streamType: 'sub',
  frameTimes: [],
  viewMode: 'single',
  gridFeedStops: [null, null, null, null],
  gridCellChannels: [null, null, null, null],
  activeSection: 'liveview',
  gridExpandedCell: null,
  configExpanded: false,
  scanAbort: null,
}));

/**
 * Look up an element that the page markup must contain. Throws on a missing
 * or mistyped element, so markup and code drifting apart fails loudly at
 * startup rather than as a null error later.
 * @template {HTMLElement} [T=HTMLElement]
 * @param {string} id
 * @param {{ new (): T }} [type] - expected element class, e.g. HTMLInputElement
 * @returns {T}
 */
export function byId(id, type) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  if (type && !(el instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return /** @type {T} */ (el);
}

/**
 * All elements under `root` matching `selector`, as HTML elements.
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
export function queryAll(root, selector) {
  return Array.from(root.querySelectorAll(selector)).filter(el => el instanceof HTMLElement);
}

/**
 * The first element under `root` matching `selector`; throws if there is none.
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} selector
 * @param {{ new (): T }} [type]
 * @returns {T}
 */
export function query(root, selector, type) {
  const el = root.querySelector(selector);
  if (!(el instanceof (type ?? HTMLElement))) throw new Error(`Missing ${selector}`);
  return /** @type {T} */ (el);
}

// ─── DOM Cache ──────────────────────────────────────────────────────────────
export const dom = {
  canvas: byId('drawCanvas', HTMLCanvasElement),
  canvasContainer: byId('canvasContainer'),
  canvasWrapper: byId('canvasWrapper'),
  gridView: byId('gridView'),
  noFeed: byId('noFeed'),
  videoFeed: byId('videoFeed', HTMLImageElement),
  statusDot: byId('statusDot'),
  deviceInfo: byId('deviceInfo'),
  statusText: byId('statusText'),
  statusRight: byId('statusRight'),
  toast: byId('toast'),
  configPanels: byId('configPanels'),
  configArrow: byId('configArrow'),
  configToggleLabel: byId('configToggleLabel'),
  toolConfigSection: byId('toolConfigSection'),
  channelsSection: byId('channelsSection'),
  sectionTabs: byId('sectionTabs'),
  toolTabs: byId('toolTabs'),
  liveViewTabs: byId('liveViewTabs'),
  configTabs: byId('configTabs'),
  connectionStatus: byId('connectionStatus'),
  connectedHost: byId('connectedHost'),
  // Scan elements
  scanIntro: byId('scanIntro'),
  scanProgress: byId('scanProgress'),
  scanResults: byId('scanResults'),
  connectionForm: byId('connectionForm'),
  scanProgressFill: byId('scanProgressFill'),
  scanStatusText: byId('scanStatusText'),
  scanResultsText: byId('scanResultsText'),
  scanDeviceList: byId('scanDeviceList'),
  // Form elements
  hostInput: byId('hostInput', HTMLInputElement),
  portInput: byId('portInput', HTMLInputElement),
  userInput: byId('userInput', HTMLInputElement),
  passInput: byId('passInput', HTMLInputElement),
  savePassCheck: byId('savePassCheck', HTMLInputElement),
  connectBtn: byId('connectBtn', HTMLButtonElement),
  channelList: byId('channelList'),
};

const context = dom.canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D context unavailable');
export const ctx = context;
