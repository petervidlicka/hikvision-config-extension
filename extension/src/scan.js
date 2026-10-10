/**
 * Local network scan for Hikvision devices, and the connection form steps.
 */

import { candidateSubnets, describeFoundDevice, describeScanResults, scanForHikvision } from '../lib/network-scan.js';
import { dom, state } from './state.js';
import { errorMessage, showToast } from './ui.js';

// ─── Network Scanner ─────────────────────────────────────────────────────────

/**
 * Broad access granted only while a scan runs (see startScan). A match
 * pattern without a port matches every port, so this covers the scan's
 * port 8080 probes too.
 */
export const SCAN_ORIGINS = 'http://*/*';

export function showScanIntro() {
  dom.scanIntro.style.display = 'block';
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'none';
}

export function showConnectionForm() {
  dom.scanIntro.style.display = 'none';
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'block';
}

export async function startScan() {
  // Scanning has to probe every address on the subnet, so it needs access to
  // all http:// origins. Ask only for the duration of the scan.
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [SCAN_ORIGINS] });
  } catch (err) {
    showToast('Could not request network access: ' + errorMessage(err), 'error');
    return;
  }
  if (!granted) {
    showToast('Scanning needs network access. You can enter the IP manually instead.', 'error');
    return;
  }

  dom.scanIntro.style.display = 'none';
  dom.scanProgress.style.display = 'block';
  dom.scanResults.style.display = 'none';
  dom.connectionForm.style.display = 'none';

  dom.scanProgressFill.style.width = '0%';
  dom.scanStatusText.textContent = 'Scanning your local network for Hikvision devices…';

  state.scanAbort?.abort();
  const abort = new AbortController();
  state.scanAbort = abort;
  let foundCount = 0;

  try {
    const devices = await scanForHikvision({
      // The last-used host's subnet is the best guess at where the device lives
      subnets: candidateSubnets([dom.hostInput.value.trim()]),
      signal: abort.signal,
      onFound: () => { foundCount++; },
      onProgress: ({ subnet, probed, total }) => {
        dom.scanProgressFill.style.width = `${(probed / total) * 100}%`;
        dom.scanStatusText.textContent = `Scanning ${subnet}.x…` +
          (foundCount ? ` found ${foundCount} device${foundCount > 1 ? 's' : ''}` : '');
      },
    });
    if (!abort.signal.aborted) showScanResults(devices);
  } catch (err) {
    showToast('Scan error: ' + errorMessage(err), 'error');
    showScanResults([]);
  } finally {
    if (state.scanAbort === abort) state.scanAbort = null;
    chrome.permissions.remove({ origins: [SCAN_ORIGINS] }).catch(() => {});
  }
}

export function cancelScan() {
  state.scanAbort?.abort();
  showScanIntro();
}

/**
 * Show the devices a scan found, as cards that fill in the connection form
 * with the address and port each answered on.
 * @param {import('../lib/network-scan.js').FoundDevice[]} devices
 */
export function showScanResults(devices) {
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'block';
  dom.scanResultsText.textContent = describeScanResults(devices);
  dom.scanDeviceList.replaceChildren(...devices.map(deviceCard));
}

/**
 * One found device's card. Clicking it fills in the connection form.
 * @param {import('../lib/network-scan.js').FoundDevice} device
 * @returns {HTMLDivElement}
 */
function deviceCard(device) {
  const { label, note } = describeFoundDevice(device);
  const card = document.createElement('div');
  card.className = 'scan-device-card';
  const ip = document.createElement('div');
  ip.className = 'scan-device-ip';
  ip.textContent = device.ip;
  const labelEl = document.createElement('div');
  labelEl.className = 'scan-device-label';
  labelEl.textContent = label;
  card.append(ip, labelEl);
  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'scan-device-note';
    noteEl.textContent = note;
    card.append(noteEl);
  }
  card.addEventListener('click', () => {
    dom.hostInput.value = device.ip;
    dom.portInput.value = String(device.port);
    showConnectionForm();
  });
  return card;
}
