/**
 * Hikvision Config Tool — Chrome Extension UI
 *
 * All NVR communication goes through chrome.runtime.sendMessage() to the
 * background service worker, which handles Digest auth and ISAPI calls.
 *
 * Configuration tools (motion detection, privacy mask, etc.) are registered
 * via ToolRegistry.register(). New tools can be added without modifying
 * existing code — just call register() with a tool definition object.
 */

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
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
  snapshotInterval: null,
  // 4-cam grid view
  viewMode: 'single', // 'single' or 'grid'
  gridSnapIntervals: [],
  gridCellChannels: [null, null, null, null],
  // Section navigation
  activeSection: 'liveview', // 'liveview' or 'config'
  gridExpandedCell: null,
  // UI state (formerly loose variables)
  configExpanded: false,
  scanProgressInterval: null,
};

// ─── DOM Cache ──────────────────────────────────────────────────────────────
const dom = {
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
const ctx = dom.canvas.getContext('2d');

// ─── Tool Registry ──────────────────────────────────────────────────────────
/**
 * Central registry for configuration tools.
 * Each tool registers itself with a definition object containing UI, canvas
 * handlers, and ISAPI operations. The registry drives tab generation, sidebar
 * panel rendering, canvas event delegation, and keyboard shortcuts.
 *
 * Tool definition shape:
 * {
 *   id: string,              // unique key, e.g. 'motion'
 *   label: string,           // display name, e.g. 'Motion Detection'
 *   panelHTML: string,       // sidebar panel inner HTML
 *   cursor: string,          // CSS cursor for canvas (default: 'crosshair')
 *   initState: () => object, // returns initial tool-specific state keys
 *   resetState: () => void,  // called on channel switch / disconnect
 *   draw: (ctx, canvas) => void,
 *   onMouseDown: (pos, e) => void,
 *   onMouseMove: (pos, e) => void,
 *   onMouseUp: (pos, e) => void,
 *   load: () => Promise,     // load config from device
 *   save: () => Promise,     // save config to device
 *   bindPanel: () => void,   // bind DOM events after panel HTML is injected
 *   onActivate: () => void,  // called when tool becomes the active tool
 * }
 */
const ToolRegistry = {
  _tools: new Map(),
  _order: [],

  register(def) {
    this._tools.set(def.id, def);
    this._order.push(def.id);
  },

  get(id) { return this._tools.get(id); },
  getAll() { return this._order.map(id => this._tools.get(id)); },
  first() { return this._tools.get(this._order[0]); },
};

// ─── Utility Functions ──────────────────────────────────────────────────────

/** Send a message to the background service worker. */
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response) {
        reject(new Error('No response from background'));
      } else if (!response.success) {
        reject(new Error(response.error || 'Unknown error'));
      } else {
        resolve(response);
      }
    });
  });
}

function showToast(msg, type = 'info') {
  dom.toast.textContent = msg;
  dom.toast.className = `toast ${type} show`;
  setTimeout(() => dom.toast.classList.remove('show'), 3000);
}

function setStatus(text, right = '') {
  dom.statusText.textContent = text;
  dom.statusRight.textContent = right;
}

/** Stop all 4-cam grid snapshot intervals. */
function stopAllGridFeeds() {
  state.gridSnapIntervals.forEach(id => id && clearInterval(id));
  state.gridSnapIntervals = [null, null, null, null];
}

