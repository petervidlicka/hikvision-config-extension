/**
 * Local network scanner for Hikvision devices.
 *
 * Extensions can't read the machine's own IP (chrome.system.network is
 * Chrome Apps only), so we probe likely /24 subnets in order of preference.
 * Probes run through a small pool rather than all at once: firing hundreds
 * of connections together overflows Chrome's socket pool and the OS ARP
 * queue, and real devices then miss their timeout.
 *
 * Each address is tried on HTTP port 80 and on 8080, where devices moved off
 * the default port often are. Both ports share the one pool, and an address
 * with nothing on it can cost a timeout per port. So every subnet scanned
 * takes up to 11 rounds of PROBE_TIMEOUT_MS (about 13 s) instead of 6 (about
 * 7 s): the one where a device is found too, since it is scanned in full
 * before the scan stops, and that is usually the first. A scan that finds
 * nothing in any of the nine subnets takes up to about 2 min. On the
 * DS-7604NI's own LAN the subnet with it took 7.1 s on port 80 alone and
 * 7.8–13.4 s on both: most 8080 probes of empty addresses failed at once,
 * the system still remembering that the port-80 probe found nobody there.
 * Growing the pool to win the time back would bring back the overflow above;
 * the user can cancel at any time. The whole subnet is tried on one port
 * before the next, so two connections to one address normally don't wait on
 * the same ARP lookup (some systems hold only one packet per pending lookup
 * and drop the other, which then misses its timeout). On a busy subnet whose
 * hosts refuse port 80 at once, the second can still start before the first
 * has its answer.
 *
 * A device that asks for a Digest login like ISAPI does is a candidate; one
 * that also answers /SDK/activateStatus is a confirmed Hikvision (see
 * lib/device-probe.js). Candidates that don't confirm are still listed, as
 * possible devices: older firmware may not have that endpoint.
 *
 * Depends on lib/device-probe.js.
 */

import { asksForDigestLogin, checkActivation } from './device-probe.js';

/**
 * Subnets home and office routers hand out, tried after any known subnet:
 * the most common defaults, then those of popular routers (AVM Fritz!Box
 * 192.168.178, Asus 192.168.50, MikroTik 192.168.88, many ISP routers
 * 192.168.100), which are only reached when nothing was found earlier.
 */
export const COMMON_SUBNETS = Object.freeze([
  '192.168.0', '192.168.1', '192.168.2', '10.0.0', '10.0.1',
  '192.168.178', '192.168.50', '192.168.88', '192.168.100',
]);

/** HTTP ports a device is looked for on, in order of preference: the default, then the usual alternative. */
export const PROBE_PORTS = Object.freeze([80, 8080]);

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
 * How far a scan has got.
 * @typedef {object} ScanProgress
 * @property {string} subnet - the subnet being scanned, e.g. "192.168.0"
 * @property {number} probed - probes done in this subnet
 * @property {number} total - probes this subnet takes: 254 addresses × ports
 */

/**
 * What the progress bar and the line above it show while a scan runs.
 * @param {ScanProgress} progress
 * @param {number} foundCount - addresses found so far
 * @returns {{percent: number, text: string}}
 * @example
 * describeScanProgress({ subnet: '192.168.0', probed: 127, total: 508 }, 1)
 * // → {percent: 25, text: 'Scanning 192.168.0.x… found 1 device'}
 */
export function describeScanProgress({ subnet, probed, total }, foundCount) {
  return {
    percent: total > 0 ? (probed / total) * 100 : 0,
    text: `Scanning ${subnet}.x…` + (foundCount ? ` found ${foundCount} device${foundCount > 1 ? 's' : ''}` : ''),
  };
}

/**
 * Scan subnets one at a time and stop after the first subnet that contains a
 * device — the remaining subnets are only guesses, so scanning them would
 * just make the user wait. Each address is listed once: when it answers on
 * more than one port, on the one that confirmed it is a Hikvision, else on
 * the first of `ports`.
 *
 * @param {object} options
 * @param {readonly string[]} options.subnets - prefixes from candidateSubnets()
 * @param {readonly number[]} [options.ports] - HTTP ports to try each address on
 * @param {AbortSignal} [options.signal] - cancels the scan
 * @param {number} [options.probeTimeoutMs] - how long to wait for each request
 * @param {(device: FoundDevice) => void} [options.onFound] - called when an address is first
 *   found, and again for the same `ip` when a better answer from it replaces the one passed
 *   before (it confirmed on another port), so a list shown as devices are found stays right.
 *   Count addresses by `ip`, not calls.
 * @param {(progress: ScanProgress) => void} [options.onProgress] - called after each probe
 * @returns {Promise<FoundDevice[]>} in address order, the best answer from each address
 */
export async function scanForHikvision({
  subnets, ports = PROBE_PORTS, signal, onFound, onProgress, probeTimeoutMs = PROBE_TIMEOUT_MS,
}) {
  /** The best answer from each address. @type {Map<string, FoundDevice>} */
  const found = new Map();
  /** @param {FoundDevice} device */
  const record = (device) => {
    const known = found.get(device.ip);
    if (known && !preferred(device, known, ports)) return;
    found.set(device.ip, device);
    onFound?.(device);
  };

  for (const subnet of subnets) {
    const queue = subnetProbes(subnet, ports);
    const total = queue.length;
    let probed = 0;
    const worker = async () => {
      while (queue.length > 0 && !signal?.aborted) {
        const { ip, port } = /** @type {{ip: string, port: number}} */ (queue.shift());
        const device = await probeHikvision(ip, port, { signal, timeoutMs: probeTimeoutMs });
        if (device && !signal?.aborted) record(device);
        probed++;
        onProgress?.({ subnet, probed, total });
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

    if (signal?.aborted || found.size > 0) break;
  }

  return [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

/**
 * Every address of a /24 subnet on every port, one port after the other.
 * @param {string} subnet - e.g. "192.168.0"
 * @param {readonly number[]} ports
 * @returns {{ip: string, port: number}[]}
 */
function subnetProbes(subnet, ports) {
  return ports.flatMap(port => Array.from({ length: 254 }, (_, i) => ({ ip: `${subnet}.${i + 1}`, port })));
}

/**
 * Whether a device's answer on one port beats its answer on another: a
 * confirmed Hikvision first, then the port earlier in the list.
 * @param {FoundDevice} candidate
 * @param {FoundDevice} current
 * @param {readonly number[]} ports
 * @returns {boolean}
 */
function preferred(candidate, current, ports) {
  if (candidate.confirmed !== current.confirmed) return candidate.confirmed;
  return ports.indexOf(candidate.port) < ports.indexOf(current.port);
}
