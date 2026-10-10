/**
 * Registry of configuration tools (motion, privacy, events): builds their
 * tabs and panels, switches between them and drives their loading state.
 */

import { redraw } from '../canvas.js';
import { dom, state } from '../state.js';

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
export const ToolRegistry = {
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

// ─── Initialize Tool Registry ───────────────────────────────────────────────

export function initToolRegistry() {
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

// ─── Tool Switching ─────────────────────────────────────────────────────────

export function switchTool(toolId) {
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
export function setToolPanelLoading(toolId, isLoading) {
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

export function expandConfig() {
  state.configExpanded = true;
  dom.configPanels.style.display = 'block';
  dom.configArrow.textContent = '▾';
}

export function toggleConfig() {
  state.configExpanded = !state.configExpanded;
  dom.configPanels.style.display = state.configExpanded ? 'block' : 'none';
  dom.configArrow.textContent = state.configExpanded ? '▾' : '▸';
}
