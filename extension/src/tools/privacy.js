/**
 * Privacy mask tool: draw rectangular masks over the image.
 */

import { applyPrivacyMask, readPrivacyMask } from '../../lib/config-xml.js';
import { Isapi } from '../../lib/isapi.js';
import { redraw } from '../canvas.js';
import { byId, dom, queryAll, state } from '../state.js';
import { loadTool } from './registry.js';
import { activeChannelInfo, errorMessage, setStatus, showToast } from '../ui.js';
import { cloneXml } from '../../lib/xml.js';

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Privacy Mask
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {import('./registry.js').Tool} Tool */

/** @satisfies {Tool} */
export const privacyTool = {
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
          updateRegionList();
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
        updateRegionList();
      }
    }
  },

  async load() {
    if (!state.config || !state.activeChannel) return;
    setStatus('Loading privacy mask config...');
    try {
      const { doc, path } = await Isapi.getPrivacyMask(state.config, activeChannelInfo());
      state.privacyDoc = doc;
      state.privacyPath = path;
      const pm = readPrivacyMask(doc);

      state.privacyEnabled = pm.enabled;
      byId('privacyToggle').classList.toggle('on', state.privacyEnabled);

      // Use the coordinate space the device declares; otherwise guess between
      // the 704x576 grid of older firmware and a 0–10000 normalized range
      const allPoints = pm.regions.flat();
      state.privacyNormW = pm.screen?.width ?? (allPoints.some(p => p.x > 1000) ? 10000 : 704);
      state.privacyNormH = pm.screen?.height ?? (allPoints.some(p => p.y > 1000) ? 10000 : 576);

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

      updateRegionList();
      redraw();
      showToast('Privacy mask config loaded', 'success');
      setStatus('Config loaded', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to load privacy mask: ' + errorMessage(err), 'error');
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
    const doc = cloneXml(state.privacyDoc);

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
      await Isapi.putXml(state.config, /** @type {string} */ (state.privacyPath), doc);
      state.privacyDoc = doc;
      showToast('Privacy mask saved successfully!', 'success');
      setStatus('Config saved', `Channel ${state.activeChannel}`);
    } catch (err) {
      showToast('Failed to save: ' + errorMessage(err), 'error');
      setStatus('Save failed');
    }
  },

  bindPanel() {
    byId('privacyToggle').addEventListener('click', () => {
      state.privacyEnabled = !state.privacyEnabled;
      byId('privacyToggle').classList.toggle('on', state.privacyEnabled);
    });

    byId('clearPrivacyBtn').addEventListener('click', () => {
      state.privacyRegions = [];
      updateRegionList();
      redraw();
    });

    byId('loadPrivacyBtn').addEventListener('click', () => loadTool('privacy'));
    byId('savePrivacyBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},
};

/** Render the region list in the sidebar. */
function updateRegionList() {
  const list = byId('privacyRegionList');
  list.innerHTML = state.privacyRegions.map((r, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;font-family:var(--mono)">
      <span style="color:var(--text-dim)">Region ${i + 1}</span>
      <button class="btn btn-danger" style="padding:2px 8px;font-size:10px" data-delete="${i}">x</button>
    </div>
  `).join('');

  queryAll(list, '[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.delete ?? '', 10);
      state.privacyRegions.splice(idx, 1);
      updateRegionList();
      redraw();
    });
  });
}