function getCanvasPos(e) {
  const rect = dom.canvas.getBoundingClientRect();
  const scaleX = dom.canvas.width / rect.width;
  const scaleY = dom.canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function getGridCell(pos) {
  const cellW = dom.canvas.width / state.gridCols;
  const cellH = dom.canvas.height / state.gridRows;
  return {
    col: Math.floor(pos.x / cellW),
    row: Math.floor(pos.y / cellH),
  };
}

// ─── Motion Detection Grid Helpers ──────────────────────────────────────────

function initGrid() {
  state.grid = Array.from({ length: state.gridRows }, () =>
    Array.from({ length: state.gridCols }, () => false)
  );
}

function gridToHex() {
  let hex = '';
  for (let r = 0; r < state.gridRows; r++) {
    let rowBits = '';
    for (let c = 0; c < state.gridCols; c++) {
      rowBits += state.grid[r][c] ? '1' : '0';
    }
    while (rowBits.length % 4 !== 0) rowBits += '0';
    for (let i = 0; i < rowBits.length; i += 4) {
      hex += parseInt(rowBits.substr(i, 4), 2).toString(16);
    }
  }
  return hex;
}

function hexToGrid(hexStr) {
  initGrid();
  if (!hexStr) return;
  const charsPerRow = Math.ceil(state.gridCols / 4);
  hexStr = hexStr.toLowerCase().replace(/[^0-9a-f]/g, '');
  for (let r = 0; r < state.gridRows; r++) {
    const rowHex = hexStr.substr(r * charsPerRow, charsPerRow);
    if (!rowHex) continue;
    let bits = '';
    for (let i = 0; i < rowHex.length; i++) {
      bits += parseInt(rowHex[i], 16).toString(2).padStart(4, '0');
    }
    for (let c = 0; c < state.gridCols; c++) {
      if (c < bits.length) state.grid[r][c] = bits[c] === '1';
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Motion Detection
// ═══════════════════════════════════════════════════════════════════════════

ToolRegistry.register({
  id: 'motion',
  label: 'Motion Detection',
  cursor: 'crosshair',

  panelHTML: `
    <div class="toggle-row">
      <span>Motion Detection</span>
      <div class="toggle" id="motionToggle"></div>
    </div>
    <div class="slider-group">
      <label>Sensitivity <span id="sensitivityVal">50</span></label>
      <input type="range" id="sensitivitySlider" min="0" max="100" value="50" />
    </div>
    <div class="instructions">
      <strong>Click cells</strong> in the grid overlay to toggle motion detection zones.
      <strong>Click &amp; drag</strong> to paint multiple cells.
    </div>
    <div class="legend">
      <div class="legend-item">
        <div class="legend-swatch" style="background:rgba(74,108,247,0.45)"></div>
        Active zone
      </div>
      <div class="legend-item">
        <div class="legend-swatch" style="background:transparent; border-color:rgba(255,255,255,0.15)"></div>
        Inactive
      </div>
    </div>
    <div class="btn-group">
      <button class="btn" id="selectAllBtn">Select All</button>
      <button class="btn" id="clearAllBtn">Clear All</button>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary btn-block" id="loadMotionBtn">Load from Device</button>
    </div>
    <div class="btn-group">
      <button class="btn btn-success btn-block" id="saveMotionBtn">Save to Device</button>
    </div>
  `,

  initState() {
    return {
      gridCols: 22,
      gridRows: 18,
      grid: [],
      motionEnabled: false,
      sensitivity: 50,
      rawMotionXml: null,
    };
  },

  resetState() {
    initGrid();
  },

  draw(ctx, canvas) {
    const cellW = canvas.width / state.gridCols;
    const cellH = canvas.height / state.gridRows;

    // Fill active cells
    for (let r = 0; r < state.gridRows; r++) {
      for (let c = 0; c < state.gridCols; c++) {
        if (state.grid[r][c]) {
          ctx.fillStyle = 'rgba(74, 108, 247, 0.35)';
          ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
        }
      }
    }

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 0.3;
    for (let r = 0; r <= state.gridRows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellH);
      ctx.lineTo(canvas.width, r * cellH);
      ctx.stroke();
    }
    for (let c = 0; c <= state.gridCols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, 0);
      ctx.lineTo(c * cellW, canvas.height);
      ctx.stroke();
    }
  },

  onMouseDown(pos, e) {
    state.isDrawing = true;
    const cell = getGridCell(pos);
    if (cell.row >= 0 && cell.row < state.gridRows && cell.col >= 0 && cell.col < state.gridCols) {
      state.paintValue = !state.grid[cell.row][cell.col];
      state.grid[cell.row][cell.col] = state.paintValue;
      redraw();
    }
  },

  onMouseMove(pos, e) {
    const cell = getGridCell(pos);
    if (cell.row >= 0 && cell.row < state.gridRows && cell.col >= 0 && cell.col < state.gridCols) {
      state.grid[cell.row][cell.col] = state.paintValue;
      redraw();
    }
  },

  onMouseUp(pos, e) {
    // Paint mode — nothing special on mouseup
  },

  async load() {
    if (!state.config || !state.activeChannel) return;
    setStatus('Loading motion detection config...');
    try {
      const data = await sendMsg({
        action: 'getMotionDetection',
        config: state.config,
        channelId: state.activeChannel,
      });

      const md = data.motionDetection;
      state.rawMotionXml = data.rawXml;

      state.motionEnabled = md.enabled === 'true';
      document.getElementById('motionToggle').classList.toggle('on', state.motionEnabled);

      const sensLayout = md.MotionDetectionLayout;
      if (sensLayout) {
        const sens = parseInt(sensLayout.sensitivityLevel) || 50;
        state.sensitivity = sens;
        document.getElementById('sensitivitySlider').value = sens;
        document.getElementById('sensitivityVal').textContent = sens;

        const gridMap = sensLayout.layout?.gridMap;
        if (gridMap) hexToGrid(gridMap);
      }

      if (md.Grid) {
        const rows = parseInt(md.Grid.rowGranularity);
        const cols = parseInt(md.Grid.columnGranularity);
        if (rows && cols) {
          state.gridRows = rows;
          state.gridCols = cols;
          if (sensLayout?.layout?.gridMap) {
            hexToGrid(sensLayout.layout.gridMap);
          }
        }
      }

      redraw();
      showToast('Motion detection config loaded', 'success');
      setStatus('Config loaded', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to load motion config: ' + err.message, 'error');
      setStatus('Failed to load config');
    }
  },

  async save() {
    if (!state.config || !state.activeChannel) return;

    const sensitivity = document.getElementById('sensitivitySlider').value;
    const hexGrid = gridToHex();

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MotionDetection version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <enabled>${state.motionEnabled}</enabled>
  <enableHighlight>true</enableHighlight>
  <samplingInterval>2</samplingInterval>
  <startTriggerTime>500</startTriggerTime>
  <endTriggerTime>500</endTriggerTime>
  <regionType>grid</regionType>
  <Grid>
    <rowGranularity>${state.gridRows}</rowGranularity>
    <columnGranularity>${state.gridCols}</columnGranularity>
  </Grid>
  <MotionDetectionLayout version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
    <sensitivityLevel>${sensitivity}</sensitivityLevel>
    <layout>
      <gridMap>${hexGrid}</gridMap>
    </layout>
  </MotionDetectionLayout>
</MotionDetection>`;

    setStatus('Saving motion detection config...');
    try {
      await sendMsg({
        action: 'putMotionDetection',
        config: state.config,
        channelId: state.activeChannel,
        xml,
      });
      showToast('Motion detection saved successfully!', 'success');
      setStatus('Config saved', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'error');
      setStatus('Save failed');
    }
  },

  bindPanel() {
    document.getElementById('motionToggle').addEventListener('click', () => {
      state.motionEnabled = !state.motionEnabled;
      document.getElementById('motionToggle').classList.toggle('on', state.motionEnabled);
    });

    document.getElementById('sensitivitySlider').addEventListener('input', function () {
      document.getElementById('sensitivityVal').textContent = this.value;
    });

    document.getElementById('selectAllBtn').addEventListener('click', () => {
      for (let r = 0; r < state.gridRows; r++)
        for (let c = 0; c < state.gridCols; c++)
          state.grid[r][c] = true;
      redraw();
    });

    document.getElementById('clearAllBtn').addEventListener('click', () => {
      initGrid();
      redraw();
    });

    document.getElementById('loadMotionBtn').addEventListener('click', () => this.load());
    document.getElementById('saveMotionBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},
});


// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Privacy Mask
// ═══════════════════════════════════════════════════════════════════════════

ToolRegistry.register({
  id: 'privacy',
  label: 'Privacy Mask',
  cursor: 'crosshair',

  panelHTML: `
    <div class="toggle-row">
      <span>Privacy Mask</span>
      <div class="toggle" id="privacyToggle"></div>
    </div>
    <div class="instructions">
      <strong>Click &amp; drag</strong> on the video to draw rectangular privacy mask regions.
      <strong>Right-click</strong> a region to delete it.
      Maximum 4 regions supported.
    </div>
    <div class="legend">
      <div class="legend-item">
        <div class="legend-swatch" style="background:rgba(239,68,68,0.35)"></div>
        Masked region
      </div>
    </div>
    <div id="privacyRegionList" style="margin-top:10px"></div>
    <div class="btn-group">
      <button class="btn btn-danger" id="clearPrivacyBtn">Clear All</button>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary btn-block" id="loadPrivacyBtn">Load from Device</button>
    </div>
    <div class="btn-group">
      <button class="btn btn-success btn-block" id="savePrivacyBtn">Save to Device</button>
    </div>
  `,

  initState() {
    return {
      privacyEnabled: false,
      privacyRegions: [],
      privacyNormW: 704,
      privacyNormH: 576,
    };
  },

  resetState() {
    state.privacyRegions = [];
    state.privacyNormW = 704;
    state.privacyNormH = 576;
  },

  draw(ctx, canvas) {
    state.privacyRegions.forEach((reg, i) => {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.fillRect(reg.x, reg.y, reg.w, reg.h);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(reg.x, reg.y, reg.w, reg.h);

      ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      ctx.fillText(`Region ${i + 1}`, reg.x + 6, reg.y + 16);
    });

    // Draw in-progress rectangle
    if (state.isDrawing && state.drawStart && state.drawCurrent) {
      const x = Math.min(state.drawStart.x, state.drawCurrent.x);
      const y = Math.min(state.drawStart.y, state.drawCurrent.y);
      const w = Math.abs(state.drawCurrent.x - state.drawStart.x);
      const h = Math.abs(state.drawCurrent.y - state.drawStart.y);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  },

  onMouseDown(pos, e) {
    if (e.button === 2) {
      // Right-click: delete region under cursor
      for (let i = state.privacyRegions.length - 1; i >= 0; i--) {
        const r = state.privacyRegions[i];
        if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
          state.privacyRegions.splice(i, 1);
          this._updateRegionList();
          redraw();
          break;
        }
      }
    } else {
      if (state.privacyRegions.length >= 4) {
        showToast('Maximum 4 privacy mask regions allowed', 'error');
        return;
      }
      state.isDrawing = true;
      state.drawStart = pos;
      state.drawCurrent = pos;
    }
  },

  onMouseMove(pos, e) {
    state.drawCurrent = pos;
    redraw();
  },

  onMouseUp(pos, e) {
    if (state.isDrawing && state.drawStart) {
      const x = Math.min(state.drawStart.x, pos.x);
      const y = Math.min(state.drawStart.y, pos.y);
      const w = Math.abs(pos.x - state.drawStart.x);
      const h = Math.abs(pos.y - state.drawStart.y);
      if (w > 10 && h > 10) {
        state.privacyRegions.push({ x, y, w, h });
        this._updateRegionList();
      }
    }
  },

  async load() {
    if (!state.config || !state.activeChannel) return;
    setStatus('Loading privacy mask config...');
    try {
      const data = await sendMsg({
        action: 'getPrivacyMask',
        config: state.config,
        channelId: state.activeChannel,
      });

      const pm = data.privacyMask;
      if (pm) {
        state.privacyEnabled = pm.enabled === 'true';
        document.getElementById('privacyToggle').classList.toggle('on', state.privacyEnabled);

        state.privacyRegions = [];
        let regions = pm.PrivacyMaskRegionList?.PrivacyMaskRegion;
        if (regions) {
          if (!Array.isArray(regions)) regions = [regions];

          // Detect coordinate normalization scale from raw values
          const allXs = [];
          const allYs = [];
          regions.forEach(reg => {
            if (reg.RegionCoordinatesList) {
              let coords = reg.RegionCoordinatesList.RegionCoordinates;
              if (!Array.isArray(coords)) coords = coords ? [coords] : [];
              coords.forEach(c => {
                allXs.push(parseInt(c.positionX) || 0);
                allYs.push(parseInt(c.positionY) || 0);
              });
            }
          });
          state.privacyNormW = (allXs.length && Math.max(...allXs) > 1000) ? 10000 : 704;
          state.privacyNormH = (allYs.length && Math.max(...allYs) > 1000) ? 10000 : 576;

          regions.forEach(reg => {
            if (reg.enabled === 'true' && reg.RegionCoordinatesList) {
              let coords = reg.RegionCoordinatesList.RegionCoordinates;
              if (!Array.isArray(coords)) coords = coords ? [coords] : [];
              if (coords.length >= 2) {
                const xs = coords.map(c => parseInt(c.positionX) || 0);
                const ys = coords.map(c => parseInt(c.positionY) || 0);
                const minX = Math.min(...xs);
                const maxX = Math.max(...xs);
                const minY = Math.min(...ys);
                const maxY = Math.max(...ys);

                state.privacyRegions.push({
                  x: (minX / state.privacyNormW) * dom.canvas.width,
                  y: (minY / state.privacyNormH) * dom.canvas.height,
                  w: ((maxX - minX) / state.privacyNormW) * dom.canvas.width,
                  h: ((maxY - minY) / state.privacyNormH) * dom.canvas.height,
                });
              }
            }
          });
        }
      }

      this._updateRegionList();
      redraw();
      showToast('Privacy mask config loaded', 'success');
      setStatus('Config loaded', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to load privacy mask: ' + err.message, 'error');
      setStatus('Failed to load config');
    }
  },

  async save() {
    if (!state.config || !state.activeChannel) return;

    // Use the same coordinate scale that was detected on load
    const normW = state.privacyNormW;
    const normH = state.privacyNormH;

    let regionsXml = '';
    state.privacyRegions.forEach((reg, i) => {
      const x1 = Math.round((reg.x / dom.canvas.width) * normW);
      const y1 = Math.round((reg.y / dom.canvas.height) * normH);
      const x2 = Math.round(((reg.x + reg.w) / dom.canvas.width) * normW);
      const y2 = Math.round(((reg.y + reg.h) / dom.canvas.height) * normH);

      regionsXml += `
    <PrivacyMaskRegion>
      <id>${i + 1}</id>
      <enabled>true</enabled>
      <RegionCoordinatesList>
        <RegionCoordinates>
          <positionX>${x1}</positionX>
          <positionY>${y1}</positionY>
        </RegionCoordinates>
        <RegionCoordinates>
          <positionX>${x2}</positionX>
          <positionY>${y1}</positionY>
        </RegionCoordinates>
        <RegionCoordinates>
          <positionX>${x2}</positionX>
          <positionY>${y2}</positionY>
        </RegionCoordinates>
        <RegionCoordinates>
          <positionX>${x1}</positionX>
          <positionY>${y2}</positionY>
        </RegionCoordinates>
      </RegionCoordinatesList>
    </PrivacyMaskRegion>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PrivacyMask version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <enabled>${state.privacyEnabled}</enabled>
  <PrivacyMaskRegionList>
    ${regionsXml}
  </PrivacyMaskRegionList>
</PrivacyMask>`;

    setStatus('Saving privacy mask config...');
    try {
      await sendMsg({
        action: 'putPrivacyMask',
        config: state.config,
        channelId: state.activeChannel,
        xml,
      });
      showToast('Privacy mask saved successfully!', 'success');
      setStatus('Config saved', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'error');
      setStatus('Save failed');
    }
  },

  bindPanel() {
    document.getElementById('privacyToggle').addEventListener('click', () => {
      state.privacyEnabled = !state.privacyEnabled;
      document.getElementById('privacyToggle').classList.toggle('on', state.privacyEnabled);
    });

    document.getElementById('clearPrivacyBtn').addEventListener('click', () => {
      state.privacyRegions = [];
      this._updateRegionList();
      redraw();
    });

    document.getElementById('loadPrivacyBtn').addEventListener('click', () => this.load());
    document.getElementById('savePrivacyBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},

  /** Render the region list in the sidebar. */
  _updateRegionList() {
    const list = document.getElementById('privacyRegionList');
    list.innerHTML = state.privacyRegions.map((r, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;font-family:var(--mono)">
        <span style="color:var(--text-dim)">Region ${i + 1}</span>
        <button class="btn btn-danger" style="padding:2px 8px;font-size:10px" data-delete="${i}">x</button>
      </div>
    `).join('');

    list.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.delete);
        state.privacyRegions.splice(idx, 1);
        this._updateRegionList();
        redraw();
      });
    });
  },
});


// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Event Actions (motion detection linkage methods)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Defines the linkage actions available for motion detection events.
 * Each entry maps a human-readable label to a Hikvision notificationMethod value.
 */
const EVENT_ACTIONS = [
  { key: 'record',     method: 'record',     label: 'Record Video',       description: 'Record to NVR when motion is detected' },
  { key: 'center',     method: 'center',     label: 'Push Notification',  description: 'Send alert to Hik-Connect mobile app' },
  { key: 'email',      method: 'email',      label: 'Email Alert',        description: 'Send email with snapshot attached' },
  { key: 'beep',       method: 'beep',       label: 'Audible Warning',    description: 'NVR local buzzer' },
  { key: 'IO',         method: 'IO',         label: 'Alarm Output',       description: 'Trigger physical alarm relay' },
  { key: 'whiteLight', method: 'whiteLight', label: 'White Light',        description: 'Flash camera spotlight LED' },
  { key: 'audio',      method: 'audio',      label: 'Audio Alarm',        description: 'Play warning from camera speaker' },
];

ToolRegistry.register({
  id: 'events',
  label: 'Event Actions',
  cursor: 'default',

  panelHTML: `
    <div class="event-actions-info">
      When motion is detected on this channel, perform these actions:
    </div>
    ${EVENT_ACTIONS.map(a => `
      <div class="toggle-row">
        <span title="${a.description}">${a.label}</span>
        <div class="toggle" id="eventToggle_${a.key}" data-action="${a.key}"></div>
      </div>
    `).join('')}
    <div class="btn-group" style="margin-top:12px">
      <button class="btn btn-primary btn-block" id="loadEventsBtn">Load from Device</button>
    </div>
    <div class="btn-group">
      <button class="btn btn-success btn-block" id="saveEventsBtn">Save to Device</button>
    </div>
  `,

  initState() {
    const eventActions = {};
    EVENT_ACTIONS.forEach(a => { eventActions[a.key] = false; });
    return {
      eventActions,
      eventTriggersRawXml: null,
    };
  },

  resetState() {
    EVENT_ACTIONS.forEach(a => { state.eventActions[a.key] = false; });
    state.eventTriggersRawXml = null;
    // Reset toggle UI
    EVENT_ACTIONS.forEach(a => {
      const el = document.getElementById(`eventToggle_${a.key}`);
      if (el) el.classList.remove('on');
    });
  },

  draw(ctx, canvas) {
    // No canvas overlay for event actions
  },

  onMouseDown(pos, e) {},
  onMouseMove(pos, e) {},
  onMouseUp(pos, e) {},

  async load() {
    if (!state.config || !state.activeChannel) return;
    setStatus('Loading event actions...');
    try {
      const data = await sendMsg({
        action: 'getEventTriggers',
        config: state.config,
        channelId: state.activeChannel,
      });

      state.eventTriggersRawXml = data.rawXml;

      // Reset all toggles first
      EVENT_ACTIONS.forEach(a => { state.eventActions[a.key] = false; });

      // Parse which actions are enabled
      const trigger = data.eventTrigger;
      if (trigger) {
        let notifications = trigger.EventTriggerNotificationList?.EventTriggerNotification;
        if (notifications) {
          if (!Array.isArray(notifications)) notifications = [notifications];
          notifications.forEach(n => {
            const method = n.notificationMethod;
            const action = EVENT_ACTIONS.find(a => a.method === method);
            if (action) {
              state.eventActions[action.key] = true;
            }
          });
        }
      }

      // Update toggle UI
      EVENT_ACTIONS.forEach(a => {
        const el = document.getElementById(`eventToggle_${a.key}`);
        if (el) el.classList.toggle('on', state.eventActions[a.key]);
      });

      showToast('Event actions loaded', 'success');
      setStatus('Config loaded', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to load event actions: ' + err.message, 'error');
      setStatus('Failed to load config');
    }
  },

  async save() {
    if (!state.config || !state.activeChannel) return;

    // Build notification list XML from enabled toggles
    let notificationsXml = '';
    EVENT_ACTIONS.forEach(a => {
      if (!state.eventActions[a.key]) return;

      let extra = '';
      if (a.method === 'record') {
        extra = `\n        <notificationRecurrence>beginning</notificationRecurrence>\n        <videoInputID>${state.activeChannel}</videoInputID>`;
      } else if (a.method === 'IO') {
        extra = `\n        <outputIOPortID>1</outputIOPortID>`;
      }

      notificationsXml += `
      <EventTriggerNotification>
        <id>${a.method}</id>
        <notificationMethod>${a.method}</notificationMethod>${extra}
      </EventTriggerNotification>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EventTrigger version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <id>VMD-${state.activeChannel}</id>
  <eventType>VMD</eventType>
  <eventDescription>Video Motion Detection</eventDescription>
  <videoInputChannelID>${state.activeChannel}</videoInputChannelID>
  <EventTriggerNotificationList>${notificationsXml}
  </EventTriggerNotificationList>
</EventTrigger>`;

    setStatus('Saving event actions...');
    try {
      await sendMsg({
        action: 'putEventTriggers',
        config: state.config,
        channelId: state.activeChannel,
        xml,
      });
      showToast('Event actions saved successfully!', 'success');
      setStatus('Config saved', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to save event actions: ' + err.message, 'error');
      setStatus('Save failed');
    }
  },

  bindPanel() {
    // Bind toggle clicks
    EVENT_ACTIONS.forEach(a => {
      document.getElementById(`eventToggle_${a.key}`).addEventListener('click', () => {
        state.eventActions[a.key] = !state.eventActions[a.key];
        document.getElementById(`eventToggle_${a.key}`).classList.toggle('on', state.eventActions[a.key]);
      });
    });

    document.getElementById('loadEventsBtn').addEventListener('click', () => this.load());
    document.getElementById('saveEventsBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},
});


// ─── Initialize Tool Registry ───────────────────────────────────────────────

function initToolRegistry() {
  const tools = ToolRegistry.getAll();

  // Build config sub-tabs
  dom.configTabs.innerHTML = tools.map((t, i) =>
    `<button class="tool-tab${i === 0 ? ' active' : ''}" data-tool="${t.id}">${t.label}</button>`
  ).join('');

  // Build sidebar panels
  dom.configPanels.innerHTML = tools.map((t, i) =>
    `<div class="tool-panel${i === 0 ? ' active' : ''}" data-tool-panel="${t.id}">${t.panelHTML}</div>`
  ).join('');

  // Bind tab click handlers
  dom.configTabs.querySelectorAll('.tool-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTool(tab.dataset.tool));
  });

  // Merge initial state from each tool
  tools.forEach(t => {
    Object.assign(state, t.initState());
  });

  // Initialize grid after state is merged
  initGrid();

  // Let each tool bind its panel event listeners (DOM is now ready)
  tools.forEach(t => t.bindPanel());

  // Set default active tool
  state.activeTool = tools[0]?.id || null;
  if (state.activeTool) {
    dom.configToggleLabel.textContent = ToolRegistry.get(state.activeTool).label;
  }
}

initToolRegistry();


// ─── Canvas Drawing ─────────────────────────────────────────────────────────

function resizeCanvas() {
  const img = dom.videoFeed;
  dom.canvas.width = img.naturalWidth || img.width;
  dom.canvas.height = img.naturalHeight || img.height;
  dom.canvas.style.width = img.clientWidth + 'px';
  dom.canvas.style.height = img.clientHeight + 'px';
}

function redraw() {
  ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
  if (state.activeSection !== 'config') return;
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.draw) tool.draw(ctx, dom.canvas);
}


// ─── Canvas Event Handlers (delegated to active tool) ───────────────────────

dom.canvas.addEventListener('mousedown', (e) => {
  if (state.activeSection !== 'config') return;
  e.preventDefault();
  const pos = getCanvasPos(e);
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.onMouseDown) tool.onMouseDown(pos, e);
});

dom.canvas.addEventListener('mousemove', (e) => {
  if (state.activeSection !== 'config') return;
  if (!state.isDrawing) return;
  const pos = getCanvasPos(e);
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.onMouseMove) tool.onMouseMove(pos, e);
});

dom.canvas.addEventListener('mouseup', (e) => {
  if (state.activeSection !== 'config') return;
  const pos = getCanvasPos(e);
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.onMouseUp) tool.onMouseUp(pos, e);
  state.isDrawing = false;
  state.drawStart = null;
  state.drawCurrent = null;
  redraw();
});

dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());


