/**
 * Small UI helpers shared across modules: toasts, status bar, channel names.
 */

import { dom, state } from './state.js';

/** @typedef {import('../lib/isapi.js').Channel} Channel */

/**
 * The active channel with its kind, which decides the ISAPI URL family.
 * @returns {Channel}
 */
export function activeChannelInfo() {
  return state.channels.find(ch => ch.id === state.activeChannel)
    ?? { id: state.activeChannel ?? '', name: '', kind: 'analog' };
}

/**
 * Display name for a channel, falling back to its number.
 * @param {Channel} ch
 */
export function channelLabel(ch) {
  return ch.name || `Channel ${ch.id}`;
}

/**
 * Message of a caught error, which in JavaScript can be any value.
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Show a short-lived message at the bottom of the page.
 * @param {string} msg
 * @param {'info'|'success'|'error'} [type]
 */
export function showToast(msg, type = 'info') {
  dom.toast.textContent = msg;
  dom.toast.className = `toast ${type} show`;
  setTimeout(() => dom.toast.classList.remove('show'), 3000);
}

/**
 * Update the status bar.
 * @param {string} text - left side
 * @param {string} [right] - right side, e.g. the channel
 */
export function setStatus(text, right = '') {
  dom.statusText.textContent = text;
  dom.statusRight.textContent = right;
}
