/**
 * Privacy mask tool: draw rectangular masks over the image. Masks are kept
 * as fractions of the picture (lib/shapes.js); device coordinates (Y from
 * the bottom) are mapped by the helpers in lib/config-xml.js, and
 * Isapi.savePrivacyMask does the save.
 */

import {
  DEFAULT_PRIVACY_SCREEN, imageRectToPrivacy, privacyRegionToImage, readPrivacyMask,
} from '../../lib/config-xml.js';
import { Isapi } from '../../lib/isapi.js';
import { rectContains, rectFromCorners, rectToPixels } from '../../lib/shapes.js';
import { redraw } from '../canvas.js';
import { byId, dom, queryAll, state } from '../state.js';
import { loadTool, saveTarget } from './registry.js';
import { errorMessage, reportSaveFailed, reportSaved, setStatus, showToast } from '../ui.js';

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Privacy Mask
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {import('./registry.js').Tool} Tool */

/** A drag smaller than this on either side, in canvas pixels (screen pixels, see resizeCanvas), draws no mask. */
const MIN_MASK_SIDE_PX = 10;

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
      privacyFrom: null,
    };
  },

  resetState() {
    state.privacyRegions = [];
    state.privacyDoc = null;
    state.privacyPath = null;
    state.privacyFrom = null;
    state.privacyNormW = 704;
    state.privacyNormH = 576;
  },

  draw(ctx, canvas) {
    state.privacyRegions.forEach((mask, i) => {
      const reg = rectToPixels(mask, canvas);
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
      const { x, y, w, h } = rectToPixels(rectFromCorners(state.drawStart, state.drawCurrent), canvas);
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
        if (rectContains(state.privacyRegions[i], pos)) {
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
      const mask = rectFromCorners(state.drawStart, pos);
      const { w, h } = rectToPixels(mask, dom.canvas);
      if (w > MIN_MASK_SIDE_PX && h > MIN_MASK_SIDE_PX) {
        state.privacyRegions.push(mask);
        updateRegionList();
      }
    }
  },

  async load({ from, stale }) {
    setStatus('Loading privacy mask config...');
    try {
      const { doc, path } = await Isapi.getPrivacyMask(from.config, from.channel);
      // The newer load, or the channel moved on to, fills the panel
      if (stale()) return;
      state.privacyDoc = doc;
      state.privacyPath = path;
      state.privacyFrom = from;
      const pm = readPrivacyMask(doc);

      state.privacyEnabled = pm.enabled;
      byId('privacyToggle').classList.toggle('on', state.privacyEnabled);

      // The coordinate space the device declares, else the web UI's default
      const screen = pm.screen ?? DEFAULT_PRIVACY_SCREEN;
      state.privacyNormW = screen.width;
      state.privacyNormH = screen.height;
      state.privacyRegions = pm.regions.map(points => privacyRegionToImage(points, screen));

      updateRegionList();
      redraw();
      showToast('Privacy mask config loaded', 'success');
      setStatus('Config loaded', `Channel ${from.channel.id}`);
    } catch (err) {
      if (stale()) return;
      showToast('Failed to load privacy mask: ' + errorMessage(err), 'error');
      setStatus('Failed to load config');
    }
  },

  async save() {
    const loaded = state.privacyDoc;
    const path = state.privacyPath;
    const from = saveTarget(loaded && path ? state.privacyFrom : null);
    if (!loaded || !path || !from) return;

    // The same coordinate space as on load
    const screen = { width: state.privacyNormW, height: state.privacyNormH };
    const mask = {
      enabled: state.privacyEnabled,
      rects: state.privacyRegions.map(rect => imageRectToPrivacy(rect, screen)),
    };

    setStatus('Saving privacy mask config...');
    try {
      const { doc, result } = await Isapi.savePrivacyMask(from.config, path, loaded, mask);
      // Only while the panel still holds what this save started from (see motion's save)
      if (state.privacyDoc === loaded) state.privacyDoc = doc;
      reportSaved('Privacy mask', result, from.channel.id);
    } catch (err) {
      reportSaveFailed('privacy mask', err, from.channel.id);
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