// ─── Tool Switching ─────────────────────────────────────────────────────────

function switchTool(toolId) {
  const tool = ToolRegistry.get(toolId);
  if (!tool) return;
  state.activeTool = toolId;

  // Update config sub-tab active states
  dom.configTabs.querySelectorAll('.tool-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tool === toolId);
  });

  // Update sidebar tool panels
  dom.configPanels.querySelectorAll('.tool-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.toolPanel === toolId);
  });

  // Update config toggle label
  dom.configToggleLabel.textContent = tool.label;

  // Canvas cursor
  dom.canvas.style.cursor = tool.cursor || 'crosshair';

  expandConfig();
  if (tool.onActivate) tool.onActivate();
  redraw();
}

// ─── Collapsible Config Section ──────────────────────────────────────────────

function expandConfig() {
  state.configExpanded = true;
  dom.configPanels.style.display = 'block';
  dom.configArrow.textContent = '▾';
}

function toggleConfig() {
  state.configExpanded = !state.configExpanded;
  dom.configPanels.style.display = state.configExpanded ? 'block' : 'none';
  dom.configArrow.textContent = state.configExpanded ? '▾' : '▸';
}


// ─── Network Scanner ─────────────────────────────────────────────────────────

function showScanIntro() {
  dom.scanIntro.style.display = 'block';
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'none';
}

