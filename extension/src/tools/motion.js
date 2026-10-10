/**
 * Motion detection tool: draw polygon regions, sensitivity and targets.
 */

import { MOTION_COORDINATE_SCALE, applyMotionConfig, readMotionCapabilities, readMotionConfig } from '../../lib/config-xml.js';
import { Isapi } from '../../lib/isapi.js';
import { redraw } from '../canvas.js';
import { dom, state } from '../state.js';
import { setToolPanelLoading } from './registry.js';
import { activeChannelInfo, setStatus, showToast } from '../ui.js';

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Motion Detection (polygon region-based)
// ═══════════════════════════════════════════════════════════════════════════

/** Check if a point is inside a polygon using ray casting. */
export function pointInPolygon(px, py, points) {
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

export const motionTool = {
  id: 'motion',
  label: 'Motion Detection',
  cursor: 'crosshair',

  panelHTML: `
    <div class="toggle-row">
      <span>Motion Detection</span>
      <div class="toggle" id="motionToggle"></div>
    </div>
    <div class="slider-group">
      <label>Sensitivity <span id="sensitivityVal">40</span></label>
      <input type="range" id="sensitivitySlider" min="0" max="100" step="20" value="40" />
    </div>
    <div class="toggle-row">
      <span>Dynamic Analysis</span>
      <div class="toggle" id="dynamicAnalysisToggle"></div>
    </div>
    <div class="target-detection-row" id="targetDetectionRow">
      <label class="target-label">Detection Target</label>
      <div class="target-checkboxes">
        <label class="target-checkbox" id="detectHumanLabel"><input type="checkbox" id="detectHuman" /> Person</label>
        <label class="target-checkbox" id="detectVehicleLabel"><input type="checkbox" id="detectVehicle" /> Vehicle</label>
      </div>
    </div>
    <div class="instructions">
      <strong>Click</strong> to place vertices and draw a detection region.
      <strong>Double-click</strong> or click near the start to close the shape.
      <strong>Right-click</strong> a region to delete it.
      Up to <span id="motionMaxRegions">4</span> regions, <span id="motionPointRange">4–10</span> corners each.
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
      motionCaps: readMotionCapabilities(null), // device limits, refreshed on load
      motionEnabled: false,
      sensitivity: 40,
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

    const pts = state.drawingPoints;

    // Clicking near the start vertex closes the polygon
    if (pts.length >= 2 && Math.hypot(pos.x - pts[0].x, pos.y - pts[0].y) < 12) {
      this._closePolygon();
      return;
    }

    if (state.motionRegions.length >= state.motionCaps.maxRegions && pts.length === 0) {
      showToast(`This camera allows at most ${state.motionCaps.maxRegions} detection regions`, 'error');
      return;
    }

    // The clicks of a double-click land on the same spot — don't add duplicate corners
    const last = pts[pts.length - 1];
    if (last && Math.hypot(pos.x - last.x, pos.y - last.y) < 4) return;

    pts.push({ x: pos.x, y: pos.y });
    if (pts.length >= state.motionCaps.maxPoints) {
      this._closePolygon();
      return;
    }
    redraw();
  },

  /**
   * Finish the polygon being drawn. Too few corners keeps it open — the
   * device rejects regions below its minimum.
   */
  _closePolygon() {
    const { minPoints } = state.motionCaps;
    if (state.drawingPoints.length < minPoints) {
      showToast(`A detection region needs at least ${minPoints} corners`, 'error');
      return;
    }
    state.motionRegions.push({ points: [...state.drawingPoints] });
    state.drawingPoints = [];
    this._updateRegionList();
    redraw();
  },

  /** Apply the device's limits to the panel controls. */
  _applyCapabilities() {
    const caps = state.motionCaps;
    const slider = document.getElementById('sensitivitySlider');
    slider.min = caps.sensitivity.min;
    slider.max = caps.sensitivity.max;
    slider.step = caps.sensitivity.step;
    document.getElementById('motionMaxRegions').textContent = caps.maxRegions;
    document.getElementById('motionPointRange').textContent = `${caps.minPoints}–${caps.maxPoints}`;
    document.getElementById('detectHumanLabel').style.display = caps.targetTypes.includes('human') ? '' : 'none';
    document.getElementById('detectVehicleLabel').style.display = caps.targetTypes.includes('vehicle') ? '' : 'none';
    document.getElementById('targetDetectionRow').style.display = caps.targetTypes.length ? '' : 'none';
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
    if (state.drawingPoints.length > 0) this._closePolygon();
  },

  async load() {
    if (!state.config || !state.activeChannel) return;
    const channel = activeChannelInfo();
    setStatus('Loading motion detection config...');
    try {
      const [doc, capsDoc] = await Promise.all([
        Isapi.getXml(state.config, Isapi.motionDetectionPath(channel)),
        Isapi.getMotionCapabilities(state.config, channel),
      ]);
      state.motionDoc = doc;
      state.motionCaps = readMotionCapabilities(capsDoc);
      this._applyCapabilities();
      const md = readMotionConfig(doc);

      state.motionEnabled = md.enabled;
      document.getElementById('motionToggle').classList.toggle('on', state.motionEnabled);

      if (md.sensitivity !== null) {
        state.sensitivity = md.sensitivity;
        document.getElementById('sensitivitySlider').value = md.sensitivity;
        document.getElementById('sensitivityVal').textContent = md.sensitivity;
      }

      // Device coordinates are 0–1000 with Y=0 at the bottom; the canvas has Y=0 at the top
      const scale = MOTION_COORDINATE_SCALE;
      state.motionRegions = md.regions.map(points => ({
        points: points.map(p => ({
          x: (p.x / scale) * dom.canvas.width,
          y: (1 - p.y / scale) * dom.canvas.height,
        })),
      }));
      state.drawingPoints = [];

      state.dynamicAnalysis = md.dynamicAnalysis;
      document.getElementById('dynamicAnalysisToggle').classList.toggle('on', state.dynamicAnalysis);
      state.detectHuman = md.targetTypes.includes('human');
      state.detectVehicle = md.targetTypes.includes('vehicle');
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
    const caps = state.motionCaps;
    if (!caps.regionTypes.includes('region')) {
      showToast('This camera only supports grid-based motion areas, which the extension cannot edit yet', 'error');
      return;
    }
    if (state.drawingPoints.length > 0) {
      showToast('Finish or cancel (Esc) the region you are drawing first', 'error');
      return;
    }

    // Snap to the device's sensitivity steps (e.g. 0, 20, … 100)
    const { min, max, step } = caps.sensitivity;
    const rawSensitivity = Number(document.getElementById('sensitivitySlider').value);
    const sensitivity = Math.min(max, Math.max(min, min + Math.round((rawSensitivity - min) / step) * step));

    const scale = MOTION_COORDINATE_SCALE;
    const toDevice = v => Math.min(scale, Math.max(0, Math.round(v * scale)));
    // Edit a copy so a failed save leaves the loaded config intact
    const doc = state.motionDoc.cloneNode(true);

    setStatus('Saving motion detection config...');
    try {
      applyMotionConfig(doc, {
        enabled: state.motionEnabled,
        sensitivity,
        dynamicAnalysis: state.dynamicAnalysis,
        // Flip Y back to the device convention (Y=0 at the bottom)
        regions: state.motionRegions.map(reg => reg.points.map(p => ({
          x: toDevice(p.x / dom.canvas.width),
          y: toDevice(1 - p.y / dom.canvas.height),
        }))),
        targetTypes: caps.targetTypes.length
          ? caps.targetTypes.filter(t => (t === 'human' && state.detectHuman) || (t === 'vehicle' && state.detectVehicle))
          : undefined,
      });

      await Isapi.putXml(state.config, Isapi.motionDetectionPath(activeChannelInfo()), doc);
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
};
