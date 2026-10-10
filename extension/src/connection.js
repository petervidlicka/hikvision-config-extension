/**
 * Connecting to and disconnecting from the device, and remembering the
 * connection details.
 */

import { applyStreamSizes } from '../lib/channels.js';
import { NOT_ACTIVATED_MESSAGE, checkActivation } from '../lib/device-probe.js';
import { AuthError, forgetDigestSessions } from '../lib/digest-auth.js';
import { NetworkError } from '../lib/errors.js';
import { Isapi, TIMEOUT_MS } from '../lib/isapi.js';
import { clearFrame, stopAllGridFeeds, stopSnapshotFeed } from './feed.js';
import { showConnectionForm, showScanIntro } from './scan.js';
import { dom, state } from './state.js';
import { ToolRegistry } from './tools/registry.js';
import { channelLabel, errorMessage, setStatus, showToast } from './ui.js';
import { selectChannel, switchSection } from './views.js';
import { resetPlayback } from './playback.js';

/**
 * The device rejected our credentials mid-session (password changed, device
 * reset, account locked). Stop every feed immediately — each further request
 * counts as a failed login and Hikvision locks the account after a few.
 *
 * A lock isn't the password's fault (the right one is refused too until it
 * lifts), so the password stays and the message says how long to wait.
 * @param {AuthError} err
 */
export function handleAuthFailure(err) {
  if (!state.connected) return;
  disconnect();
  showConnectionForm();
  if (err.locked) {
    showToast(err.message, 'error');
    return;
  }
  dom.passInput.value = '';
  showToast(err.attemptsLeft !== undefined
    ? `${err.message}. Re-enter the password to reconnect.`
    : 'The device rejected the login. Re-enter the password to reconnect.', 'error');
}
// ─── Connection ─────────────────────────────────────────────────────────────

export async function connect() {
  const host = dom.hostInput.value.trim();
  const port = dom.portInput.value.trim() || '80';
  const username = dom.userInput.value.trim();
  const password = dom.passInput.value;

  if (!host || !username || !password) {
    showToast('Please fill in all connection fields', 'error');
    return;
  }

  // Access is granted per device. This must be the first await so Chrome
  // still treats the call as part of the click / Enter key press.
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [`http://${host}/*`] });
  } catch {
    showToast(`"${host}" is not a valid IP address or hostname`, 'error');
    return;
  }
  if (!granted) {
    showToast('Access to the device was not granted, so the extension cannot reach it.', 'error');
    return;
  }

  state.config = { host, port: parseInt(port), username, password };
  dom.connectBtn.innerHTML = '<span class="loading"></span> Connecting...';
  dom.connectBtn.disabled = true;
  setStatus('Connecting to ' + host + '...');

  try {
    const dev = await Isapi.getDeviceInfo(state.config);
    saveConnectionDetails(host, port, username, password);

    state.connected = true;
    dom.statusDot.classList.add('connected');
    dom.deviceInfo.textContent =
      `${dev.deviceName || dev.model || 'Device'} • FW ${dev.firmwareVersion || 'N/A'}`;

    showToast('Connected successfully!', 'success');
    setStatus('Connected', host);

    dom.connectionForm.style.display = 'none';
    dom.connectionStatus.style.display = 'flex';
    dom.connectedHost.textContent = host;

    await loadChannels();
  } catch (err) {
    showToast('Connection failed: ' + await connectFailureMessage(err, host, port), 'error');
    setStatus('Connection failed');
    dom.statusDot.classList.remove('connected');
  } finally {
    dom.connectBtn.disabled = false;
    if (dom.connectBtn.querySelector('.loading')) dom.connectBtn.textContent = 'Connect';
  }
}

/**
 * Why Connect failed, in words the user can act on. When nothing answers at
 * all (refused, unreachable or timed out), the address is almost always
 * wrong, so say which address was tried. When the device refuses the login
 * without saying why, it may not have been activated yet: then no password
 * works, so asking for another would only cost failed logins. The device
 * is asked without a login, which costs no attempt.
 * @param {unknown} err
 * @param {string} host
 * @param {string} port
 * @returns {Promise<string>}
 */
async function connectFailureMessage(err, host, port) {
  if (err instanceof NetworkError) return `No response from ${host}:${port} — check the IP address and port`;
  if (isUnexplainedRejection(err) && await isNotActivated(host, port)) return NOT_ACTIVATED_MESSAGE;
  return errorMessage(err);
}