function showConnectionForm() {
  dom.scanIntro.style.display = 'none';
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'block';
}

async function startScan() {
  dom.scanIntro.style.display = 'none';
  dom.scanProgress.style.display = 'block';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'none';

  dom.scanProgressFill.style.width = '0%';
  dom.scanStatusText.innerHTML = 'Scanning your local network<br>for Hikvision devices…';

  const startTime = Date.now();
  const TOTAL_MS = 10000;
  state.scanProgressInterval = setInterval(() => {
    const pct = Math.min(100, ((Date.now() - startTime) / TOTAL_MS) * 100);
    dom.scanProgressFill.style.width = pct + '%';
    if (pct >= 100) clearInterval(state.scanProgressInterval);
  }, 100);

  try {
    const data = await sendMsg({ action: 'scanNetwork' });
    clearInterval(state.scanProgressInterval);
    dom.scanProgressFill.style.width = '100%';
    showScanResults(data.devices || []);
  } catch (err) {
    clearInterval(state.scanProgressInterval);
    showToast('Scan error: ' + err.message, 'error');
    showScanResults([]);
  }
}

function cancelScan() {
  clearInterval(state.scanProgressInterval);
  showScanIntro();
}

function showScanResults(devices) {
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'block';

  if (devices.length === 0) {
    dom.scanResultsText.textContent = 'No Hikvision devices found on your local network. Try entering the IP address manually.';
    dom.scanDeviceList.innerHTML = '';
  } else {
    dom.scanResultsText.textContent = `Found ${devices.length} Hikvision device${devices.length > 1 ? 's' : ''}. Click one to connect:`;
    dom.scanDeviceList.innerHTML = devices.map(d => `
      <div class="scan-device-card" data-ip="${d.ip}" data-port="${d.port || 80}">
        <div class="scan-device-ip">${d.ip}</div>
        <div class="scan-device-label">Hikvision NVR / Camera &bull; Port ${d.port || 80}</div>
      </div>
    `).join('');

    dom.scanDeviceList.querySelectorAll('.scan-device-card').forEach(card => {
      card.addEventListener('click', () => {
        dom.hostInput.value = card.dataset.ip;
        dom.portInput.value = card.dataset.port;
        showConnectionForm();
      });
    });
  }
}


