/**
 * Shared UI state and cached DOM elements for the config page.
 */

// ─── State ──────────────────────────────────────────────────────────────────
export const state = {
  config: null,
  connected: false,
  channels: [],
  activeChannel: null,
  activeTool: null, // set by initToolRegistry()
  // Drawing state (shared across tools)
  isDrawing: false,
  drawStart: null,
  drawCurrent: null,
  paintValue: true,
  // Video
  stopSnapshotFeed: null, // stops the single-view snapshot loop
  // 4-cam grid view
  viewMode: 'single', // 'single' or 'grid'
  gridFeedStops: [null, null, null, null], // per-cell snapshot loop stoppers
  gridCellChannels: [null, null, null, null],
  // Section navigation
  activeSection: 'liveview', // 'liveview' or 'config'
  gridExpandedCell: null,
  // UI state (formerly loose variables)
  configExpanded: false,
  scanAbort: null, // AbortController for a running network scan
};

// ─── DOM Cache ──────────────────────────────────────────────────────────────
export const dom = {
  canvas: document.getElementById('drawCanvas'),
  canvasContainer: document.getElementById('canvasContainer'),
  canvasWrapper: document.getElementById('canvasWrapper'),
  gridView: document.getElementById('gridView'),
  noFeed: document.getElementById('noFeed'),
  videoFeed: document.getElementById('videoFeed'),
  statusDot: document.getElementById('statusDot'),
  deviceInfo: document.getElementById('deviceInfo'),
  statusText: document.getElementById('statusText'),
  statusRight: document.getElementById('statusRight'),
  toast: document.getElementById('toast'),
  configPanels: document.getElementById('configPanels'),
  configArrow: document.getElementById('configArrow'),
  configToggleLabel: document.getElementById('configToggleLabel'),
  toolConfigSection: document.getElementById('toolConfigSection'),
  channelsSection: document.getElementById('channelsSection'),
  sectionTabs: document.getElementById('sectionTabs'),
  toolTabs: document.getElementById('toolTabs'),
  liveViewTabs: document.getElementById('liveViewTabs'),
  configTabs: document.getElementById('configTabs'),
  connectionStatus: document.getElementById('connectionStatus'),
  connectedHost: document.getElementById('connectedHost'),
  // Scan elements
  scanIntro: document.getElementById('scanIntro'),
  scanProgress: document.getElementById('scanProgress'),
  scanResults: document.getElementById('scanResults'),
  connectionForm: document.getElementById('connectionForm'),
  scanProgressFill: document.getElementById('scanProgressFill'),
  scanStatusText: document.getElementById('scanStatusText'),
  scanResultsText: document.getElementById('scanResultsText'),
  scanDeviceList: document.getElementById('scanDeviceList'),
  // Form elements
  hostInput: document.getElementById('hostInput'),
  portInput: document.getElementById('portInput'),
  userInput: document.getElementById('userInput'),
  passInput: document.getElementById('passInput'),
  savePassCheck: document.getElementById('savePassCheck'),
  connectBtn: document.getElementById('connectBtn'),
  channelList: document.getElementById('channelList'),
};
export const ctx = dom.canvas.getContext('2d');
