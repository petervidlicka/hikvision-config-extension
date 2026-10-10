/**
 * Registry of configuration tools (motion, privacy, events): builds their
 * tabs and panels, switches between them, and drives their loading state
 * and where their loads and saves may land (see ToolLoad and saveTarget).
 */

import { redraw } from '../canvas.js';
import { dom, queryAll, state } from '../state.js';
import { activeChannelInfo, showToast } from '../ui.js';

// ─── Tool Registry ──────────────────────────────────────────────────────────
/** @typedef {import('../state.js').AppState} AppState */
/** @typedef {import('../../lib/shapes.js').ImagePoint} ImagePoint */
/** @typedef {import('../../lib/digest-auth.js').DeviceConfig} DeviceConfig */
/** @typedef {import('../../lib/isapi.js').Channel} Channel */

/**
 * Where a tool's settings were read from. A tool keeps it next to the
 * document it loaded, so its save goes back to that device and channel and
 * only while they are still the ones on screen (see saveTarget).
 * @typedef {object} LoadOrigin
 * @property {DeviceConfig} config - the connection, compared by identity:
 *   reconnecting, even to the same device, starts a new one
 * @property {Channel} channel
 */

/**
 * One run of a tool's load(), handed to it by loadTool. The user can move
 * to another channel, reconnect, or start the load again before the device
 * answers, so a tool checks `stale()` once its requests are done and leaves
 * the panel and its state alone if it's true: a late answer from the
 * previous channel must not replace what the newer load shows, nor give a
 * later save another camera's settings.
 * @typedef {object} ToolLoad
 * @property {LoadOrigin} from - the device and channel to read
 * @property {() => boolean} stale - true once a newer load of the same tool
 *   has started, or another channel or connection is on screen
 */

/**
 * A configuration tool. Each tool owns a sidebar panel, draws on the canvas
 * over the live feed, and loads/saves one ISAPI resource. Pointer positions
 * come as fractions of the picture (see lib/shapes.js), and tools keep their
 * shapes that way, converting to canvas pixels only to draw and hit-test.
 * @typedef {object} Tool
 * @property {string} id - unique key, e.g. "motion"
 * @property {string} label - display name, e.g. "Motion Detection"
 * @property {string} panelHTML - sidebar panel markup (static; no device data)
 * @property {string} [cursor] - CSS cursor over the canvas (default "crosshair")
 * @property {() => Partial<AppState>} initState - initial values of the tool's state fields
 * @property {() => void} resetState - called on channel switch
 * @property {(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void} draw
 * @property {(pos: ImagePoint, e: MouseEvent) => void} onMouseDown
 * @property {(pos: ImagePoint, e: MouseEvent) => void} onMouseMove
 * @property {(pos: ImagePoint, e: MouseEvent) => void} onMouseUp
 * @property {(pos: ImagePoint, e: MouseEvent) => void} [onDblClick]
 * @property {(load: ToolLoad) => Promise<void>} load - read config from the device (run through loadTool)
 * @property {() => Promise<void>} save - write config back where it was loaded from (see saveTarget)
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

/** The number of the latest load started per tool; any earlier one still running is stale. @type {Map<string, number>} */
const latestLoads = new Map();

/**
 * Load a tool's settings for the channel on screen, dimming its panel
 * meanwhile so nobody edits settings that are about to be replaced. Only
 * the latest load of a tool for the channel and connection still on screen
 * fills the panel (see ToolLoad), and only the latest one ends the dimming:
 * an earlier load finishing first must not hand over a panel the newer one
 * is still filling. Tools report their own load errors, so this never
 * rejects for an expected failure.
 * @param {string|null} toolId
 */
export async function loadTool(toolId) {
  const tool = ToolRegistry.get(toolId);
  if (!tool || toolId === null || !state.config || !state.activeChannel) return;
  const run = (latestLoads.get(toolId) ?? 0) + 1;
  latestLoads.set(toolId, run);
  const latest = () => latestLoads.get(toolId) === run;
  /** @type {LoadOrigin} */
  const from = { config: state.config, channel: activeChannelInfo() };
  setToolPanelLoading(toolId, true);
  try {
    await tool.load({ from, stale: () => !latest() || !isOnScreen(from) });
  } finally {
    if (latest()) setToolPanelLoading(toolId, false);
  }
}

/**
 * Whether settings read from `from` belong to what's on screen: the same
 * connection and the selected channel.
 * @param {LoadOrigin} from
 * @returns {boolean}
 */
function isOnScreen(from) {
  return from.config === state.config && from.channel.id === state.activeChannel;
}

/**
 * Where a tool may save what its panel shows: the device and channel its
 * settings were loaded from, provided they are still the ones on screen.
 * Settings of another channel or connection must go nowhere: to the
 * channel on screen they would copy another camera's settings, and to
 * their own, edits made while looking at this one. Says what to do instead
 * when there is nowhere to save.
 * @param {LoadOrigin|null} from - kept by the tool with its loaded document; null when nothing is loaded
 * @returns {LoadOrigin|null} null when the save must not go ahead
 * @example
 * const loaded = state.motionDoc;
 * const from = saveTarget(loaded ? state.motionFrom : null);
 * if (!loaded || !from) return;
 * await Isapi.putXml(from.config, Isapi.motionDetectionPath(from.channel), edited(loaded));
 */
export function saveTarget(from) {
  if (!from) {
    showToast('Load the settings from the device before saving', 'error');
    return null;
  }
  if (from.config !== state.config) {
    showToast('These settings were loaded before reconnecting. Load them from the device again before saving', 'error');
    return null;
  }
  if (from.channel.id !== state.activeChannel) {
    showToast(`These settings were loaded from channel ${from.channel.id}. ` +
      `Load channel ${state.activeChannel}’s from the device before saving`, 'error');
    return null;
  }
  return from;
}

/**
 * Set or clear the loading/disabled state on a tool's sidebar panel.
 * When loading, all interactive elements (inputs, buttons, toggles) are
 * disabled and the panel is visually dimmed so users know the settings
 * haven't been loaded yet.
 *
 * Afterwards each element gets back the state it had before, unless the
 * tool decided it while loading: an element with `data-locked="true"` stays
 * disabled and one with `data-locked="false"` is enabled (e.g. a control the
 * loaded camera doesn't support, set in the tool's load()).
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
      // A load started while another runs keeps the state from before the
      // first: by now every element reads as disabled
      if (el.dataset.wasDisabled === undefined) el.dataset.wasDisabled = el.hasAttribute('disabled') ? 'true' : 'false';
      el.setAttribute('disabled', '');
      if (el.classList.contains('toggle')) el.style.pointerEvents = 'none';
    } else {
      const disabled = el.dataset.locked === undefined ? el.dataset.wasDisabled === 'true' : el.dataset.locked === 'true';
      if (!disabled) el.removeAttribute('disabled');
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