// ─── Connection ─────────────────────────────────────────────────────────────

async function connect() {
  const host = dom.hostInput.value.trim();
  const port = dom.portInput.value.trim() || '80';
  const username = dom.userInput.value.trim();
  const password = dom.passInput.value;

  if (!host || !username || !password) {
    showToast('Please fill in all connection fields', 'error');
    return;
  }

  state.config = { host, port: parseInt(port), username, password };
  dom.connectBtn.innerHTML = '<span class="loading"></span> Connecting...';
  dom.connectBtn.disabled = true;
  setStatus('Connecting to ' + host + '...');

  // Save connection details
  const saveData = { host, port, username, savePassword: dom.savePassCheck.checked };
  if (saveData.savePassword) saveData.password = password;
  chrome.storage.local.set(saveData);

  try {
    const data = await sendMsg({ action: 'testConnection', config: state.config });

    state.connected = true;
    dom.statusDot.classList.add('connected');
    const dev = data.device;
    dom.deviceInfo.textContent =
      `${dev.deviceName || dev.model || 'Device'} • FW ${dev.firmwareVersion || 'N/A'}`;

    showToast('Connected successfully!', 'success');
    setStatus('Connected', host);

    dom.connectionForm.style.display = 'none';
    dom.connectionStatus.style.display = 'flex';
    dom.connectedHost.textContent = host;

    await loadChannels();
  } catch (err) {
    showToast('Connection failed: ' + err.message, 'error');
    setStatus('Connection failed');
    dom.statusDot.classList.remove('connected');
  } finally {
    dom.connectBtn.disabled = false;
    if (dom.connectBtn.querySelector('.loading')) dom.connectBtn.textContent = 'Connect';
  }
}

