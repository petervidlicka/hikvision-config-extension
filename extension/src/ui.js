/**
 * Small UI helpers shared across modules: toasts, status bar, channel names.
 */

import { dom, state } from './state.js';

/**
 * The active channel with its kind, which decides the ISAPI URL family.
 * @returns {{id: string, name: string, kind: 'analog'|'digital'}}
 */
export function activeChannelInfo() {
  return state.channels.find(ch => ch.id === state.activeChannel)
    ?? { id: state.activeChannel, name: '', kind: 'analog' };
}

/** Display name for a channel, falling back to its number. */
export function channelLabel(ch) {
  return ch.name || `Channel ${ch.id}`;
}

export function showToast(msg, type = 'info') {
  dom.toast.textContent = msg;
  dom.toast.className = `toast ${type} show`;
  setTimeout(() => dom.toast.classList.remove('show'), 3000);
}

export function setStatus(text, right = '') {
  dom.statusText.textContent = text;
  dom.statusRight.textContent = right;
}
