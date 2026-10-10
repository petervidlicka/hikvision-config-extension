/**
 * Motion detection tool: draw polygon regions, sensitivity and targets.
 * Regions are kept as fractions of the picture (lib/shapes.js) and become
 * device units only when saved.
 */

import {
  applyMotionConfig, imageToMotionRegion, motionRegionToImage, readMotionCapabilities, readMotionConfig,
} from '../../lib/config-xml.js';
import { Isapi } from '../../lib/isapi.js';
import { pixelDistance, pointInPolygon, toPixels } from '../../lib/shapes.js';
import { redraw } from '../canvas.js';
import { byId, dom, queryAll, state } from '../state.js';
import { loadTool } from './registry.js';
import { activeChannelInfo, errorMessage, reportSaved, setStatus, showToast } from '../ui.js';
import { cloneXml } from '../../lib/xml.js';

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Motion Detection (polygon region-based)
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {import('./registry.js').Tool} Tool */

/** Clicking this close to the first corner, in canvas pixels (screen pixels, see resizeCanvas), closes the polygon. */
const CLOSE_DISTANCE_PX = 12;
/** A click this close to the last corner, in canvas (screen) pixels, is the same corner again. */
const SAME_CORNER_PX = 4;

/** @satisfies {Tool} */
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
    <div class="toggle-row" id="dynamicAnalysisRow">
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
    <div class="instructions" id="motionRegionInstructions">
      <strong>Click</strong> to place vertices and draw a detection region.
      <strong>Double-click</strong> or click near the start to close the shape.
      <strong>Right-click</strong> a region to delete it.
      Up to <span id="motionMaxRegions">4</span> regions, <span id="motionPointRange">4–10</span> corners each.
    </div>
    <div class="instructions" id="motionGridInstructions" style="display:none">
      This camera uses a detection grid.
      <strong>Click or drag</strong> to mark cells; drag over marked cells to clear them.
      <strong>Right-click</strong> clears a cell.
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
      motionMode: 'region',
      motionGrid: null,
      gridPaintValue: null,
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
    state.motionGrid = null;
    state.motionDoc = null;
  },

  draw(ctx, canvas) {
    if (state.motionMode === 'grid') {
      drawGrid(ctx, canvas);
      return;
    }
    /** @param {import('../../lib/shapes.js').ImagePoint} p */
    const px = p => toPixels(p, canvas);
    // Draw completed regions
    state.motionRegions.forEach((reg, i) => {
      if (reg.points.length < 3) return;
      const points = reg.points.map(px);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let p = 1; p < points.length; p++) {
        ctx.lineTo(points[p].x, points[p].y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(74, 108, 247, 0.3)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(74, 108, 247, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw vertices
      points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(74, 108, 247, 0.9)';
        ctx.fill();
      });

      // Label
      const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
      const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
      ctx.fillStyle = 'rgba(74, 108, 247, 0.9)';
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      ctx.fillText(`Region ${i + 1}`, cx - 30, cy + 4);
    });

    // Draw in-progress polygon
    if (state.drawingPoints.length > 0) {
      const pts = state.drawingPoints.map(px);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let p = 1; p < pts.length; p++) {
        ctx.lineTo(pts[p].x, pts[p].y);
      }
      // Line to current mouse position
      if (state.mousePos) {
        const mouse = px(state.mousePos);
        ctx.lineTo(mouse.x, mouse.y);
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
    if (state.motionMode === 'grid') {
      const cell = gridCellAt(pos);
      if (!cell || !state.motionGrid) return;
      // Right-click always clears; otherwise toggle the first cell and paint that value while dragging
      state.gridPaintValue = e.button === 2 ? false : !state.motionGrid.cells[cell.row][cell.col];
      state.motionGrid.cells[cell.row][cell.col] = state.gridPaintValue;
      state.isDrawing = true; // keeps mousemove events coming until mouseup
      redraw();
      return;
    }
    if (e.button === 2) {
      // Right-click: delete region under cursor
      for (let i = state.motionRegions.length - 1; i >= 0; i--) {
        if (pointInPolygon(pos, state.motionRegions[i].points)) {
          state.motionRegions.splice(i, 1);
          updateRegionList();
          redraw();
          break;
        }
      }
      return;
    }

    const pts = state.drawingPoints;

    // Clicking near the start vertex closes the polygon
    if (pts.length >= 2 && pixelDistance(pos, pts[0], dom.canvas) < CLOSE_DISTANCE_PX) {
      closePolygon();
      return;
    }

    if (state.motionRegions.length >= state.motionCaps.maxRegions && pts.length === 0) {
      showToast(`This camera allows at most ${state.motionCaps.maxRegions} detection regions`, 'error');
      return;
    }

    // The clicks of a double-click land on the same spot — don't add duplicate corners
    const last = pts[pts.length - 1];
    if (last && pixelDistance(pos, last, dom.canvas) < SAME_CORNER_PX) return;

    pts.push({ x: pos.x, y: pos.y });
    if (pts.length >= state.motionCaps.maxPoints) {
      closePolygon();
      return;
    }
    redraw();
  },



  onMouseMove(pos, e) {
    if (state.motionMode === 'grid') {
      const cell = gridCellAt(pos);
      if (cell && state.motionGrid && state.gridPaintValue !== null &&
          state.motionGrid.cells[cell.row][cell.col] !== state.gridPaintValue) {
        state.motionGrid.cells[cell.row][cell.col] = state.gridPaintValue;
        redraw();
      }
      return;
    }
    state.mousePos = pos;
    if (state.drawingPoints.length > 0) {
      redraw();
    }
  },

  onMouseUp(pos, e) {
    state.gridPaintValue = null;
  },

  onDblClick(pos, e) {
    if (state.drawingPoints.length > 0) closePolygon();
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
      const md = readMotionConfig(doc);
      // Polygons whenever the device supports them, as Hikvision's own UI does
      state.motionMode = state.motionCaps.regionTypes.includes('region') || !md.grid ? 'region' : 'grid';
      state.motionGrid = md.grid ? { ...md.grid, cells: md.grid.cells.map(row => [...row]) } : null;
      applyCapabilities();
      byId('dynamicAnalysisRow').style.display = md.supportsDynamicAnalysis ? '' : 'none';

      state.motionEnabled = md.enabled;
      byId('motionToggle').classList.toggle('on', state.motionEnabled);

      if (md.sensitivity !== null) {
        state.sensitivity = md.sensitivity;
        byId('sensitivitySlider', HTMLInputElement).value = String(md.sensitivity);
        byId('sensitivityVal').textContent = String(md.sensitivity);
      }

      state.motionRegions = md.regions.map(points => ({ points: motionRegionToImage(points) }));
      state.drawingPoints = [];

      state.dynamicAnalysis = md.dynamicAnalysis;
      byId('dynamicAnalysisToggle').classList.toggle('on', state.dynamicAnalysis);
      state.detectHuman = md.targetTypes.includes('human');
      state.detectVehicle = md.targetTypes.includes('vehicle');
      byId('detectHuman', HTMLInputElement).checked = state.detectHuman;
      byId('detectVehicle', HTMLInputElement).checked = state.detectVehicle;

      updateRegionList();
      redraw();
      showToast('Motion detection config loaded', 'success');
      setStatus('Config loaded', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to load motion config: ' + errorMessage(err), 'error');
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
    if (state.drawingPoints.length > 0) {
      showToast('Finish or cancel (Esc) the region you are drawing first', 'error');
      return;
    }

    // Snap to the device's sensitivity steps (e.g. 0, 20, … 100)
    const { min, max, step } = caps.sensitivity;
    const rawSensitivity = Number(byId('sensitivitySlider', HTMLInputElement).value);
    const sensitivity = Math.min(max, Math.max(min, min + Math.round((rawSensitivity - min) / step) * step));

    // Edit a copy so a failed save leaves the loaded config intact
    const doc = cloneXml(state.motionDoc);

    setStatus('Saving motion detection config...');
    try {
      applyMotionConfig(doc, {
        mode: state.motionMode,
        grid: state.motionGrid ?? undefined,
        enabled: state.motionEnabled,
        sensitivity,
        dynamicAnalysis: state.dynamicAnalysis,
        regions: state.motionRegions.map(reg => imageToMotionRegion(reg.points)),
        targetTypes: caps.targetTypes.length
          ? caps.targetTypes.filter(t => (t === 'human' && state.detectHuman) || (t === 'vehicle' && state.detectVehicle))
          : undefined,
      });

      const result = await Isapi.putXml(state.config, Isapi.motionDetectionPath(activeChannelInfo()), doc);
      state.motionDoc = doc;
      reportSaved('Motion detection', result);
    } catch (err) {
      showToast('Failed to save: ' + errorMessage(err), 'error');
      setStatus('Save failed');
    }
  },

  bindPanel() {
    byId('motionToggle').addEventListener('click', () => {
      state.motionEnabled = !state.motionEnabled;
      byId('motionToggle').classList.toggle('on', state.motionEnabled);
    });

    byId('sensitivitySlider', HTMLInputElement).addEventListener('input', function () {
      byId('sensitivityVal').textContent = this.value;
    });

    byId('dynamicAnalysisToggle').addEventListener('click', () => {
      state.dynamicAnalysis = !state.dynamicAnalysis;
      byId('dynamicAnalysisToggle').classList.toggle('on', state.dynamicAnalysis);
    });

    byId('detectHuman', HTMLInputElement).addEventListener('change', function () {
      state.detectHuman = this.checked;
    });
    byId('detectVehicle', HTMLInputElement).addEventListener('change', function () {
      state.detectVehicle = this.checked;
    });

    byId('clearMotionRegionsBtn').addEventListener('click', () => {
      state.motionRegions = [];
      state.drawingPoints = [];
      state.motionGrid?.cells.forEach(row => row.fill(false));
      updateRegionList();
      redraw();
    });

    byId('loadMotionBtn').addEventListener('click', () => loadTool('motion'));
    byId('saveMotionBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},

};

/** Render the region list in the sidebar. */
function updateRegionList() {
  const list = byId('motionRegionList');
  if (!list) return;
  list.innerHTML = state.motionRegions.map((r, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;font-family:var(--mono)">
      <span style="color:var(--text-dim)">Region ${i + 1} (${r.points.length} pts)</span>
      <button class="btn btn-danger" style="padding:2px 8px;font-size:10px" data-delete-motion="${i}">x</button>
    </div>
  `).join('');

  queryAll(list, '[data-delete-motion]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.deleteMotion ?? '', 10);
      state.motionRegions.splice(idx, 1);
      updateRegionList();
      redraw();
    });
  });
}

/**
 * Finish the polygon being drawn. Too few corners keeps it open — the
 * device rejects regions below its minimum.
 */
function closePolygon() {
  const { minPoints } = state.motionCaps;
  if (state.drawingPoints.length < minPoints) {
    showToast(`A detection region needs at least ${minPoints} corners`, 'error');
    return;
  }
  state.motionRegions.push({ points: [...state.drawingPoints] });
  state.drawingPoints = [];
  updateRegionList();
  redraw();
}

/** Apply the device's limits to the panel controls. */
function applyCapabilities() {
  const caps = state.motionCaps;
  const slider = byId('sensitivitySlider', HTMLInputElement);
  slider.min = String(caps.sensitivity.min);
  slider.max = String(caps.sensitivity.max);
  slider.step = String(caps.sensitivity.step);
  byId('motionMaxRegions').textContent = String(caps.maxRegions);
  byId('motionPointRange').textContent = `${caps.minPoints}–${caps.maxPoints}`;
  byId('detectHumanLabel').style.display = caps.targetTypes.includes('human') ? '' : 'none';
  byId('detectVehicleLabel').style.display = caps.targetTypes.includes('vehicle') ? '' : 'none';
  byId('targetDetectionRow').style.display = caps.targetTypes.length ? '' : 'none';
  const grid = state.motionMode === 'grid';
  byId('motionRegionInstructions').style.display = grid ? 'none' : '';
  byId('motionGridInstructions').style.display = grid ? '' : 'none';
  byId('motionRegionList').style.display = grid ? 'none' : '';
}

/**
 * The grid cell under a point on the picture, or null outside the grid.
 * @param {import('../../lib/shapes.js').ImagePoint} pos
 * @returns {{row: number, col: number}|null}
 */
function gridCellAt(pos) {
  const grid = state.motionGrid;
  if (!grid) return null;
  const col = Math.floor(pos.x * grid.cols);
  const row = Math.floor(pos.y * grid.rows);
  return row >= 0 && row < grid.rows && col >= 0 && col < grid.cols ? { row, col } : null;
}

/**
 * Draw grid-mode cells: marked cells filled, faint lines for the rest.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 */
function drawGrid(ctx, canvas) {
  const grid = state.motionGrid;
  if (!grid) return;
  const w = canvas.width / grid.cols;
  const h = canvas.height / grid.rows;
  ctx.fillStyle = 'rgba(74, 108, 247, 0.35)';
  grid.cells.forEach((row, r) => row.forEach((on, c) => {
    if (on) ctx.fillRect(c * w, r * h, w, h);
  }));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < grid.cols; c++) { ctx.moveTo(c * w, 0); ctx.lineTo(c * w, canvas.height); }
  for (let r = 1; r < grid.rows; r++) { ctx.moveTo(0, r * h); ctx.lineTo(canvas.width, r * h); }
  ctx.stroke();
}
