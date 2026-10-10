/**
 * Registry of configuration tools (motion, privacy, events): builds their
 * tabs and panels, switches between them and drives their loading state.
 */

import { redraw } from '../canvas.js';
import { dom, queryAll, state } from '../state.js';

// ─── Tool Registry ──────────────────────────────────────────────────────────
/** @typedef {import('../state.js').AppState} AppState */
/** @typedef {import('../state.js').CanvasPoint} CanvasPoint */

/**
 * A configuration tool. Each tool owns a sidebar panel, draws on the canvas
 * over the live feed, and loads/saves one ISAPI resource.
 * @typedef {object} Tool
 * @property {string} id - unique key, e.g. "motion"
 * @property {string} label - display name, e.g. "Motion Detection"
 * @property {string} panelHTML - sidebar panel markup (static; no device data)
 * @property {string} [cursor] - CSS cursor over the canvas (default "crosshair")
 * @property {() => Partial<AppState>} initState - initial values of the tool's state fields
 * @property {() => void} resetState - called on channel switch
 * @property {(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void} draw
 * @property {(pos: CanvasPoint, e: MouseEvent) => void} onMouseDown
 * @property {(pos: CanvasPoint, e: MouseEvent) => void} onMouseMove
 * @property {(pos: CanvasPoint, e: MouseEvent) => void} onMouseUp
 * @property {(pos: CanvasPoint, e: MouseEvent) => void} [onDblClick]
 * @property {() => Promise<void>} load - read config from the device
 * @property {() => Promise<void>} save - write config to the device
 * @property {() => void} bindPanel - attach listeners once the panel is in the DOM
 * @property {() => void} [onActivate] - called when the tool becomes active
 */

/**
 * Central registry for configuration tools. It drives tab generation,
 * sidebar panels, canvas event delegation and keyboard shortcuts, so a new
 * tool only needs a definition and a register() call in main.js.
 */
export const ToolRegistry = {
  /** @type {Map<string, Tool>} */
  _tools: new Map(),
  /** @type {string[]} */
  _order: [],

  /** @param {Tool} def */
  register(def) {
    this._tools.set(def.id, def);
    this._order.push(def.id);
  },

  /** @param {string|null} id */
  get(id) { return id === null ? undefined : this._tools.get(id); },

  /** @returns {Tool[]} in registration order */
  getAll() { return this._order.map(id => /** @type {Tool} */ (this._tools.get(id))); },
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
  queryAll(dom.configTabs, '.tool-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTool(tab.dataset.tool ?? ''));
  });

  // Merge initial state from each tool
  tools.forEach(t => {
    Object.assign(state, t.initState());
  });

  // Let each tool bind its panel event listeners (DOM is now ready)
  tools.forEach(t => t.bindPanel());

  // Set default active tool
  state.activeTool = tools[0]?.id || null;
  dom.configToggleLabel.textContent = ToolRegistry.get(state.activeTool)?.label ?? '';
}

// ─── Tool Switching ─────────────────────────────────────────────────────────

/**
 * Make a tool active: tabs, panel, cursor; loads its settings when in
 * the Configuration section.
 * @param {string} toolId
 */
export function switchTool(toolId) {
  const tool = ToolRegistry.get(toolId);
  if (!tool) return;
  state.activeTool = toolId;

  // Update config sub-tab active states
  queryAll(dom.configTabs, '.tool-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tool === toolId);
  });

  // Update sidebar tool panels
  queryAll(dom.configPanels, '.tool-panel').forEach(panel => {
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
  if (state.activeSection === 'config' && state.activeChannel) {
    loadTool(toolId);
  }
}

/**
 * Load a tool's settings from the device, dimming its panel meanwhile so
 * nobody edits settings that are about to be replaced. Tools report their
 * own load errors, so this never rejects for an expected failure.
 * @param {string|null} toolId
 */
export async function loadTool(toolId) {
  const tool = ToolRegistry.get(toolId);
  if (!tool || toolId === null) return;
  setToolPanelLoading(toolId, true);
  try {
    await tool.load();
  } finally {
    setToolPanelLoading(toolId, false);
  }
}

/**
 * Set or clear the loading/disabled state on a tool's sidebar panel.
 * When loading, all interactive elements (inputs, buttons, toggles) are
 * disabled and the panel is visually dimmed so users know the settings
 * haven't been loaded yet.
 * @param {string} toolId
 * @param {boolean} isLoading
 */
export function setToolPanelLoading(toolId, isLoading) {
  const panel = dom.configPanels.querySelector(`[data-tool-panel="${toolId}"]`);
  if (!panel) return;
  panel.classList.toggle('tool-loading', isLoading);
  // Disable/enable all interactive children
  queryAll(panel, 'input, button, select, .toggle').forEach(el => {
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