function disconnect() {
  // Stop all feeds
  if (state.snapshotInterval) clearInterval(state.snapshotInterval);
  stopAllGridFeeds();

  // Reset state
  state.connected = false;
  state.config = null;
  state.channels = [];
  state.activeChannel = null;
  state.viewMode = 'single';
  state.gridCellChannels = [null, null, null, null];
  state.activeSection = 'liveview';
  state.gridExpandedCell = null;

  // Reset tool state
  ToolRegistry.getAll().forEach(t => t.resetState());

  // Collapse config section
  state.configExpanded = false;
  dom.configPanels.style.display = 'none';
  dom.configArrow.textContent = '▸';

  // Reset UI
  showScanIntro();
  dom.connectionStatus.style.display = 'none';
  dom.channelsSection.style.display = 'none';
  dom.toolConfigSection.style.display = 'none';
  dom.sectionTabs.style.display = 'none';
  dom.toolTabs.style.display = 'none';
  dom.statusDot.classList.remove('connected');
  dom.deviceInfo.textContent = 'Not connected';
  dom.noFeed.style.display = '';
  dom.canvasWrapper.style.display = 'none';
  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';
  setStatus('Ready');
}

async function loadChannels() {
  try {
    const data = await sendMsg({ action: 'getChannels', config: state.config });

    state.channels = data.channels;
    dom.channelList.innerHTML = '';

    state.channels.forEach((ch, i) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (i === 0 ? ' active' : '');
      div.innerHTML = `<div class="ch-num">${ch.id}</div><span>${ch.name || ch.inputPort || ('Channel ' + ch.id)}</span>`;
      div.addEventListener('click', () => selectChannel(ch.id, div));
      dom.channelList.appendChild(div);
    });

    dom.channelsSection.style.display = 'block';
    dom.sectionTabs.style.display = 'flex';
    dom.toolTabs.style.display = 'flex';

    // Default to Live View after login
    switchSection('liveview');

    if (state.channels.length > 0) {
      selectChannel(state.channels[0].id, dom.channelList.children[0]);
    }
  } catch (err) {
    showToast('Failed to load channels: ' + err.message, 'error');
  }
}

async function selectChannel(channelId, element) {
  // If in grid view, switch back to single camera mode
  if (state.viewMode === 'grid') {
    switchToSingleView();
  }

  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  if (element) element.classList.add('active');

  state.activeChannel = channelId;

  // Reset tool state for the new channel
  ToolRegistry.getAll().forEach(t => t.resetState());

  // Start the feed
  startSnapshotFeed(channelId);

  // Only load config and expand panel if in Configuration section
  if (state.activeSection === 'config') {
    expandConfig();
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.load) tool.load();
  }
}


// ─── Section Navigation ──────────────────────────────────────────────────────

function switchSection(section) {
  state.activeSection = section;

  document.getElementById('liveViewSectionTab').classList.toggle('active', section === 'liveview');
  document.getElementById('configSectionTab').classList.toggle('active', section === 'config');

  dom.liveViewTabs.style.display = section === 'liveview' ? 'flex' : 'none';
  dom.configTabs.style.display = section === 'config' ? 'flex' : 'none';

  if (section === 'liveview') {
    dom.toolConfigSection.style.display = 'none';
    dom.canvas.style.cursor = 'default';

    if (state.viewMode === 'grid') {
      switchToGridView();
    } else {
      switchToLiveViewSingle();
    }
  } else {
    dom.toolConfigSection.style.display = 'block';

    const tool = ToolRegistry.get(state.activeTool);
    dom.canvas.style.cursor = tool?.cursor || 'crosshair';

    // Force single-cam view for configuration
    if (state.viewMode === 'grid') {
      stopAllGridFeeds();
    }
    dom.canvasContainer.style.display = '';
    dom.gridView.style.display = 'none';

    expandConfig();
    if (state.activeChannel) {
      startSnapshotFeed(state.activeChannel);
      if (tool?.load) tool.load();
    }

    // Update config sub-tab active states
    dom.configTabs.querySelectorAll('.tool-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tool === state.activeTool);
    });
  }
}

function switchToLiveViewSingle() {
  state.viewMode = 'single';
  stopAllGridFeeds();

  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';

  document.getElementById('singleViewTab').classList.toggle('active', true);
  document.getElementById('gridViewTab').classList.toggle('active', false);

  if (state.activeChannel) {
    startSnapshotFeed(state.activeChannel);
  }

  setStatus('Live View', state.activeChannel ? `Channel ${state.activeChannel}` : '');
}


// ─── Video Feed ─────────────────────────────────────────────────────────────

function startSnapshotFeed(channelId) {
  if (state.snapshotInterval) clearInterval(state.snapshotInterval);

  dom.noFeed.style.display = 'none';
  dom.canvasWrapper.style.display = 'block';

  let frameCount = 0;

  const fetchSnapshot = async () => {
    try {
      const data = await sendMsg({
        action: 'getSnapshot',
        config: state.config,
        channelId,
      });

      dom.videoFeed.onload = () => {
        resizeCanvas();
        redraw();
        frameCount++;
      };
      dom.videoFeed.src = data.dataUrl;
    } catch (err) {
      if (frameCount === 0) {
        setStatus('Failed to get video feed: ' + err.message);
      }
    }
  };

  fetchSnapshot();
  state.snapshotInterval = setInterval(fetchSnapshot, 1000);
  setStatus('Streaming snapshots', `Channel ${channelId}`);
}


// ─── 4-Camera Grid View ──────────────────────────────────────────────────────

function startGridCellFeed(cellIdx, channelId) {
  if (state.gridSnapIntervals[cellIdx]) {
    clearInterval(state.gridSnapIntervals[cellIdx]);
    state.gridSnapIntervals[cellIdx] = null;
  }

  const cell = document.querySelectorAll('.grid-cell')[cellIdx];
  if (!cell) return;

  const img = cell.querySelector('.grid-feed');
  const noFeed = cell.querySelector('.grid-no-feed');

  img.classList.remove('loaded');
  img.src = '';

  if (!channelId) {
    cell.classList.remove('is-loading');
    noFeed.textContent = 'No camera';
    noFeed.style.display = '';
    return;
  }

  cell.classList.add('is-loading');
  noFeed.style.display = 'none';

  const fetchSnap = async () => {
    try {
      const data = await sendMsg({
        action: 'getSnapshot',
        config: state.config,
        channelId,
      });
      img.onload = () => {
        cell.classList.remove('is-loading');
        img.classList.add('loaded');
      };
      img.src = data.dataUrl;
    } catch {
      // Keep showing loading state until next successful frame
    }
  };

  fetchSnap();
  state.gridSnapIntervals[cellIdx] = setInterval(fetchSnap, 1000);
}

