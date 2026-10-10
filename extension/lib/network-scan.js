/**
 * Local network scanner for Hikvision devices.
 *
 * Extensions can't read the machine's own IP (chrome.system.network is
 * Chrome Apps only), so we probe likely /24 subnets in order of preference.
 * Probes run through a small pool rather than all at once: firing hundreds
 * of connections together overflows Chrome's socket pool and the OS ARP
 * queue, and real devices then miss their timeout.
 */

/** Subnets most home/office routers hand out, tried after any known subnet. */
export const COMMON_SUBNETS = ['192.168.0', '192.168.1', '192.168.2', '10.0.0', '10.0.1'];

export const PROBE_CONCURRENCY = 48;
export const PROBE_TIMEOUT_MS = 1200;

/**
 * Probe one address. Hikvision ISAPI answers unauthenticated requests with
 * 401 and a Digest challenge; anything else isn't a candidate.
 */
export async function probeHikvision(ip, signal, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortProbe = () => controller.abort();
  signal?.addEventListener('abort', abortProbe);
  try {
    const resp = await fetch(`http://${ip}/ISAPI/System/deviceInfo`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    const wwwAuth = resp.headers.get('www-authenticate') || '';
    return resp.status === 401 && /digest/i.test(wwwAuth);
  } catch {
    return false; // refused, unreachable, or timed out
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortProbe);
  }
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
    .filter(Boolean);
  return [...new Set([...known, ...COMMON_SUBNETS])];
}

/**
 * Scan subnets one at a time and stop after the first subnet that contains a
 * device — the remaining subnets are only guesses, so scanning them would
 * just make the user wait.
 *
 * @param {object} options
 * @param {string[]} options.subnets - prefixes from candidateSubnets()
 * @param {AbortSignal} [options.signal] - cancels the scan
 * @param {number} [options.probeTimeoutMs] - how long to wait for each address
 * @param {(ip: string) => void} [options.onFound]
 * @param {(progress: {subnet: string, probed: number}) => void} [options.onProgress]
 *   `probed` counts addresses checked in the current subnet (out of 254).
 * @returns {Promise<{ip: string, port: number}[]>}
 */
export async function scanForHikvision({ subnets, signal, onFound, onProgress, probeTimeoutMs = PROBE_TIMEOUT_MS }) {
  const found = [];

  for (const subnet of subnets) {
    let probed = 0;
    const queue = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
    const worker = async () => {
      while (queue.length > 0 && !signal?.aborted) {
        const ip = queue.shift();
        if (await probeHikvision(ip, signal, probeTimeoutMs)) {
          found.push({ ip, port: 80 });
          onFound?.(ip);
        }
        probed++;
        onProgress?.({ subnet, probed });
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

    if (signal?.aborted || found.length > 0) break;
  }

  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return found;
}
