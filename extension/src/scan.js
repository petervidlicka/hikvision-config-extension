/**
 * Local network scan for Hikvision devices, and the connection form steps.
 */

import { candidateSubnets, scanForHikvision } from '../lib/network-scan.js';
import { dom, state } from './state.js';
import { showToast } from './ui.js';

// ─── Network Scanner ─────────────────────────────────────────────────────────

/** Broad access granted only while a scan runs (see startScan). */
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
    showToast('Could not request network access: ' + err.message, 'error');
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
      onProgress: ({ subnet, probed }) => {
        dom.scanProgressFill.style.width = `${(probed / 254) * 100}%`;
        dom.scanStatusText.textContent = `Scanning ${subnet}.x…` +
          (foundCount ? ` found ${foundCount} device${foundCount > 1 ? 's' : ''}` : '');
      },
    });
    if (!abort.signal.aborted) showScanResults(devices);
  } catch (err) {
    showToast('Scan error: ' + err.message, 'error');
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

export function showScanResults(devices) {
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'block';

  if (devices.length === 0) {
    dom.scanResultsText.textContent = 'No Hikvision devices found on your local network. Try entering the IP address manually.';
    dom.scanDeviceList.innerHTML = '';
  } else {
    dom.scanResultsText.textContent = `Found ${devices.length} Hikvision device${devices.length > 1 ? 's' : ''}. Click one to connect:`;
    dom.scanDeviceList.innerHTML = devices.map(d => `
      <div class="scan-device-card" data-ip="${d.ip}" data-port="${d.port || 80}">
        <div class="scan-device-ip">${d.ip}</div>
        <div class="scan-device-label">Hikvision NVR / Camera &bull; Port ${d.port || 80}</div>
      </div>
    `).join('');

    dom.scanDeviceList.querySelectorAll('.scan-device-card').forEach(card => {
      card.addEventListener('click', () => {
        dom.hostInput.value = card.dataset.ip;
        dom.portInput.value = card.dataset.port;
        showConnectionForm();
      });
    });
  }
}
