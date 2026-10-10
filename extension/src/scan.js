/**
 * Local network scan for Hikvision devices, and the connection form steps.
 */

import { candidateSubnets, scanForHikvision } from '../lib/network-scan.js';
import { dom, state } from './state.js';
import { errorMessage, showToast } from './ui.js';

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
      onProgress: ({ subnet, probed }) => {
        dom.scanProgressFill.style.width = `${(probed / 254) * 100}%`;
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
 * Show the devices a scan found, as cards that fill in the connection form.
 * @param {{ip: string, port: number}[]} devices
 */
export function showScanResults(devices) {
  dom.scanProgress.style.display = 'none';
  dom.scanResults.style.display = 'block';

  if (devices.length === 0) {
    dom.scanResultsText.textContent = 'No Hikvision devices found on your local network. Try entering the IP address manually.';
    dom.scanDeviceList.innerHTML = '';
  } else {
    dom.scanResultsText.textContent = `Found ${devices.length} Hikvision device${devices.length > 1 ? 's' : ''}. Click one to connect:`;
    dom.scanDeviceList.replaceChildren(...devices.map(d => {
      const port = d.port || 80;
      const card = document.createElement('div');
      card.className = 'scan-device-card';
      const ip = document.createElement('div');
      ip.className = 'scan-device-ip';
      ip.textContent = d.ip;
      const label = document.createElement('div');
      label.className = 'scan-device-label';
      label.textContent = `Hikvision NVR / Camera • Port ${port}`;
      card.append(ip, label);
      card.addEventListener('click', () => {
        dom.hostInput.value = d.ip;
        dom.portInput.value = String(port);
        showConnectionForm();
      });
      return card;
    }));
  }
}
