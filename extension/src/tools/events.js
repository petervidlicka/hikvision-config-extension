/**
 * Event actions tool: what the device does when motion is detected.
 *
 * Each toggle stands for one notification entry on the channel's motion
 * (VMD) trigger, resolved per channel from what the device offers
 * (resolveEventActions): record this channel, switch this camera's relay,
 * flash its light, sound its speaker. A toggle the device or this channel's
 * camera can't do is disabled, with a hint saying why.
 */

import { applyNotifications, hasNotification, resolveEventActions } from '../../lib/config-xml.js';
import { Isapi } from '../../lib/isapi.js';
import { byId, query, state } from '../state.js';
import { loadTool, saveTarget } from './registry.js';
import { errorMessage, reportSaveFailed, reportSaved, setStatus, showToast } from '../ui.js';
import { cloneXml } from '../../lib/xml.js';

/** @typedef {import('../../lib/config-xml.js').EventActionKey} EventActionKey */
/** @typedef {import('../../lib/config-xml.js').EventActionUnavailable} EventActionUnavailable */

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Event Actions (motion detection linkage methods)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The linkage actions offered for motion events, in display order. Which
 * notification entry each one writes depends on the device and channel, so
 * it's resolved on load (resolveEventActions), keyed by `key`.
 * @type {{key: EventActionKey, label: string, description: string}[]}
 */
export const EVENT_ACTIONS = [
  { key: 'record',     label: 'Record Video',       description: 'Record to NVR when motion is detected' },
  { key: 'center',     label: 'Push Notification',  description: 'Send alert to Hik-Connect mobile app' },
  { key: 'email',      label: 'Email Alert',        description: 'Send email with snapshot attached' },
  { key: 'beep',       label: 'Audible Warning',    description: 'NVR local buzzer' },
  { key: 'IO',         label: 'Alarm Output',       description: 'Trigger physical alarm relay' },
  { key: 'whiteLight', label: 'White Light',        description: 'Flash camera spotlight LED' },
  { key: 'audio',      label: 'Audio Alarm',        description: 'Play warning from camera speaker' },
];

/**
 * What a disabled toggle says when hovered.
 * @type {Record<EventActionUnavailable, string>}
 */
const UNAVAILABLE_HINTS = {
  notSupported: 'Not supported by this device',
  noAlarmOutput: 'This camera has no alarm output',
  noWhiteLight: 'This camera has no white light',
  noSpeaker: 'This camera has no speaker',
};

/**
 * Show the toggles as the state has them: on or off, and disabled with a
 * hint where the loaded channel can't use the action.
 */
function showToggles() {
  EVENT_ACTIONS.forEach(a => {
    const unavailable = state.eventActionTargets?.[a.key].unavailable ?? null;
    const hint = unavailable ? UNAVAILABLE_HINTS[unavailable] : null;
    const row = byId(`eventRow_${a.key}`);
    row.classList.toggle('unavailable', unavailable !== null);
    row.title = hint ?? '';
    // The label's own title (the description) would win over the row's when hovered
    query(row, 'span').title = hint ?? a.description;
    const toggle = byId(`eventToggle_${a.key}`);
    toggle.classList.toggle('on', state.eventActions[a.key]);
    toggle.setAttribute('aria-disabled', String(unavailable !== null));
  });
}

/** @typedef {import('./registry.js').Tool} Tool */

/** @satisfies {Tool} */
export const eventsTool = {
  id: 'events',
  label: 'Event Actions',
  cursor: 'default',

  panelHTML: `
    <div class="event-actions-info">
      When motion is detected on this channel, perform these actions:
    </div>
    ${EVENT_ACTIONS.map(a => `
      <div class="toggle-row" id="eventRow_${a.key}">
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
    /** @type {Record<string, boolean>} */
    const eventActions = {};
    EVENT_ACTIONS.forEach(a => { eventActions[a.key] = false; });
    return {
      eventActions,
      eventTriggerDoc: null,
      eventTriggerFrom: null,
      eventActionTargets: null,
    };
  },

  resetState() {
    EVENT_ACTIONS.forEach(a => { state.eventActions[a.key] = false; });
    state.eventTriggerDoc = null;
    state.eventTriggerFrom = null;
    state.eventActionTargets = null;
    showToggles();
  },

  draw(ctx, canvas) {
    // No canvas overlay for event actions
  },

  onMouseDown(pos, e) {},
  onMouseMove(pos, e) {},
  onMouseUp(pos, e) {},

  async load({ from, stale }) {
    const { config, channel } = from;
    setStatus('Loading event actions...');
    try {
      const [doc, support] = await Promise.all([
        Isapi.getEventTrigger(config, channel.id),
        Isapi.getEventActionSupport(config),
      ]);
      // The newer load, or the channel moved on to, fills the panel
      if (stale()) return;
      const targets = resolveEventActions(doc, support, channel);
      state.eventTriggerDoc = doc;
      state.eventTriggerFrom = from;
      state.eventActionTargets = targets;
      EVENT_ACTIONS.forEach(a => {
        const { spec } = targets[a.key];
        state.eventActions[a.key] = spec !== null && hasNotification(doc, spec);
      });
      showToggles();

      showToast('Event actions loaded', 'success');
      setStatus('Config loaded', `Channel ${channel.id}`);
    } catch (err) {
      if (stale()) return;
      showToast('Failed to load event actions: ' + errorMessage(err), 'error');
      setStatus('Failed to load config');
    }
  },

  async save() {
    const loaded = state.eventTriggerDoc;
    const targets = state.eventActionTargets;
    const from = saveTarget(loaded && targets ? state.eventTriggerFrom : null);
    if (!loaded || !targets || !from) return;
    const channelId = from.channel.id;

    // Only the actions this channel can use; any other entries stay as loaded
    const doc = cloneXml(loaded);
    applyNotifications(doc, EVENT_ACTIONS.flatMap(a => {
      const { spec, unavailable } = targets[a.key];
      return spec && !unavailable ? [{ spec, enabled: state.eventActions[a.key] }] : [];
    }));

    setStatus('Saving event actions...');
    try {
      const result = await Isapi.putXml(from.config, Isapi.eventTriggerSavePath(loaded, channelId), doc);
      // Only while the panel still holds the trigger this save started from:
      // after a switch it holds another channel's, and a later save of that
      // channel's toggles must not go to this trigger.
      if (state.eventTriggerDoc === loaded) state.eventTriggerDoc = doc;
      reportSaved('Event actions', result, channelId);
    } catch (err) {
      reportSaveFailed('event actions', err, channelId);
    }
  },

  bindPanel() {
    // Bind toggle clicks
    EVENT_ACTIONS.forEach(a => {
      const toggle = byId(`eventToggle_${a.key}`);
      toggle.addEventListener('click', () => {
        if (state.eventActionTargets?.[a.key].unavailable) return;
        state.eventActions[a.key] = !state.eventActions[a.key];
        toggle.classList.toggle('on', state.eventActions[a.key]);
      });
    });

    byId('loadEventsBtn').addEventListener('click', () => loadTool('events'));
    byId('saveEventsBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},
};