/**
 * A rejected login the device didn't explain: no lock and no attempts left,
 * which only an activated device's accounts have.
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnexplainedRejection(err) {
  return err instanceof AuthError && !err.locked && err.attemptsLeft === undefined;
}

/**
 * Whether the device says it hasn't been activated. Not knowing (older
 * firmware without /SDK/activateStatus, or no answer) counts as activated.
 * @param {string} host
 * @param {string} port
 * @returns {Promise<boolean>}
 */
async function isNotActivated(host, port) {
  const status = await checkActivation({ host, port }, { timeoutMs: TIMEOUT_MS.connect });
  return status?.activated === false;
}

/**
 * Remember connection details. The password goes to session storage (memory
 * only, cleared when Chrome closes) unless the user opted to keep it on disk.
 * @param {string} host
 * @param {string} port
 * @param {string} username
 * @param {string} password
 */
export function saveConnectionDetails(host, port, username, password) {
  const remember = dom.savePassCheck.checked;
  chrome.storage.local.set({ host, port, username, savePassword: remember });
  if (remember) {
    chrome.storage.local.set({ password });
  } else {
    chrome.storage.local.remove('password');
  }
  chrome.storage.session.set({ password });
}

export function disconnect() {
  // The next Connect starts from a fresh challenge, so a password changed
  // meanwhile costs one failed login there, not two
  if (state.config) forgetDigestSessions(state.config);

  // Stop all feeds
  resetPlayback();
  stopSnapshotFeed();
  stopAllGridFeeds();
  clearFrame(dom.videoFeed);

  // Reset state
  state.connected = false;
  state.config = null;
  state.channels = [];
  state.activeChannel = null;
  state.viewMode = 'single';
  state.gridCellChannels = [null, null, null, null];
  state.activeSection = 'liveview';
  state.gridExpandedCell = null;

  // Reset tool state, and what was read about this device's hardware
  ToolRegistry.getAll().forEach(t => t.resetState());
  Isapi.clearDeviceCache();

  // Collapse config section
  state.configExpanded = false;
  dom.configPanels.style.display = 'none';
  dom.configArrow.textContent = '▸';

  // Reset UI
  showScanIntro();
  dom.connectionStatus.style.display = 'none';
  dom.channelsSection.style.display = 'none';
  dom.toolConfigSection.style.display = 'none';
  dom.sectionTabs.style.display = 'none';
  dom.toolTabs.style.display = 'none';
  dom.statusDot.classList.remove('connected');
  dom.deviceInfo.textContent = 'Not connected';
  dom.noFeed.style.display = '';
  dom.canvasWrapper.style.display = 'none';
  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';
  setStatus('Ready');
}

/**
 * Fetch the channel list, with each camera's picture size (which the live
 * view shows its pictures' aspect by), and show it in the sidebar.
 */
export async function loadChannels() {
  if (!state.config) return;
  try {
    const channels = await Isapi.getChannels(state.config);
    state.channels = applyStreamSizes(channels, await Isapi.getStreamSizes(state.config));
    dom.channelList.innerHTML = '';

    state.channels.forEach((ch, i) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (i === 0 ? ' active' : '');
      // The device says the camera isn't connected; its feed may stay empty
      if (ch.online === false) {
        div.classList.add('offline');
        div.title = 'Offline';
      }
      // Names come from the device — never parse them as HTML
      const num = document.createElement('div');
      num.className = 'ch-num';
      num.textContent = ch.id;
      const label = document.createElement('span');
      label.textContent = channelLabel(ch);
      div.append(num, label);
      div.addEventListener('click', () => selectChannel(ch.id, div));
      dom.channelList.appendChild(div);
    });

    dom.channelsSection.style.display = 'block';
    dom.sectionTabs.style.display = 'flex';
    dom.toolTabs.style.display = 'flex';

    // Default to Live View after login
    switchSection('liveview');

    if (state.channels.length > 0) {
      selectChannel(state.channels[0].id, dom.channelList.children[0]);
    }
  } catch (err) {
    showToast('Failed to load channels: ' + errorMessage(err), 'error');
  }
}


/**
 * Prefill the login form. The password comes from session storage unless
 * the user chose to remember it on disk.
 */
export function loadSavedCredentials() {
  chrome.storage.local.get(['host', 'port', 'username', 'password', 'savePassword'], async (data) => {
    if (data.host) dom.hostInput.value = String(data.host);
    if (data.port) dom.portInput.value = String(data.port);
    if (data.username) dom.userInput.value = String(data.username);
    if (data.savePassword) {
      dom.savePassCheck.checked = true;
      if (data.password) dom.passInput.value = String(data.password);
      return;
    }
    // Clean up a password left on disk by older versions that saved it unconditionally
    if (data.password) chrome.storage.local.remove('password');
    const session = await chrome.storage.session.get('password');
    if (session.password) dom.passInput.value = String(session.password);
  });

}