function switchToGridView() {
  if (!state.connected || state.channels.length === 0) {
    showToast('Connect to an NVR first', 'error');
    return;
  }

  state.viewMode = 'grid';

  if (state.snapshotInterval) clearInterval(state.snapshotInterval);

  dom.canvasContainer.style.display = 'none';
  dom.gridView.style.display = 'grid';

  document.getElementById('singleViewTab').classList.toggle('active', false);
  document.getElementById('gridViewTab').classList.toggle('active', true);

  // Clear any maximized state
  dom.gridView.classList.remove('maximized');
  document.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('maximized'));
  state.gridExpandedCell = null;

  stopAllGridFeeds();

  // Assign default channels if not already assigned
  for (let i = 0; i < 4; i++) {
    if (!state.gridCellChannels[i]) {
      state.gridCellChannels[i] = state.channels[i]?.id || null;
    }
  }

  const cells = document.querySelectorAll('.grid-cell');
  cells.forEach((cell, idx) => {
    const picker = cell.querySelector('.grid-channel-picker');

    picker.innerHTML = '<option value="">— empty —</option>' +
      state.channels.map(ch => {
        const name = ch.name || ch.inputPort || `Channel ${ch.id}`;
        const selected = state.gridCellChannels[idx] === ch.id ? ' selected' : '';
        return `<option value="${ch.id}"${selected}>${name}</option>`;
      }).join('');

    picker.onchange = () => {
      state.gridCellChannels[idx] = picker.value || null;
      startGridCellFeed(idx, state.gridCellChannels[idx]);
    };

    const maxBtn = cell.querySelector('.grid-maximize-btn');
    maxBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMaximizeCell(idx);
    };

    startGridCellFeed(idx, state.gridCellChannels[idx]);
  });

  const activeCells = state.gridCellChannels.filter(Boolean).length;
  setStatus('4-Camera View', `${activeCells} camera${activeCells !== 1 ? 's' : ''}`);
}

function switchToSingleView() {
  state.viewMode = 'single';
  stopAllGridFeeds();

  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';

  if (state.activeChannel) {
    startSnapshotFeed(state.activeChannel);
  }
}

function toggleMaximizeCell(cellIdx) {
  const cells = document.querySelectorAll('.grid-cell');

  if (state.gridExpandedCell === cellIdx) {
    dom.gridView.classList.remove('maximized');
    cells.forEach(c => c.classList.remove('maximized'));
    state.gridExpandedCell = null;
  } else {
    dom.gridView.classList.add('maximized');
    cells.forEach(c => c.classList.remove('maximized'));
    cells[cellIdx].classList.add('maximized');
    state.gridExpandedCell = cellIdx;
  }
}


// ─── Event Listeners ────────────────────────────────────────────────────────

// Section tabs
document.getElementById('liveViewSectionTab').addEventListener('click', () => switchSection('liveview'));
document.getElementById('configSectionTab').addEventListener('click', () => switchSection('config'));

// Live View sub-tabs
document.getElementById('singleViewTab').addEventListener('click', () => {
  state.viewMode = 'single';
  switchToLiveViewSingle();
});
document.getElementById('gridViewTab').addEventListener('click', switchToGridView);

// Config section collapse toggle
document.getElementById('configToggleBtn').addEventListener('click', toggleConfig);

// Scan flow
document.getElementById('startScanBtn').addEventListener('click', startScan);
document.getElementById('manualEntryBtn').addEventListener('click', showConnectionForm);
document.getElementById('cancelScanBtn').addEventListener('click', cancelScan);
document.getElementById('rescanBtn').addEventListener('click', startScan);
document.getElementById('manualAfterScanBtn').addEventListener('click', showConnectionForm);
document.getElementById('backToScanBtn').addEventListener('click', showScanIntro);

dom.connectBtn.addEventListener('click', connect);
document.getElementById('disconnectBtn').addEventListener('click', disconnect);

// Allow Enter key to connect
dom.passInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});

window.addEventListener('resize', () => {
  resizeCanvas();
  redraw();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  // Context-dependent number shortcuts
  const tools = ToolRegistry.getAll();
  const keyIdx = parseInt(e.key) - 1;

  if (keyIdx >= 0) {
    if (state.activeSection === 'liveview') {
      if (e.key === '1') { state.viewMode = 'single'; switchToLiveViewSingle(); }
      if (e.key === '2') switchToGridView();
    } else {
      // Config mode: number keys switch tools
      if (keyIdx < tools.length) {
        switchTool(tools[keyIdx].id);
      }
    }
  }

  if (e.key === 'a' && e.ctrlKey) {
    e.preventDefault();
    // Select all grid cells (motion-specific, but harmless for other tools)
    for (let r = 0; r < state.gridRows; r++)
      for (let c = 0; c < state.gridCols; c++)
        state.grid[r][c] = true;
    redraw();
  }

  if (e.key === 'Escape') {
    if (state.gridExpandedCell !== null) {
      toggleMaximizeCell(state.gridExpandedCell);
    } else {
      initGrid();
      redraw();
    }
  }
});


// ─── Load Saved Credentials ─────────────────────────────────────────────────

chrome.storage.local.get(['host', 'port', 'username', 'password', 'savePassword'], (data) => {
  if (data.host) dom.hostInput.value = data.host;
  if (data.port) dom.portInput.value = data.port;
  if (data.username) dom.userInput.value = data.username;
  if (data.savePassword) {
    dom.savePassCheck.checked = true;
    if (data.password) dom.passInput.value = data.password;
  }
});
