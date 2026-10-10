/**
 * Local network scanner for Hikvision devices.
 *
 * Extensions can't read the machine's own IP (chrome.system.network is
 * Chrome Apps only), so we probe likely /24 subnets in order of preference.
 * Probes run through a small pool rather than all at once: firing hundreds
 * of connections together overflows Chrome's socket pool and the OS ARP
 * queue, and real devices then miss their timeout.
 *
 * A device that asks for a Digest login like ISAPI does is a candidate; one
 * that also answers /SDK/activateStatus is a confirmed Hikvision (see
 * lib/device-probe.js). Candidates that don't confirm are still listed, as
 * possible devices: older firmware may not have that endpoint.
 *
 * Depends on lib/device-probe.js.
 */

import { asksForDigestLogin, checkActivation } from './device-probe.js';

/** Subnets most home/office routers hand out, tried after any known subnet. */
export const COMMON_SUBNETS = ['192.168.0', '192.168.1', '192.168.2', '10.0.0', '10.0.1'];

export const PROBE_CONCURRENCY = 48;
export const PROBE_TIMEOUT_MS = 1200;

/** The note on a device that must be activated before anyone can log in. */
export const NOT_ACTIVATED_HINT = 'Not activated — activate it with Hikvision SADP or its web page first';

/**
 * A device the scan found.
 * @typedef {object} FoundDevice
 * @property {string} ip
 * @property {number} port - the HTTP port it answered on
 * @property {boolean} confirmed - it said it is a Hikvision (/SDK/activateStatus); false: it only
 *   asks for a login like one, so it may be older Hikvision firmware or another brand's device
 * @property {boolean|null} activated - false: it must be activated before anyone can log in;
 *   null when unknown (always for a device that isn't confirmed)
 */

/**
 * Probe one address on one port. Hikvision ISAPI answers unauthenticated
 * requests with 401 and a Digest challenge; anything else isn't a candidate.
 * A candidate is then asked, also without a login, whether it is a
 * Hikvision and has been activated.
 * @param {string} ip
 * @param {number} port
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - the time limit applies to each request
 * @returns {Promise<FoundDevice|null>} null when it isn't a candidate
 */
export async function probeHikvision(ip, port, { signal, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const address = { host: ip, port };
  if (!(await asksForDigestLogin(address, { signal, timeoutMs }))) return null;
  const status = await checkActivation(address, { signal, timeoutMs });
  return { ip, port, confirmed: status !== null, activated: status?.activated ?? null };
}

/**
 * Order the subnets to scan: those of previously used hosts first, then the
 * common defaults, without duplicates.
 *
 * @param {string[]} knownHosts - e.g. the last host the user connected to
 * @returns {string[]} subnet prefixes like "192.168.0"
 */
export function candidateSubnets(knownHosts = []) {
  const known = knownHosts
    .map(h => /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(h || '')?.[1])
    .filter(/** @returns {s is string} */ s => Boolean(s));
  return [...new Set([...known, ...COMMON_SUBNETS])];
}

/**
 * What a found device's card says. A device that hasn't been activated gets
 * a note saying what to do first, since no password works until it is.
 * @param {FoundDevice} device
 * @returns {{label: string, note: string|null}}
 * @example
 * describeFoundDevice({ ip: '192.168.0.64', port: 8080, confirmed: false, activated: null })
 * // → {label: 'Possible Hikvision device • Port 8080', note: null}
 */
export function describeFoundDevice({ port, confirmed, activated }) {
  return {
    label: `${confirmed ? 'Hikvision NVR / Camera' : 'Possible Hikvision device'} • Port ${port}`,
    note: activated === false ? NOT_ACTIVATED_HINT : null,
  };
}

/**
 * The line above the scan results. Devices that didn't confirm they are
 * Hikvision aren't counted as such.
 * @param {FoundDevice[]} devices
 * @returns {string}
 */
export function describeScanResults(devices) {
  const count = devices.length;
  if (count === 0) return 'No Hikvision devices found on your local network. Try entering the IP address manually.';
  const plural = count > 1 ? 's' : '';
  return devices.every(d => d.confirmed)
    ? `Found ${count} Hikvision device${plural}. Click one to connect:`
    : `Found ${count} device${plural} that may be Hikvision. Click one to connect:`;
}

/**
 * Scan subnets one at a time and stop after the first subnet that contains a
 * device — the remaining subnets are only guesses, so scanning them would
 * just make the user wait.
 *
 * @param {object} options
 * @param {string[]} options.subnets - prefixes from candidateSubnets()
 * @param {AbortSignal} [options.signal] - cancels the scan
 * @param {number} [options.probeTimeoutMs] - how long to wait for each request
 * @param {(device: FoundDevice) => void} [options.onFound]
 * @param {(progress: {subnet: string, probed: number, total: number}) => void} [options.onProgress]
 *   `probed` counts the addresses checked in the current subnet, out of `total` (254).
 * @returns {Promise<FoundDevice[]>} in address order
 */
export async function scanForHikvision({ subnets, signal, onFound, onProgress, probeTimeoutMs = PROBE_TIMEOUT_MS }) {
  /** @type {FoundDevice[]} */
  const found = [];

  for (const subnet of subnets) {
    let probed = 0;
    const queue = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
    const total = queue.length;
    const worker = async () => {
      while (queue.length > 0 && !signal?.aborted) {
        const ip = /** @type {string} */ (queue.shift());
        const device = await probeHikvision(ip, 80, { signal, timeoutMs: probeTimeoutMs });
        if (device && !signal?.aborted) {
          found.push(device);
          onFound?.(device);
        }
        probed++;
        onProgress?.({ subnet, probed, total });
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

    if (signal?.aborted || found.length > 0) break;
  }

  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return found;
}
