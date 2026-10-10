/**
 * Event actions tool: what the device does when motion is detected.
 */

import { applyNotificationMethods, readNotificationMethods } from '../../lib/config-xml.js';
import { Isapi } from '../../lib/isapi.js';
import { byId, state } from '../state.js';
import { loadTool } from './registry.js';
import { errorMessage, reportSaved, setStatus, showToast } from '../ui.js';
import { cloneXml } from '../../lib/xml.js';

// ═══════════════════════════════════════════════════════════════════════════
// TOOL: Event Actions (motion detection linkage methods)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Defines the linkage actions available for motion detection events.
 * Each entry maps a human-readable label to a Hikvision notificationMethod value.
 */
export const EVENT_ACTIONS = [
  { key: 'record',     method: 'record',     label: 'Record Video',       description: 'Record to NVR when motion is detected' },
  { key: 'center',     method: 'center',     label: 'Push Notification',  description: 'Send alert to Hik-Connect mobile app' },
  { key: 'email',      method: 'email',      label: 'Email Alert',        description: 'Send email with snapshot attached' },
  { key: 'beep',       method: 'beep',       label: 'Audible Warning',    description: 'NVR local buzzer' },
  { key: 'IO',         method: 'IO',         label: 'Alarm Output',       description: 'Trigger physical alarm relay' },
  { key: 'whiteLight', method: 'whiteLight', label: 'White Light',        description: 'Flash camera spotlight LED' },
  { key: 'audio',      method: 'audio',      label: 'Audio Alarm',        description: 'Play warning from camera speaker' },
];

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
    /** @type {Record<string, boolean>} */
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
      showToast('Failed to load event actions: ' + errorMessage(err), 'error');
      setStatus('Failed to load config');
    }
  },

  async save() {
    if (!state.config || !state.activeChannel) return;
    if (!state.eventTriggerDoc) {
      showToast('Load the settings from the device before saving', 'error');
      return;
    }

    const doc = cloneXml(state.eventTriggerDoc);
    applyNotificationMethods(doc, {
      managed: EVENT_ACTIONS.map(a => a.method),
      enabled: new Set(EVENT_ACTIONS.filter(a => state.eventActions[a.key]).map(a => a.method)),
      channelId: state.activeChannel,
    });

    setStatus('Saving event actions...');
    try {
      const result = await Isapi.putXml(state.config, Isapi.eventTriggerPath(state.activeChannel), doc);
      state.eventTriggerDoc = doc;
      reportSaved('Event actions', result);
    } catch (err) {
      showToast('Failed to save event actions: ' + errorMessage(err), 'error');
      setStatus('Save failed');
    }
  },

  bindPanel() {
    // Bind toggle clicks
    EVENT_ACTIONS.forEach(a => {
      const toggle = byId(`eventToggle_${a.key}`);
      toggle.addEventListener('click', () => {
        state.eventActions[a.key] = !state.eventActions[a.key];
        toggle.classList.toggle('on', state.eventActions[a.key]);
      });
    });

    byId('loadEventsBtn').addEventListener('click', () => loadTool('events'));
    byId('saveEventsBtn').addEventListener('click', () => this.save());
  },

  onActivate() {},
};
