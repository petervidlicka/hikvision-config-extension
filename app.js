/**
 * Hikvision Config Tool — Chrome Extension UI
 *
 * Talks to the NVR directly through lib/isapi.js (Digest auth + ISAPI);
 * extension pages with host permission aren't subject to CORS.
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

/**
 * The device rejected our credentials mid-session (password changed, device
 * reset, account locked). Stop every feed immediately — each further request
 * counts as a failed login and Hikvision locks the account after a few.
 */
function handleAuthFailure() {
  if (!state.connected) return;
  disconnect();
  showConnectionForm();
  dom.passInput.value = '';
  showToast('The device rejected the login. Re-enter the password to reconnect.', 'error');
}
Isapi.onAuthFailure = handleAuthFailure;

/** Display name for a channel, falling back to its number. */
function channelLabel(ch) {
  return ch.name || `Channel ${ch.id}`;
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

/** Stop all 4-cam grid snapshot loops. */
function stopAllGridFeeds() {
  state.gridFeedStops.forEach(stop => stop?.());
  state.gridFeedStops = [null, null, null, null];
}

/** Stop the single-view snapshot loop. */
function stopSnapshotFeed() {
  state.stopSnapshotFeed?.();
  state.stopSnapshotFeed = null;
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

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Motion Detection (polygon region-based)
// ═══════════════════════════════════════════════════════════════════════════

/** Check if a point is inside a polygon using ray casting. */
function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

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
    <div class="toggle-row">
      <span>Dynamic Analysis</span>
      <div class="toggle" id="dynamicAnalysisToggle"></div>
    </div>
    <div class="target-detection-row" id="targetDetectionRow">
      <label class="target-label">Detection Target</label>
      <div class="target-checkboxes">
        <label class="target-checkbox"><input type="checkbox" id="detectHuman" /> Person</label>
        <label class="target-checkbox"><input type="checkbox" id="detectVehicle" /> Vehicle</label>
      </div>
    </div>
    <div class="instructions">
      <strong>Click</strong> to place vertices and draw a detection region.
      <strong>Double-click</strong> or click near the start to close the shape.
      <strong>Right-click</strong> a region to delete it. Max 8 regions.
    </div>
    <div class="legend">
      <div class="legend-item">
        <div class="legend-swatch" style="background:rgba(74,108,247,0.45)"></div>
        Detection zone
      </div>
    </div>
    <div id="motionRegionList" style="margin-top:10px"></div>
    <div class="btn-group">
      <button class="btn btn-danger" id="clearMotionRegionsBtn">Clear All</button>
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
      motionRegions: [],
      drawingPoints: [],
      motionNormW: 0,
      motionNormH: 0,
      motionEnabled: false,
      sensitivity: 50,
      dynamicAnalysis: false,
      detectHuman: false,
      detectVehicle: false,
      motionDoc: null, // device XML from the last load; saves edit a copy
    };
  },

  resetState() {
    state.motionRegions = [];
    state.drawingPoints = [];
    state.motionDoc = null;
    // Reset coordinate space on channel switch so next load re-detects correctly
    // but keep normW/H across channels on same NVR session (handled in load via sticky logic)
  },

  draw(ctx, canvas) {
    // Draw completed regions
    state.motionRegions.forEach((reg, i) => {
      if (reg.points.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(reg.points[0].x, reg.points[0].y);
      for (let p = 1; p < reg.points.length; p++) {
        ctx.lineTo(reg.points[p].x, reg.points[p].y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(74, 108, 247, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(74, 108, 247, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw vertices
      reg.points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(74, 108, 247, 0.9)';
        ctx.fill();
      });

      // Label
      const cx = reg.points.reduce((s, p) => s + p.x, 0) / reg.points.length;
      const cy = reg.points.reduce((s, p) => s + p.y, 0) / reg.points.length;
      ctx.fillStyle = 'rgba(74, 108, 247, 0.9)';
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      ctx.fillText(`Region ${i + 1}`, cx - 30, cy + 4);
    });

    // Draw in-progress polygon
    if (state.drawingPoints.length > 0) {
      const pts = state.drawingPoints;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let p = 1; p < pts.length; p++) {
        ctx.lineTo(pts[p].x, pts[p].y);
      }
      // Line to current mouse position
      if (state.mousePos) {
        ctx.lineTo(state.mousePos.x, state.mousePos.y);
      }
      ctx.strokeStyle = 'rgba(74, 108, 247, 0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw placed vertices
      pts.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? 'rgba(74, 247, 108, 0.9)' : 'rgba(74, 108, 247, 0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }
  },

  onMouseDown(pos, e) {
    if (e.button === 2) {
      // Right-click: delete region under cursor
      for (let i = state.motionRegions.length - 1; i >= 0; i--) {
        if (pointInPolygon(pos.x, pos.y, state.motionRegions[i].points)) {
          state.motionRegions.splice(i, 1);
          this._updateRegionList();
          redraw();
          break;
        }
      }
      return;
    }

    // Left click: place vertex or close polygon
    if (state.drawingPoints.length >= 2) {
      const first = state.drawingPoints[0];
      const dist = Math.hypot(pos.x - first.x, pos.y - first.y);
      if (dist < 12) {
        // Close polygon — clicked near start vertex
        if (state.drawingPoints.length >= 3) {
          state.motionRegions.push({ points: [...state.drawingPoints] });
          this._updateRegionList();
        }
        state.drawingPoints = [];
        redraw();
        return;
      }
    }

    if (state.motionRegions.length >= 8 && state.drawingPoints.length === 0) {
      showToast('Maximum 8 detection regions allowed', 'error');
      return;
    }

    state.drawingPoints.push({ x: pos.x, y: pos.y });
    redraw();
  },

  onMouseMove(pos, e) {
    state.mousePos = pos;
    if (state.drawingPoints.length > 0) {
      redraw();
    }
  },

  onMouseUp(pos, e) {
    // Nothing needed
  },

  onDblClick(pos, e) {
    // Double-click: close the polygon if we have enough points
    if (state.drawingPoints.length >= 3) {
      state.motionRegions.push({ points: [...state.drawingPoints] });
      this._updateRegionList();
    }
    state.drawingPoints = [];
    redraw();
  },

  async load() {
    if (!state.config || !state.activeChannel) return;
    setStatus('Loading motion detection config...');
    try {
      const doc = await Isapi.getXml(state.config, Isapi.motionDetectionPath(state.activeChannel));
      state.motionDoc = doc;
      const md = readMotionConfig(doc);

      state.motionEnabled = md.enabled;
      document.getElementById('motionToggle').classList.toggle('on', state.motionEnabled);

      if (md.sensitivity !== null) {
        state.sensitivity = md.sensitivity;
        document.getElementById('sensitivitySlider').value = md.sensitivity;
        document.getElementById('sensitivityVal').textContent = md.sensitivity;
      }

      // Detect the coordinate scale from the largest values seen. All cameras
      // on one NVR share a coordinate space, so only ever grow it (it resets
      // on disconnect).
      const allPoints = md.regions.flat();
      const detectedW = allPoints.length ? Math.max(...allPoints.map(p => p.x)) : 0;
      const detectedH = allPoints.length ? Math.max(...allPoints.map(p => p.y)) : 0;
      if (detectedW > (state.motionNormW || 0)) state.motionNormW = detectedW;
      if (detectedH > (state.motionNormH || 0)) state.motionNormH = detectedH;
      if (!state.motionNormW) state.motionNormW = 10000;
      if (!state.motionNormH) state.motionNormH = 10000;

      // Hikvision puts Y=0 at the bottom of the image; the canvas at the top.
      state.motionRegions = md.regions.map(points => ({
        points: points.map(p => ({
          x: (p.x / state.motionNormW) * dom.canvas.width,
          y: (1 - p.y / state.motionNormH) * dom.canvas.height,
        })),
      }));

      state.dynamicAnalysis = md.dynamicAnalysis;
      document.getElementById('dynamicAnalysisToggle').classList.toggle('on', state.dynamicAnalysis);
      state.detectHuman = md.detectHuman;
      state.detectVehicle = md.detectVehicle;
      document.getElementById('detectHuman').checked = state.detectHuman;
      document.getElementById('detectVehicle').checked = state.detectVehicle;

      this._updateRegionList();
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
    if (!state.motionDoc) {
      showToast('Load the settings from the device before saving', 'error');
      return;
    }

    const normW = state.motionNormW;
    const normH = state.motionNormH;
    // Edit a copy so a failed save leaves the loaded config intact
    const doc = state.motionDoc.cloneNode(true);

    setStatus('Saving motion detection config...');
    try {
      applyMotionConfig(doc, {
        enabled: state.motionEnabled,
        sensitivity: Number(document.getElementById('sensitivitySlider').value),
        dynamicAnalysis: state.dynamicAnalysis,
        // Flip Y back to the device convention (Y=0 at the bottom)
        regions: state.motionRegions.map(reg => reg.points.map(p => ({
          x: (p.x / dom.canvas.width) * normW,
          y: (1 - p.y / dom.canvas.height) * normH,
        }))),
      });
      // Person/vehicle target detection lives on a different ISAPI endpoint and isn't saved here.

      await Isapi.putXml(state.config, Isapi.motionDetectionPath(state.activeChannel), doc);
      state.motionDoc = doc;
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

    document.getElementById('dynamicAnalysisToggle').addEventListener('click', () => {
      state.dynamicAnalysis = !state.dynamicAnalysis;
      document.getElementById('dynamicAnalysisToggle').classList.toggle('on', state.dynamicAnalysis);
    });

    document.getElementById('detectHuman').addEventListener('change', function () {
      state.detectHuman = this.checked;
    });
    document.getElementById('detectVehicle').addEventListener('change', function () {
      state.detectVehicle = this.checked;
    });

    document.getElementById('clearMotionRegionsBtn').addEventListener('click', () => {
      state.motionRegions = [];
      state.drawingPoints = [];
      this._updateRegionList();
      redraw();
    });

    document.getElementById('loadMotionBtn').addEventListener('click', () => {
      setToolPanelLoading('motion', true);
      this.load().then(() => setToolPanelLoading('motion', false)).catch(() => setToolPanelLoading('motion', false));
    });
    document.getElementById('saveMotionBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},

  /** Render the region list in the sidebar. */
  _updateRegionList() {
    const list = document.getElementById('motionRegionList');
    if (!list) return;
    list.innerHTML = state.motionRegions.map((r, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;font-family:var(--mono)">
        <span style="color:var(--text-dim)">Region ${i + 1} (${r.points.length} pts)</span>
        <button class="btn btn-danger" style="padding:2px 8px;font-size:10px" data-delete-motion="${i}">x</button>
      </div>
    `).join('');

    list.querySelectorAll('[data-delete-motion]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.deleteMotion);
        state.motionRegions.splice(idx, 1);
        this._updateRegionList();
        redraw();
      });
    });
  },
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
      privacyDoc: null,
      privacyPath: null,
    };
  },

  resetState() {
    state.privacyRegions = [];
    state.privacyDoc = null;
    state.privacyPath = null;
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
      const { doc, path } = await Isapi.getPrivacyMask(state.config, state.activeChannel);
      state.privacyDoc = doc;
      state.privacyPath = path;
      const pm = readPrivacyMask(doc);

      state.privacyEnabled = pm.enabled;
      document.getElementById('privacyToggle').classList.toggle('on', state.privacyEnabled);

      // Older firmware uses a 704x576 grid, newer a 0–10000 normalized range
      const allPoints = pm.regions.flat();
      state.privacyNormW = allPoints.some(p => p.x > 1000) ? 10000 : 704;
      state.privacyNormH = allPoints.some(p => p.y > 1000) ? 10000 : 576;

      state.privacyRegions = pm.regions.map(points => {
        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        return {
          x: (minX / state.privacyNormW) * dom.canvas.width,
          y: (minY / state.privacyNormH) * dom.canvas.height,
          w: ((Math.max(...xs) - minX) / state.privacyNormW) * dom.canvas.width,
          h: ((Math.max(...ys) - minY) / state.privacyNormH) * dom.canvas.height,
        };
      });

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
    if (!state.privacyDoc) {
      showToast('Load the settings from the device before saving', 'error');
      return;
    }

    // Use the same coordinate scale that was detected on load
    const normW = state.privacyNormW;
    const normH = state.privacyNormH;
    const doc = state.privacyDoc.cloneNode(true);

    setStatus('Saving privacy mask config...');
    try {
      applyPrivacyMask(doc, {
        enabled: state.privacyEnabled,
        rects: state.privacyRegions.map(reg => ({
          x1: (reg.x / dom.canvas.width) * normW,
          y1: (reg.y / dom.canvas.height) * normH,
          x2: ((reg.x + reg.w) / dom.canvas.width) * normW,
          y2: ((reg.y + reg.h) / dom.canvas.height) * normH,
        })),
      });
      await Isapi.putXml(state.config, state.privacyPath, doc);
      state.privacyDoc = doc;
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

    document.getElementById('loadPrivacyBtn').addEventListener('click', () => {
      setToolPanelLoading('privacy', true);
      this.load().then(() => setToolPanelLoading('privacy', false)).catch(() => setToolPanelLoading('privacy', false));
    });
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
      eventTriggerDoc: null,
    };
  },

  resetState() {
    EVENT_ACTIONS.forEach(a => { state.eventActions[a.key] = false; });
    state.eventTriggerDoc = null;
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
      const doc = await Isapi.getEventTrigger(state.config, state.activeChannel);
      state.eventTriggerDoc = doc;
      const methods = readNotificationMethods(doc);

      EVENT_ACTIONS.forEach(a => {
        state.eventActions[a.key] = methods.has(a.method);
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
    if (!state.eventTriggerDoc) {
      showToast('Load the settings from the device before saving', 'error');
      return;
    }

    const doc = state.eventTriggerDoc.cloneNode(true);
    applyNotificationMethods(doc, {
      managed: EVENT_ACTIONS.map(a => a.method),
      enabled: new Set(EVENT_ACTIONS.filter(a => state.eventActions[a.key]).map(a => a.method)),
      channelId: state.activeChannel,
    });

    setStatus('Saving event actions...');
    try {
      await Isapi.putXml(state.config, Isapi.eventTriggerPath(state.activeChannel), doc);
      state.eventTriggerDoc = doc;
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

    document.getElementById('loadEventsBtn').addEventListener('click', () => {
      setToolPanelLoading('events', true);
      this.load().then(() => setToolPanelLoading('events', false)).catch(() => setToolPanelLoading('events', false));
    });
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
  // Allow mousemove even when not drawing (for polygon vertex preview)
  if (!state.isDrawing && !(state.drawingPoints && state.drawingPoints.length > 0)) return;
  const pos = getCanvasPos(e);
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.onMouseMove) tool.onMouseMove(pos, e);
});

dom.canvas.addEventListener('dblclick', (e) => {
  if (state.activeSection !== 'config') return;
  e.preventDefault();
  const pos = getCanvasPos(e);
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.onDblClick) tool.onDblClick(pos, e);
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

  // Auto-load settings from device when switching tools in config mode
  if (state.activeSection === 'config' && state.activeChannel && tool.load) {
    setToolPanelLoading(toolId, true);
    tool.load().then(() => {
      setToolPanelLoading(toolId, false);
    }).catch(() => {
      setToolPanelLoading(toolId, false);
    });
  }
}

/**
 * Set or clear the loading/disabled state on a tool's sidebar panel.
 * When loading, all interactive elements (inputs, buttons, toggles) are
 * disabled and the panel is visually dimmed so users know the settings
 * haven't been loaded yet.
 */
function setToolPanelLoading(toolId, isLoading) {
  const panel = dom.configPanels.querySelector(`[data-tool-panel="${toolId}"]`);
  if (!panel) return;
  panel.classList.toggle('tool-loading', isLoading);
  // Disable/enable all interactive children
  panel.querySelectorAll('input, button, select, .toggle').forEach(el => {
    if (isLoading) {
      el.dataset.wasDisabled = el.hasAttribute('disabled') ? 'true' : 'false';
      el.setAttribute('disabled', '');
      if (el.classList.contains('toggle')) el.style.pointerEvents = 'none';
    } else {
      if (el.dataset.wasDisabled !== 'true') el.removeAttribute('disabled');
      delete el.dataset.wasDisabled;
      if (el.classList.contains('toggle')) el.style.pointerEvents = '';
    }
  });
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

/** Broad access granted only while a scan runs (see startScan). */
const SCAN_ORIGINS = 'http://*/*';

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
  // Scanning has to probe every address on the subnet, so it needs access to
  // all http:// origins. Ask only for the duration of the scan.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [SCAN_ORIGINS] });
  } catch (err) {
    showToast('Could not request network access: ' + err.message, 'error');
    return;
  }
  if (!granted) {
    showToast('Scanning needs network access. You can enter the IP manually instead.', 'error');
    return;
  }

  dom.scanIntro.style.display = 'none';
  dom.scanProgress.style.display = 'block';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'none';

  dom.scanProgressFill.style.width = '0%';
  dom.scanStatusText.textContent = 'Scanning your local network for Hikvision devices…';

  state.scanAbort?.abort();
  const abort = new AbortController();
  state.scanAbort = abort;
  let foundCount = 0;

  try {
    const devices = await scanForHikvision({
      // The last-used host's subnet is the best guess at where the device lives
      subnets: candidateSubnets([dom.hostInput.value.trim()]),
      signal: abort.signal,
      onFound: () => { foundCount++; },
      onProgress: ({ subnet, probed }) => {
        dom.scanProgressFill.style.width = `${(probed / 254) * 100}%`;
        dom.scanStatusText.textContent = `Scanning ${subnet}.x…` +
          (foundCount ? ` found ${foundCount} device${foundCount > 1 ? 's' : ''}` : '');
      },
    });
    if (!abort.signal.aborted) showScanResults(devices);
  } catch (err) {
    showToast('Scan error: ' + err.message, 'error');
    showScanResults([]);
  } finally {
    if (state.scanAbort === abort) state.scanAbort = null;
    chrome.permissions.remove({ origins: [SCAN_ORIGINS] }).catch(() => {});
  }
}

function cancelScan() {
  state.scanAbort?.abort();
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

  // Access is granted per device. This must be the first await so Chrome
  // still treats the call as part of the click / Enter key press.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`http://${host}/*`] });
  } catch {
    showToast(`"${host}" is not a valid IP address or hostname`, 'error');
    return;
  }
  if (!granted) {
    showToast('Access to the device was not granted, so the extension cannot reach it.', 'error');
    return;
  }

  state.config = { host, port: parseInt(port), username, password };
  dom.connectBtn.innerHTML = '<span class="loading"></span> Connecting...';
  dom.connectBtn.disabled = true;
  setStatus('Connecting to ' + host + '...');

  try {
    const dev = await Isapi.getDeviceInfo(state.config);
    saveConnectionDetails(host, port, username, password);

    state.connected = true;
    dom.statusDot.classList.add('connected');
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

/**
 * Remember connection details. The password goes to session storage (memory
 * only, cleared when Chrome closes) unless the user opted to keep it on disk.
 */
function saveConnectionDetails(host, port, username, password) {
  const remember = dom.savePassCheck.checked;
  chrome.storage.local.set({ host, port, username, savePassword: remember });
  if (remember) {
    chrome.storage.local.set({ password });
  } else {
    chrome.storage.local.remove('password');
  }
  chrome.storage.session.set({ password });
}

function disconnect() {
  // Stop all feeds
  stopSnapshotFeed();
  stopAllGridFeeds();
  clearFrame(dom.videoFeed);

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
  // Reset NVR coordinate space so a new connection re-detects from scratch
  state.motionNormW = 0;
  state.motionNormH = 0;

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
    state.channels = await Isapi.getChannels(state.config);
    dom.channelList.innerHTML = '';

    state.channels.forEach((ch, i) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (i === 0 ? ' active' : '');
      // Names come from the device — never parse them as HTML
      const num = document.createElement('div');
      num.className = 'ch-num';
      num.textContent = ch.id;
      const label = document.createElement('span');
      label.textContent = channelLabel(ch);
      div.append(num, label);
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
    if (tool?.load) {
      setToolPanelLoading(state.activeTool, true);
      tool.load().then(() => {
        setToolPanelLoading(state.activeTool, false);
      }).catch(() => {
        setToolPanelLoading(state.activeTool, false);
      });
    }
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
      if (tool?.load) {
        setToolPanelLoading(state.activeTool, true);
        tool.load().then(() => {
          setToolPanelLoading(state.activeTool, false);
        }).catch(() => {
          setToolPanelLoading(state.activeTool, false);
        });
      }
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

/** Minimum time between snapshot requests for one feed. */
const SNAPSHOT_INTERVAL_MS = 1000;

/**
 * Poll snapshots for a channel, one request at a time: the next request is
 * scheduled only after the previous one finishes, so a slow device never
 * builds up a queue of overlapping requests.
 *
 * @param {string} channelId
 * @param {object} handlers
 * @param {(blob: Blob) => void} handlers.onFrame
 * @param {(err: Error) => void} [handlers.onError]
 * @returns {() => void} stops the loop
 */
function createSnapshotLoop(channelId, { onFrame, onError }) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    const started = performance.now();
    try {
      const blob = await Isapi.getSnapshot(state.config, channelId);
      if (!stopped) onFrame(blob);
    } catch (err) {
      if (stopped) return;
      onError?.(err);
      // handleAuthFailure has already stopped everything; don't reschedule
      if (err instanceof AuthError) return;
    }
    if (!stopped) {
      timer = setTimeout(tick, Math.max(0, SNAPSHOT_INTERVAL_MS - (performance.now() - started)));
    }
  };

  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Show a JPEG blob in an <img>, releasing the previous frame's object URL.
 * Object URLs avoid re-encoding every frame as a base64 data URL.
 */
function showFrame(img, blob) {
  const previous = img.dataset.objectUrl;
  const url = URL.createObjectURL(blob);
  img.dataset.objectUrl = url;
  img.src = url;
  if (previous) URL.revokeObjectURL(previous);
}

/** Clear an <img> that was showing frames from showFrame(). */
function clearFrame(img) {
  if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
  delete img.dataset.objectUrl;
  img.removeAttribute('src');
}

function startSnapshotFeed(channelId) {
  stopSnapshotFeed();

  dom.noFeed.style.display = 'none';
  dom.canvasWrapper.style.display = 'block';

  let frameCount = 0;
  dom.videoFeed.onload = () => {
    resizeCanvas();
    redraw();
    frameCount++;
  };

  state.stopSnapshotFeed = createSnapshotLoop(channelId, {
    onFrame: blob => showFrame(dom.videoFeed, blob),
    onError: err => {
      if (frameCount === 0) setStatus('Failed to get video feed: ' + err.message);
    },
  });
  setStatus('Streaming snapshots', `Channel ${channelId}`);
}


// ─── 4-Camera Grid View ──────────────────────────────────────────────────────

function startGridCellFeed(cellIdx, channelId) {
  state.gridFeedStops[cellIdx]?.();
  state.gridFeedStops[cellIdx] = null;

  const cell = document.querySelectorAll('.grid-cell')[cellIdx];
  if (!cell) return;

  const img = cell.querySelector('.grid-feed');
  const noFeed = cell.querySelector('.grid-no-feed');

  img.classList.remove('loaded');
  clearFrame(img);

  if (!channelId) {
    cell.classList.remove('is-loading');
    noFeed.textContent = 'No camera';
    noFeed.style.display = '';
    return;
  }

  cell.classList.add('is-loading');
  noFeed.style.display = 'none';

  img.onload = () => {
    cell.classList.remove('is-loading');
    img.classList.add('loaded');
  };
  // On errors, keep showing the loading state until the next successful frame
  state.gridFeedStops[cellIdx] = createSnapshotLoop(channelId, {
    onFrame: blob => showFrame(img, blob),
  });
}

function switchToGridView() {
  if (!state.connected || state.channels.length === 0) {
    showToast('Connect to an NVR first', 'error');
    return;
  }

  state.viewMode = 'grid';

  stopSnapshotFeed();

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

    picker.replaceChildren(
      new Option('— empty —', ''),
      ...state.channels.map(ch => {
        const selected = state.gridCellChannels[idx] === ch.id;
        return new Option(channelLabel(ch), ch.id, selected, selected);
      }),
    );

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

  if (e.key === 'Escape') {
    if (state.gridExpandedCell !== null) {
      toggleMaximizeCell(state.gridExpandedCell);
    } else if (state.drawingPoints && state.drawingPoints.length > 0) {
      // Cancel in-progress polygon drawing
      state.drawingPoints = [];
      redraw();
    }
  }
});


// ─── Load Saved Credentials ─────────────────────────────────────────────────

chrome.storage.local.get(['host', 'port', 'username', 'password', 'savePassword'], async (data) => {
  if (data.host) dom.hostInput.value = data.host;
  if (data.port) dom.portInput.value = data.port;
  if (data.username) dom.userInput.value = data.username;
  if (data.savePassword) {
    dom.savePassCheck.checked = true;
    if (data.password) dom.passInput.value = data.password;
    return;
  }
  // Clean up a password left on disk by older versions that saved it unconditionally
  if (data.password) chrome.storage.local.remove('password');
  const session = await chrome.storage.session.get('password');
  if (session.password) dom.passInput.value = session.password;
});
