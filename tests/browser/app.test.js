/**
 * End-to-end: the real config page (app.html + src/main.js) against a mock
 * NVR. Steps share one page, so they run in order.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import appHtml from '../../extension/app.html?raw';
import '../../extension/app.css';
import { AuthError } from '../../extension/lib/digest-auth.js';
import { Isapi } from '../../extension/lib/isapi.js';
import { NVR_HOST, STATUS, createChromeStub, createMockNvr } from '../support/mock-nvr.js';
import { fixtures } from './fixtures.js';

let device, chromeStub, state, dom;
const $ = (id) => document.getElementById(id);
const toast = () => $('toast').textContent;

/**
 * Make the page hidden or visible, as switching to another tab and back does.
 * @param {'hidden'|'visible'} visibility
 */
function setPageVisibility(visibility) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** The fps the status bar shows, or null. */
const readoutFps = () => {
  const match = $('statusRight').textContent.match(/· ([\d.]+) fps/);
  return match ? Number(match[1]) : null;
};

/**
 * The DS-7604NI's channel 1 motion document with other regions stored.
 * @param {number[][][]} regions - each region's corners as [x, y] in device units
 */
function motionDocWith(regions) {
  const coordinates = (corners) => '<RegionCoordinatesList>' + corners.map(([x, y]) =>
    `<RegionCoordinates><positionX>${x}</positionX><positionY>${y}</positionY></RegionCoordinates>`).join('') +
    '</RegionCoordinatesList>';
  return fixtures.motionDetectionNvr.replace(/<RegionList>[\s\S]*<\/RegionList>/, '<RegionList>' +
    regions.map((corners, i) => `<Region><id>${i + 1}</id>${coordinates(corners)}</Region>`).join('') + '</RegionList>');
}

/**
 * Keep the device from answering a request until the returned function is called.
 * @param {string} key - "METHOD /path"
 * @returns {() => void} lets it (and any later one) through
 */
function holdRequest(key) {
  let release = () => {};
  device.holds[key] = new Promise(resolve => { release = resolve; });
  return () => {
    delete device.holds[key];
    release();
  };
}

/** Click a channel in the list. @param {number} index - 0 for channel 1 */
function pickChannel(index) {
  document.querySelectorAll('.channel-item')[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * Reload the active tool with its answer held, switch to another channel and
 * wait until that channel's own settings are shown, then let the held answer
 * through and give the page time to take it in: the previous channel's load
 * finishes last.
 * @param {string} held - the request the reload waits for, "METHOD /path"
 * @param {string} loadButton - id of the tool's "Load from Device" button
 * @param {number} index - the channel to switch to, 0 for channel 1
 * @param {() => void} shown - throws until the new channel's settings are shown
 */
async function switchWhileLoading(held, loadButton, index, shown) {
  const release = holdRequest(held);
  try {
    $(loadButton).click();
    pickChannel(index);
    await vi.waitFor(shown);
  } finally {
    release();
  }
  await new Promise(r => setTimeout(r, 200));
}

/** Click "Load from Device" in Motion and wait until the panel can be used again. */
async function reloadMotion() {
  $('toast').textContent = '';
  $('loadMotionBtn').click();
  await vi.waitFor(() => {
    expect(toast()).toBe('Motion detection config loaded');
    expect($('saveMotionBtn').disabled).toBe(false);
  });
}

/**
 * Dispatch canvas mouse events at a fraction of the canvas size. Events land
 * on whole pixels, so each point is rounded to one inside the canvas, which
 * may start part-way through a pixel.
 */
function canvasPointer() {
  const canvas = $('drawCanvas');
  const pixel = (start, size, fraction) =>
    Math.min(Math.max(Math.round(start + fraction * size), Math.ceil(start)), Math.floor(start + size) - 1);
  const at = (fx, fy) => {
    const r = canvas.getBoundingClientRect();
    return { clientX: pixel(r.left, r.width, fx), clientY: pixel(r.top, r.height, fy), bubbles: true, button: 0 };
  };
  const click = (fx, fy) => {
    canvas.dispatchEvent(new MouseEvent('mousedown', at(fx, fy)));
    canvas.dispatchEvent(new MouseEvent('mouseup', at(fx, fy)));
  };
  const dblclick = (fx, fy) => {
    click(fx, fy);
    click(fx, fy);
    canvas.dispatchEvent(new MouseEvent('dblclick', at(fx, fy)));
  };
  const drag = (fx1, fy1, fx2, fy2) => {
    canvas.dispatchEvent(new MouseEvent('mousedown', at(fx1, fy1)));
    canvas.dispatchEvent(new MouseEvent('mousemove', at(fx2, fy2)));
    canvas.dispatchEvent(new MouseEvent('mouseup', at(fx2, fy2)));
  };
  return { click, dblclick, drag };
}

beforeAll(async () => {
  const page = new DOMParser().parseFromString(appHtml, 'text/html');
  page.querySelectorAll('script').forEach(s => s.remove());
  document.body.innerHTML = page.body.innerHTML;

  chromeStub = createChromeStub();
  vi.stubGlobal('chrome', chromeStub.chrome);
  device = createMockNvr({ snapshotDelayMs: 1200, realFetch: fetch.bind(window) });
  vi.stubGlobal('fetch', device.fetch);

  await import('../../extension/src/main.js');
  ({ state, dom } = await import('../../extension/src/state.js'));
});

describe('config page', () => {
  it('says which address didn’t answer when nothing is there', async () => {
    $('manualEntryBtn').click();
    $('hostInput').value = NVR_HOST;
    $('passInput').value = 'test-pass';
    device.unreachable = true;
    try {
      $('connectBtn').click();
      await vi.waitFor(() => expect(toast()).toBe(`Connection failed: No response from ${NVR_HOST}:80 — check the IP address and port`));
      expect(state.connected).toBe(false);
    } finally {
      device.unreachable = false;
    }
    await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));
  });

  it('connects and lists channels as text, marking disconnected cameras', async () => {
    $('manualEntryBtn').click();
    $('hostInput').value = NVR_HOST;
    $('passInput').value = 'test-pass';
    device.offlineChannels = ['4'];
    $('connectBtn').click();
    await vi.waitFor(() => expect(state.channels).toHaveLength(4));
    device.offlineChannels = [];

    expect($('deviceInfo').textContent).toBe('Mock NVR • FW V4.0');
    const names = [...document.querySelectorAll('.channel-item span')].map(s => s.textContent);
    expect(names).toEqual(['Front & Gate', '<img src=x onerror=alert(1)>', 'Garage', 'Slide']);
    expect(document.querySelector('.channel-item img')).toBeNull();
    const offline = [...document.querySelectorAll('.channel-item.offline')];
    expect(offline.map(el => [el.querySelector('.ch-num')?.textContent, el.getAttribute('title')])).toEqual([['4', 'Offline']]);
    expect(chromeStub.store.session.password).toBe('test-pass');
    expect(chromeStub.store.local.password).toBeUndefined();
  });

  it('streams SD frames as blobs without overlapping requests', async () => {
    await vi.waitFor(() => expect(dom.videoFeed.src).toMatch(/^blob:/), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 2500));
    expect(device.maxInFlightSnapshots).toBe(1);
    expect(device.requests.filter(r => r.endsWith('/picture'))).toContain('GET /ISAPI/Streaming/channels/102/picture');
    expect($('statusRight').textContent).toMatch(/^Channel 1 · SD · \d+\.\d fps$/);
  });

  it('shows the NVR’s squeezed 704×576 still at its camera’s 16:9, with the drawing canvas on it', async () => {
    // Each camera's main stream size, from the stream list read once at Connect
    expect(device.requests.filter(r => r === 'GET /ISAPI/Streaming/channels')).toHaveLength(1);
    expect(state.channels.map(ch => ch.mainStreamSize)).toEqual(Array(4).fill({ width: 2688, height: 1520 }));
    await vi.waitFor(() => expect(dom.videoFeed.classList.contains('stream-aspect')).toBe(true));
    expect([dom.videoFeed.naturalWidth, dom.videoFeed.naturalHeight]).toEqual([704, 576]);
    const img = dom.videoFeed.getBoundingClientRect();
    expect(img.width / img.height).toBeCloseTo(2688 / 1520, 1);
    // The canvas covers the picture as shown, with that size as its pixels, so what the tools
    // draw isn't stretched with the picture (round corner handles stay round)
    const canvas = dom.canvas.getBoundingClientRect();
    for (const side of ['left', 'top', 'width', 'height']) expect(canvas[side]).toBeCloseTo(img[side], 0);
    expect([dom.canvas.width, dom.canvas.height]).toEqual([dom.videoFeed.clientWidth, dom.videoFeed.clientHeight]);
    expect(dom.canvas.width).toBeGreaterThan(704);
    expect((dom.canvas.width / dom.canvas.height) / (canvas.width / canvas.height)).toBeCloseTo(1, 2);
  });

  it('shows an NVR’s cached still once per change and reads its real rate, without slowing a camera down', async () => {
    const picture = 'GET /ISAPI/Streaming/channels/102/picture';
    let shown = 0;
    const observer = new MutationObserver(records => { shown += records.length; });
    observer.observe(dom.videoFeed, { attributeFilter: ['src'] });
    /** Requests and pictures shown over `ms`, after letting a restarted feed settle for `settleMs`. */
    const watch = async (settleMs, ms) => {
      $('streamBtnSd').click(); // restarts the feed
      await new Promise(r => setTimeout(r, settleMs));
      const since = device.requests.length;
      shown = 0;
      await new Promise(r => setTimeout(r, ms));
      return { asked: device.requests.slice(since).filter(r => r === picture).length, shown };
    };
    device.snapshotDelayMs = 190; // like the DS-7604NI
    try {
      // A camera: a new picture for every request, every 200 ms, all shown
      const camera = await watch(400, 2000);
      expect(camera.asked).toBeGreaterThanOrEqual(8);
      expect(camera.shown).toBeGreaterThanOrEqual(camera.asked - 1);
      expect(readoutFps()).toBeGreaterThan(3.5);

      // The DS-7604NI: the same still for a second. Each one is shown once,
      // though asked for several times (how many fewer than polling every
      // 200 ms is in tests/node/snapshots.test.js, on exact timing)
      device.snapshotRefreshMs = 1000;
      const nvr = await watch(1500, 3000);
      expect(nvr.shown).toBeGreaterThanOrEqual(2);
      expect(nvr.shown).toBeLessThanOrEqual(4);
      expect(nvr.asked).toBeGreaterThan(nvr.shown);
      expect(nvr.asked).toBeLessThanOrEqual(3000 / 200);
      expect(readoutFps()).toBeGreaterThan(0.6);
      expect(readoutFps()).toBeLessThan(1.5);
      expect(device.maxInFlightSnapshots).toBe(1);
    } finally {
      observer.disconnect();
      device.snapshotRefreshMs = 0;
      device.snapshotDelayMs = 1200;
    }
  }, 15_000);

  it('switches the single view to the HD stream, a full-size still from the NVR, and remembers it', async () => {
    const since = device.urls.length;
    $('streamBtnHd').click();
    expect(chromeStub.store.local.streamType).toBe('main');
    // The NVR's plain HD still is the same 704×576 as SD, so it is asked for the main stream's size.
    // The frame's size is known once it decodes, its layout (aspect, canvas) once its onload has run:
    // until then the SD frame's stretch stays.
    await vi.waitFor(() => expect([dom.videoFeed.naturalWidth, dom.videoFeed.classList.contains('stream-aspect')]).toEqual([1920, false]), { timeout: 5000 });
    expect(device.urls.slice(since).filter(u => u.includes('/picture')).slice(0, 2)).toEqual([
      'GET /ISAPI/Streaming/channels/101/picture',
      'GET /ISAPI/Streaming/channels/101/picture?videoResolutionWidth=2688&videoResolutionHeight=1520',
    ]);
    expect($('statusRight').textContent).toMatch(/^Channel 1 · HD/);
    // A 1920×1088 still has the camera's aspect already; the canvas takes the size it is shown at
    expect([dom.canvas.width, dom.canvas.height]).toEqual([dom.videoFeed.clientWidth, dom.videoFeed.clientHeight]);
    expect(dom.canvas.width).toBeLessThan(1920);
    // The SD frame in flight was cancelled, not left running next to the HD one
    expect(device.maxInFlightSnapshots).toBe(1);
  });

  it('says "No signal" over the stale frame when the camera stops answering, asks less often, and recovers', async () => {
    const snapshot = 'GET /ISAPI/Streaming/channels/101/picture';
    const since = device.requests.length;
    const asked = () => device.requests.slice(since).filter(r => r === snapshot).length;
    device.failures[snapshot] = { httpStatus: 503, ...STATUS.serviceUnavailable };
    try {
      await vi.waitFor(() => expect(dom.canvasContainer.classList.contains('no-signal')).toBe(true), { timeout: 5000 });
      expect($('feedOverlay').checkVisibility()).toBe(true);
      expect($('feedOverlay').textContent).toBe('No signal');
      expect(dom.videoFeed.src).toMatch(/^blob:/); // the last frame stays on screen, dimmed
      expect($('statusText').textContent).toMatch(/^Failed to get video feed: The device is busy or the camera isn’t available/);
      // Two failed requests half a second apart, not one every 200 ms
      expect(asked()).toBe(2);
    } finally {
      delete device.failures[snapshot];
    }
    // The next retry, a second later, gets a frame (and the one after it may be on its way)
    await vi.waitFor(() => expect(dom.canvasContainer.classList.contains('no-signal')).toBe(false), { timeout: 5000 });
    expect($('feedOverlay').checkVisibility()).toBe(false);
    expect(asked()).toBeLessThanOrEqual(4);
    expect($('statusText').textContent).toBe('Live view');
  });

  it('shows a camera the NVR lists offline as "No signal" in the grid at once, asking it only now and then', async () => {
    // Channel 4 was listed offline at Connect; its snapshots now answer 503 too
    expect(state.channels[3].online).toBe(false);
    device.offlineChannels = ['4'];
    const since = device.requests.length;
    try {
      $('gridViewTab').click();
      const cell = document.querySelectorAll('.grid-cell')[3];
      expect(cell.classList.contains('no-signal')).toBe(true);
      expect(cell.querySelector('.grid-no-feed').textContent).toBe('No signal');
      expect(cell.querySelector('.grid-no-feed').checkVisibility()).toBe(true);
      await new Promise(r => setTimeout(r, 1000));
      expect(device.requests.slice(since).filter(r => r.includes('/channels/402/'))).toEqual(['GET /ISAPI/Streaming/channels/402/picture']);
      expect(cell.querySelector('.grid-no-feed').getAttribute('title')).toMatch(/camera isn’t available/);
      // The other cells are still loading or showing frames
      expect(document.querySelectorAll('.grid-cell.no-signal')).toHaveLength(1);
    } finally {
      device.offlineChannels = [];
      $('singleViewTab').click();
    }
  });

  it('shows grid cells at their cameras’ 16:9, and never asks the grid for full-size stills', async () => {
    const since = device.urls.length;
    $('gridViewTab').click();
    try {
      await vi.waitFor(() => expect(document.querySelectorAll('.grid-feed.loaded')).toHaveLength(4), { timeout: 3000 });
      for (const img of document.querySelectorAll('.grid-feed')) {
        expect([img.naturalWidth, img.classList.contains('stream-aspect')]).toEqual([704, true]);
        const r = img.getBoundingClientRect();
        expect(r.width / r.height).toBeCloseTo(2688 / 1520, 1);
        // Centred in its cell
        const cell = img.parentElement.getBoundingClientRect();
        expect(r.left - cell.left).toBeCloseTo(cell.right - r.right, 0);
        expect(r.top - cell.top).toBeCloseTo(cell.bottom - r.bottom, 0);
      }
      const asked = device.urls.slice(since).filter(u => u.includes('/picture'));
      expect(new Set(asked)).toEqual(new Set([1, 2, 3, 4].map(ch => `GET /ISAPI/Streaming/channels/${ch}02/picture`)));
    } finally {
      $('singleViewTab').click();
    }
  });

  it('asks for no frames while the tab is hidden, and picks up the views on screen when it’s back', async () => {
    const pictures = (since) => device.requests.slice(since).filter(r => r.endsWith('/picture'));
    $('gridViewTab').click();
    try {
      await vi.waitFor(() => expect(document.querySelectorAll('.grid-feed.loaded')).toHaveLength(4), { timeout: 3000 });
      // Each camera's rate (a picture every 1.2 s here), not the sum of four
      await vi.waitFor(() => expect($('statusRight').textContent).toMatch(/^Grid · SD · [\d.]+ fps per camera$/), { timeout: 3000 });
      expect(readoutFps()).toBeLessThan(1.5);
      setPageVisibility('hidden');
      let since = device.requests.length;
      await new Promise(r => setTimeout(r, 1500));
      expect(pictures(since)).toEqual([]);
      // Each grid cell asks again at once
      setPageVisibility('visible');
      await vi.waitFor(() => expect(new Set(pictures(since))).toEqual(new Set([1, 2, 3, 4].map(ch => `GET /ISAPI/Streaming/channels/${ch}02/picture`))));
      expect(document.querySelectorAll('.grid-cell.no-signal')).toHaveLength(0);

      // A view that starts while the page is hidden (a Connect finishing in another tab) waits too
      setPageVisibility('hidden');
      $('singleViewTab').click();
      since = device.requests.length;
      await new Promise(r => setTimeout(r, 500));
      expect(pictures(since)).toEqual([]);
      setPageVisibility('visible');
      await vi.waitFor(() => expect(pictures(since)).toEqual(['GET /ISAPI/Streaming/channels/101/picture'])); // HD, chosen above
      // Straight for the full-size still, found earlier
      expect(device.urls.at(-1)).toBe('GET /ISAPI/Streaming/channels/101/picture?videoResolutionWidth=2688&videoResolutionHeight=1520');
    } finally {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      $('singleViewTab').click();
    }
  });

  it('doesn’t pass off the previous channel’s frame as an offline camera’s last one', async () => {
    const channelItems = () => document.querySelectorAll('.channel-item');
    device.offlineChannels = ['4'];
    try {
      await vi.waitFor(() => expect(dom.videoFeed.src).toMatch(/^blob:/), { timeout: 3000 });
      channelItems()[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dom.canvasContainer.classList.contains('no-signal')).toBe(true);
      expect(dom.videoFeed.hasAttribute('src')).toBe(false);
    } finally {
      device.offlineChannels = [];
      channelItems()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(dom.canvasContainer.classList.contains('no-signal')).toBe(false);
    // The drawing steps below need channel 1's frame on screen
    await vi.waitFor(() => expect(dom.videoFeed.naturalWidth).toBeGreaterThan(0), { timeout: 3000 });
  });

  it('loads motion detection with the device limits', async () => {
    $('configSectionTab').click();
    await vi.waitFor(() => expect(state.motionDoc).not.toBeNull());
    expect($('sensitivitySlider').step).toBe('20');
    expect($('motionMaxRegions').textContent).toBe('4');
    expect($('motionPointRange').textContent).toBe('4–10');
    expect($('detectHuman').checked).toBe(true);
    // Dynamic Analysis is the NVR's <enableHighlight>true</enableHighlight>
    expect($('dynamicAnalysisRow').style.display).toBe('');
    expect($('dynamicAnalysisToggle').classList.contains('on')).toBe(true);
  });

  it('enforces corner and region limits while drawing', () => {
    const { click, dblclick } = canvasPointer();
    $('clearMotionRegionsBtn').click();

    click(0.05, 0.05); click(0.30, 0.05); dblclick(0.30, 0.35);
    expect(state.motionRegions).toHaveLength(0);
    expect(state.drawingPoints).toHaveLength(3);
    expect(toast()).toMatch(/at least 4 corners/);

    dblclick(0.05, 0.35);
    expect(state.motionRegions.map(r => r.points.length)).toEqual([4]);

    for (const [x, y] of [[0.55, 0.05], [0.05, 0.55], [0.55, 0.55]]) {
      click(x, y); click(x + 0.3, y); click(x + 0.3, y + 0.3); dblclick(x, y + 0.3);
    }
    click(0.45, 0.45);
    expect(state.motionRegions).toHaveLength(4);
    expect(state.drawingPoints).toHaveLength(0);
    expect(toast()).toMatch(/at most 4 detection regions/);
  });

  it('saves motion detection to the InputProxy URL in device units', async () => {
    const slider = $('sensitivitySlider');
    slider.value = 50;
    slider.dispatchEvent(new Event('input'));
    $('detectVehicle').click();
    $('dynamicAnalysisToggle').click();
    $('saveMotionBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(1));

    const { path, body } = device.puts[0];
    expect(path).toBe('/ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection');
    expect(body).toMatch(/<sensitivityLevel>60<\/sensitivityLevel>/);
    expect(body).toMatch(/<targetType[^>]*>human,vehicle<\/targetType>/);
    expect(body).toContain('<enableHighlight>false</enableHighlight>');
    expect(body).not.toContain('enableDynamicAnalysis');
    expect(body.match(/<Region xmlns="">/g)).toHaveLength(4);
    const coords = [...body.matchAll(/<position[XY]>(\d+)</g)].map(m => +m[1]);
    expect(Math.min(...coords)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...coords)).toBeLessThanOrEqual(1000);
    // Top-left corner of the first region: Y counts from the bottom
    expect(body).toMatch(/<Region xmlns=""><id>1<\/id><RegionCoordinatesList><RegionCoordinates><positionX>(4\d|5\d)<\/positionX><positionY>9[45]\d<\/positionY>/);
  });

  it('keeps unmanaged event actions when saving', async () => {
    $('configTabs').querySelector('[data-tool="events"]').click();
    await vi.waitFor(() => expect(state.eventTriggerDoc).not.toBeNull());
    $('eventToggle_center').click();
    $('eventToggle_record').click();
    $('saveEventsBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(2));

    const { path, body } = device.puts[1];
    expect(path).toBe('/ISAPI/Event/triggers/VMD-1');
    expect([...body.matchAll(/<notificationMethod>(\w+)/g)].map(m => m[1])).toEqual(['IO', 'FTP', 'center']);
    expect(body).toContain('<outputIOPortID>2</outputIOPortID>');
  });

  it('explains a refused save with the device’s reason', async () => {
    const key = 'PUT /ISAPI/Event/triggers/VMD-1';
    device.failures[key] = { httpStatus: 403, statusCode: 4, statusString: 'Invalid Operation', subStatusCode: 'lowPrivilege' };
    try {
      $('saveEventsBtn').click();
      await vi.waitFor(() => expect(toast()).toMatch(/^Failed to save event actions: This user account doesn’t have permission/));
      expect($('statusText').textContent).toBe('Save failed');
    } finally {
      delete device.failures[key];
    }
  });

  it('tells the user when a save needs a reboot to take effect', async () => {
    device.writeStatus = { statusCode: 7, statusString: 'Reboot Required', subStatusCode: 'rebootRequired' };
    try {
      $('saveEventsBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('Event actions saved — reboot the device for this to take effect'));
      expect($('statusText').textContent).toBe('Config saved — reboot required');
    } finally {
      device.writeStatus = STATUS.ok;
    }
  });

  it('disables the actions channel 1’s camera can’t do, saying why', () => {
    const hints = [
      ['IO', 'This camera has no alarm output'],
      ['whiteLight', 'This camera has no white light'],
      ['audio', 'This camera has no speaker'],
    ];
    for (const [key, hint] of hints) {
      expect($(`eventRow_${key}`).classList.contains('unavailable')).toBe(true);
      expect($(`eventRow_${key}`).title).toBe(hint);
      // Hovering the label says why too, not what the action would do
      expect($(`eventRow_${key}`).querySelector('span').title).toBe(hint);
    }
    expect($('eventRow_center').classList.contains('unavailable')).toBe(false);
    expect($('eventRow_center').querySelector('span').title).toBe('Send alert to Hik-Connect mobile app');
    $('eventToggle_whiteLight').click();
    expect($('eventToggle_whiteLight').classList.contains('on')).toBe(false);
  });

  it('links channel 3 to its own camera’s relay, light and speaker', async () => {
    document.querySelectorAll('.channel-item')[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(state.eventActionTargets).not.toBeNull());
    expect(document.querySelectorAll('#configPanels .toggle-row.unavailable')).toHaveLength(0);
    expect($('eventToggle_record').classList.contains('on')).toBe(true);

    for (const key of ['IO', 'whiteLight', 'audio']) $(`eventToggle_${key}`).click();
    const puts = device.puts.length;
    $('saveEventsBtn').click();
    await vi.waitFor(() => expect(toast()).toBe('Event actions saved successfully!'));
    expect(device.puts).toHaveLength(puts + 1);

    // The entries the NVR's own web UI writes, which the bare whiteLight/audio methods were not
    const { path, body } = device.puts.at(-1);
    expect(path).toBe('/ISAPI/Event/triggers/VMD-3');
    expect(body).toContain('<EventTriggerNotification><id>IO-301</id><notificationMethod>IO</notificationMethod>' +
      '<dynOutputIOPortID>301</dynOutputIOPortID></EventTriggerNotification>');
    expect(body).toContain('<id>whiteLightOut-3</id><notificationMethod>whiteLightOut</notificationMethod><lightAudioOutID>3</lightAudioOutID>');
    expect(body).toContain('<id>audioOut-3</id><notificationMethod>audioOut</notificationMethod><lightAudioOutID>3</lightAudioOutID>');
    expect(body).not.toContain('notificationRecurrence');

    // What the device offers was read once, not per channel
    expect(device.requests.filter(r => r === 'GET /ISAPI/Event/triggersCap')).toHaveLength(1);
  });

  it('keeps the channel moved on to when an earlier channel’s save finishes late', async () => {
    const key = 'PUT /ISAPI/Event/triggers/VMD-3';
    const sent = () => device.requests.filter(r => r === key).length;
    const triggerId = () => state.eventTriggerDoc?.getElementsByTagName('id')[0]?.textContent;
    let release = () => {};
    device.holds[key] = new Promise(resolve => { release = resolve; });
    try {
      // Save channel 3, and switch to channel 1 while the device is still answering
      $('eventToggle_beep').click();
      const before = sent();
      $('saveEventsBtn').click();
      await vi.waitFor(() => expect(sent()).toBe(before + 1));
      document.querySelectorAll('.channel-item')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => expect(state.eventActionTargets).not.toBeNull());
      expect(triggerId()).toBe('VMD-1');

      release();
      await vi.waitFor(() => expect(toast()).toBe('Event actions for channel 3 saved successfully!'));
      expect(device.triggers.read('3')).toContain('<notificationMethod>beep</notificationMethod>');
      // The panel still holds channel 1's trigger, so its next save goes there
      expect(triggerId()).toBe('VMD-1');
      $('saveEventsBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('Event actions saved successfully!'));
      const { path, body } = device.puts.at(-1);
      expect(path).toBe('/ISAPI/Event/triggers/VMD-1');
      expect(body).not.toContain('VMD-3');
    } finally {
      release();
      delete device.holds[key];
    }
  });

  it('edits the cell grid on a grid-only camera', async () => {
    $('configTabs').querySelector('[data-tool="motion"]').click();
    document.querySelectorAll('.channel-item')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(state.motionMode).toBe('grid'));
    expect($('motionGridInstructions').style.display).toBe('');
    expect($('motionRegionInstructions').style.display).toBe('none');
    expect($('dynamicAnalysisRow').style.display).toBe(''); // the document has enableHighlight

    const { click } = canvasPointer();
    $('clearMotionRegionsBtn').click();
    click(0.01, 0.01); // top-left cell
    expect(state.motionGrid.cells[0][0]).toBe(true);

    const puts = device.puts.length;
    $('saveMotionBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
    const { path, body } = device.puts.at(-1);
    expect(path).toBe('/ISAPI/ContentMgmt/InputProxy/channels/2/video/motionDetection');
    expect(body).toContain('<regionType>grid</regionType>');
    expect(body).toContain('<gridMap>800000' + '0'.repeat(102) + '</gridMap>');
    expect(body).toContain('<enableHighlight>true</enableHighlight>');
  });

  it('shows stored privacy masks the right way up and saves exactly the drawn ones', async () => {
    $('configTabs').querySelector('[data-tool="privacy"]').click();
    await vi.waitFor(() => expect(state.privacyDoc).not.toBeNull());
    // The NVR stores a mask at the top left and one at the bottom right, both reading enabled=false
    expect(state.privacyRegions).toEqual([{ x: 0, y: 0, w: 0.25, h: 0.25 }, { x: 0.75, y: 0.75, w: 0.25, h: 0.25 }]);
    expect($('privacyToggle').classList.contains('on')).toBe(true);

    // Delete the bottom-right mask and draw one along the top right
    $('privacyRegionList').querySelector('[data-delete="1"]').click();
    canvasPointer().drag(0.5, 0.05, 0.9, 0.2);
    expect(state.privacyRegions).toHaveLength(2);

    const path = '/ISAPI/ContentMgmt/InputProxy/channels/2/video/privacyMask';
    const puts = device.puts.length;
    $('savePrivacyBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
    expect(device.deletes.at(-1)).toBe(`${path}/regions`);
    const { path: putPath, body } = device.puts.at(-1);
    expect(putPath).toBe(path);
    expect([...body.matchAll(/<id>(\d+)<\/id>/g)].map(m => m[1])).toEqual(['1', '2']);
    // Y counts from the bottom: the new mask spans 5–20 % below the top, positionY ≈ 547–461
    // (give or take a few units, since pointer events land on whole screen pixels)
    const ys = [...body.split('<id>2</id>')[1].matchAll(/<positionY>(\d+)</g)].map(m => +m[1]);
    expect(Math.max(...ys)).toBeCloseTo(547, -1);
    expect(Math.min(...ys)).toBeCloseTo(461, -1);
    await vi.waitFor(() => expect(toast()).toBe('Privacy mask saved successfully!'));

    // What the device now stores is exactly what was drawn
    $('loadPrivacyBtn').click();
    await vi.waitFor(() => expect(toast()).toBe('Privacy mask config loaded'));
    expect(state.privacyRegions).toHaveLength(2);
    expect(state.privacyRegions[1].y).toBeCloseTo(0.05, 2);
  });

  it('shows the day’s recordings and frames in Playback', async () => {
    $('playbackSectionTab').click();
    // The manual recording isn't an event, as in iVMS and the web UI
    await vi.waitFor(() => expect($('pbInfo').textContent).toMatch(/^3 recordings, 37 min, 1 triggered by events\./));
    expect(state.playback.recordings.map(r => r.kind)).toEqual(['continuous', 'manual', 'event']);
    expect($('pbDateLabel').textContent).toBe('Today');
    expect($('pbTimestamp').textContent).toBe('08:00:00');
    expect(device.requests).toContain('GET /ISAPI/ContentMgmt/StreamingProxy/channels/201/picture');
    await vi.waitFor(() => expect(dom.videoFeed.src).toMatch(/^blob:/));
    expect($('toolTabs').style.display).toBe('none');

    // Clicking the timeline moves the playhead
    const wrap = $('pbTimelineWrap').getBoundingClientRect();
    $('pbTimelineWrap').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: wrap.left + wrap.width * (14.1 / 24), clientY: wrap.top + 5 }));
    // Clicks land on whole pixels, a few minutes apart on a narrow timeline
    expect($('pbTimestamp').textContent).toMatch(/^14:0\d/);
  });

  it('detects a device that returns the live image whatever the time', async () => {
    device.recordedFrames = 'ignoresTime'; // what the DS-7604 does
    document.querySelectorAll('.channel-item')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect($('pbInfo').textContent).toContain('doesn’t provide still images'));
    expect(state.playback.framesSupported).toBe(false);
    expect($('pbPlayPauseBtn').disabled).toBe(true);
  });

  it('opens stored pictures from their timeline markers', async () => {
    expect($('pbInfo').textContent).toContain('1 stored picture');
    const wrap = $('pbTimelineWrap').getBoundingClientRect();
    const x = wrap.left + wrap.width * ((46 * 60 + 8) / 86400);
    $('pbTimelineWrap').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: wrap.top + 5 }));
    await vi.waitFor(() => expect($('statusText').textContent).toBe('Stored picture from 00:46:08'));
    expect(device.requests).toContain('GET /picture/Streaming/tracks/103/');
    expect($('pbTimestamp').textContent).toBe('00:46:08');
  });

  it('keeps privacy masks where the device has them when the picture under them changes size', async () => {
    // The 1280×720 stored picture was shown last; channel 1's live stills are 1920×1088 (HD, chosen above)
    expect(dom.videoFeed.naturalWidth).toBe(1280);
    const storedPicture = [dom.videoFeed.clientWidth, dom.videoFeed.clientHeight];
    expect([dom.canvas.width, dom.canvas.height]).toEqual(storedPicture);
    const path = '/ISAPI/ContentMgmt/InputProxy/channels/1/video/privacyMask';
    /** Each mask's corners in a document, as sorted "x,y" */
    const maskCorners = (xml) => xml.split(/<PrivacyMaskRegion[\s>]/).slice(1)
      .map(region => [...region.matchAll(/<positionX>(\d+)<\/positionX>\s*<positionY>(\d+)</g)].map(m => `${m[1]},${m[2]}`).sort());
    const stored = maskCorners(device.privacy.read(path));
    expect(stored).toHaveLength(2);

    const pictures = ['GET /ISAPI/Streaming/channels/101/picture', 'GET /ISAPI/Streaming/channels/102/picture'];
    let release = () => {};
    const firstFrame = new Promise(resolve => { release = resolve; });
    for (const key of pictures) device.holds[key] = firstFrame;
    try {
      // Configuration reads the masks before the first live frame is in
      $('configSectionTab').click();
      expect(dom.videoFeed.hasAttribute('src')).toBe(false); // the stored picture doesn't pass for live
      await vi.waitFor(() => expect(state.privacyDoc).not.toBeNull());
      expect([dom.canvas.width, dom.canvas.height]).toEqual(storedPicture);
      expect(state.privacyRegions).toEqual([{ x: 0, y: 0, w: 0.25, h: 0.25 }, { x: 0.75, y: 0.75, w: 0.25, h: 0.25 }]);
    } finally {
      release();
      for (const key of pictures) delete device.holds[key];
    }

    // The first frame gives the canvas other pixels; saving sends back the device's own coordinates
    await vi.waitFor(() => {
      expect(dom.videoFeed.naturalWidth).toBe(1920);
      expect([dom.canvas.width, dom.canvas.height]).toEqual([dom.videoFeed.clientWidth, dom.videoFeed.clientHeight]);
    }, { timeout: 5000 });
    expect([dom.canvas.width, dom.canvas.height]).not.toEqual(storedPicture);
    const puts = device.puts.length;
    $('savePrivacyBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
    expect(device.puts.at(-1).path).toBe(path);
    expect(maskCorners(device.puts.at(-1).body)).toEqual(stored);
  });

  it('saves motion regions in the same device units whatever size the canvas had when they were loaded or drawn', async () => {
    $('configTabs').querySelector('[data-tool="motion"]').click();
    await vi.waitFor(() => expect(state.motionDoc).not.toBeNull());
    /** Click Save; the corners of the regions sent, in order */
    const save = async () => {
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      return [...device.puts.at(-1).body.matchAll(/<positionX>(\d+)<\/positionX><positionY>(\d+)</g)].map(m => [+m[1], +m[2]]);
    };
    /** Give the canvas other pixels, as a frame of another size or a resized window does */
    const frameSize = (width, height) => Object.assign(dom.canvas, { width, height });

    // Loaded over one frame, saved over a smaller one
    frameSize(704, 576);
    expect(await save()).toEqual([[651, 684], [751, 701], [952, 544], [850, 147], [616, 486]]);

    // The same square drawn over frames of one size, then while the frame
    // changes size half-way through it and again before it's saved
    const { click, dblclick } = canvasPointer();
    /** @param {number[][]} sizes - the frame's size at the start, half-way, and when saving */
    const drawSquare = (sizes) => {
      $('clearMotionRegionsBtn').click();
      frameSize(...sizes[0]);
      click(0.1, 0.1); click(0.4, 0.1);
      frameSize(...sizes[1]);
      click(0.4, 0.4); dblclick(0.1, 0.4);
      expect(state.motionRegions.map(r => r.points.length)).toEqual([4]);
      frameSize(...sizes[2]);
      return save();
    };
    const steady = await drawSquare([[704, 576], [704, 576], [704, 576]]);
    expect(await drawSquare([[704, 576], [1920, 1088], [1280, 720]])).toEqual(steady);
    // 10–40 % across and down, Y from the bottom (give or take a screen pixel, since pointer
    // events land on whole ones)
    [[100, 900], [400, 900], [400, 600], [100, 600]].forEach(([x, y], i) => {
      expect(Math.abs(steady[i][0] - x)).toBeLessThanOrEqual(10);
      expect(Math.abs(steady[i][1] - y)).toBeLessThanOrEqual(10);
    });
  });

  it('keeps detection targets the panel has no checkbox for', async () => {
    // A camera with a target this panel doesn't show, on as well as the person
    device.motionDocs['1'] = fixtures.motionDetectionNvr.replace('<targetType>human</targetType>', '<targetType>nonMotorVehicle,human</targetType>');
    try {
      await reloadMotion();
      expect([$('detectHuman').checked, $('detectVehicle').checked]).toEqual([true, false]);
      $('detectVehicle').click();
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      expect(device.puts.at(-1).body).toContain('<targetType>human,vehicle,nonMotorVehicle</targetType>');
    } finally {
      delete device.motionDocs['1'];
    }
  });

  it('keeps a region whose edges cross open, and won’t save one the camera stores', async () => {
    const { click, dblclick } = canvasPointer();
    $('clearMotionRegionsBtn').click();
    // A bow-tie: its second and fourth edges cross, closed by a double-click or at the first corner
    click(0.1, 0.1); click(0.4, 0.4); click(0.4, 0.1); dblclick(0.1, 0.4);
    expect(toast()).toBe('Edges of a region must not cross');
    expect(state.motionRegions).toHaveLength(0);
    expect(state.drawingPoints).toHaveLength(4);
    click(0.1, 0.1);
    expect(state.drawingPoints).toHaveLength(4);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(state.drawingPoints).toHaveLength(0);

    // The tenth corner closes a region by itself; one that would cross is taken back
    for (const [x, y] of [[0.1, 0.1], [0.2, 0.1], [0.3, 0.1], [0.4, 0.1], [0.4, 0.2], [0.4, 0.3], [0.4, 0.4], [0.3, 0.4], [0.2, 0.4]]) {
      click(x, y);
    }
    $('toast').textContent = '';
    click(0.3, 0.05);
    expect(toast()).toBe('Edges of a region must not cross');
    expect(state.drawingPoints).toHaveLength(9);
    // …also when double-clicked: the region stays open rather than closing without it
    $('toast').textContent = '';
    dblclick(0.3, 0.05);
    expect(toast()).toBe('Edges of a region must not cross');
    expect([state.drawingPoints.length, state.motionRegions.length]).toEqual([9, 0]);
    click(0.1, 0.4);
    expect(state.drawingPoints).toHaveLength(0);
    expect(state.motionRegions.map(r => r.points.length)).toEqual([10]);

    // A crossing region loaded from the camera isn't sent back as it is
    device.motionDocs['1'] = motionDocWith([[[100, 900], [400, 600], [400, 900], [100, 600]]]);
    try {
      await reloadMotion();
      expect(state.motionRegions.map(r => r.points.length)).toEqual([4]);
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      expect(toast()).toBe('Edges of a region must not cross: redraw region 1 before saving');
      expect(device.puts).toHaveLength(puts);
    } finally {
      delete device.motionDocs['1'];
    }
  });

  it('says a region with no area has none, when closing one and before saving a stored one', async () => {
    const { click, dblclick } = canvasPointer();
    $('clearMotionRegionsBtn').click();
    click(0.1, 0.6); click(0.2, 0.6); click(0.3, 0.6); dblclick(0.4, 0.6);
    expect(toast()).toBe('The corners of a region must not all lie on one line');
    expect([state.drawingPoints.length, state.motionRegions.length]).toEqual([4, 0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // A placeholder region stored with every corner on one spot
    device.motionDocs['1'] = motionDocWith([[[100, 900], [400, 900], [400, 600], [100, 600]], [[0, 0], [0, 0], [0, 0], [0, 0]]]);
    try {
      await reloadMotion();
      expect(state.motionRegions.map(r => r.points.length)).toEqual([4, 4]);
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      expect(toast()).toBe('Region 2 has no area: delete or redraw it before saving');
      expect(device.puts).toHaveLength(puts);
      // Deleting it lets the rest be saved
      $('motionRegionList').querySelector('[data-delete-motion="1"]').click();
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      expect(device.puts.at(-1).body).toContain('<RegionList size="1">');
    } finally {
      delete device.motionDocs['1'];
    }
    await reloadMotion();
  });

  it('edits the grid when no capabilities answer, keeping the stored sensitivity unless the camera gives its levels', async () => {
    const busy = { httpStatus: 503, ...STATUS.serviceUnavailable };
    const caps = [
      'GET /ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection/capabilities',
      'GET /ISAPI/System/Video/inputs/channels/1/motionDetection/capabilities',
    ];
    const layout = 'GET /ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection/layout/capabilities';
    const slider = $('sensitivitySlider');
    try {
      // The InputProxy URL busy: the System one answers, and polygons stay
      device.failures[caps[0]] = busy;
      const requests = device.requests.length;
      await reloadMotion();
      expect(state.motionMode).toBe('region');
      expect(device.requests.slice(requests)).toContain(caps[1]);

      // Neither: the camera's own grid, as Hikvision's web UI falls back to, with the
      // levels from the layout capabilities
      device.failures[caps[1]] = busy;
      await reloadMotion();
      expect(state.motionMode).toBe('grid');
      expect([slider.disabled, slider.step]).toEqual([false, '20']);
      expect($('sensitivityNote').style.display).toBe('none');

      // Nothing gives the levels: the slider is locked and the stored level goes back unchanged
      device.failures[layout] = busy;
      await reloadMotion();
      expect(slider.disabled).toBe(true);
      expect($('sensitivityNote').style.display).toBe('');
      expect([slider.value, $('sensitivityVal').textContent]).toEqual(['40', '40']);
      slider.value = '50';
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      const { body } = device.puts.at(-1);
      expect(body).toContain('<sensitivityLevel>40</sensitivityLevel>');
      expect(body).toContain('<regionType>grid</regionType>');
      expect(body).toContain(`<gridMap>${fixtures.motionDetectionNvr.match(/<gridMap>([^<]+)</)[1]}</gridMap>`);
    } finally {
      for (const key of [...caps, layout]) delete device.failures[key];
    }
    await reloadMotion();
    expect(state.motionMode).toBe('region');
    expect(slider.disabled).toBe(false);
    expect($('sensitivityNote').style.display).toBe('none');
  });

  it('shows a camera in region mode read-only when no capabilities answer, and sends its area back as stored', async () => {
    const busy = { httpStatus: 503, ...STATUS.serviceUnavailable };
    const caps = [
      'GET /ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection/capabilities',
      'GET /ISAPI/System/Video/inputs/channels/1/motionDetection/capabilities',
    ];
    // Polygons saved in region mode: regionType region and a zeroed gridMap
    const gridMap = fixtures.motionDetectionNvr.match(/<gridMap>([^<]+)</)[1];
    const zeroed = '0'.repeat(gridMap.length);
    device.motionDocs['1'] = fixtures.motionDetectionNvr
      .replace('<regionType>grid</regionType>', '<regionType>region</regionType>').replace(gridMap, zeroed);
    try {
      for (const key of caps) device.failures[key] = busy;
      await reloadMotion();
      expect(state.motionMode).toBe('readonly');
      expect($('motionGridInstructions').style.display).toBe('none');
      expect($('motionReadOnlyNote').style.display).toBe('');
      expect($('motionReadOnlyNote').textContent).toContain('Load from Device to ask again');
      expect(state.motionRegions.map(r => r.points.length)).toEqual([5]);

      // Only switching detection off: the camera keeps its polygons and region mode
      $('motionToggle').click();
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      const { body } = device.puts.at(-1);
      expect(body).toContain('<enabled>false</enabled>');
      expect(body).toContain('<regionType>region</regionType>');
      expect(body).toContain(`<gridMap>${zeroed}</gridMap>`);
      const regionList = (xml) => /<RegionList[\s\S]*<\/RegionList>/.exec(xml)?.[0];
      expect(regionList(body)).toBe(regionList(device.motionDocs['1']));
    } finally {
      for (const key of caps) delete device.failures[key];
      delete device.motionDocs['1'];
    }
    await reloadMotion();
    expect(state.motionMode).toBe('region');
  });

  it('shows the regions read-only on a camera that offers region mode without the grid, and saves the rest', async () => {
    device.motionCaps['1'] = fixtures.motionCapabilitiesNvr.replace('opt="grid,region"', 'opt="region"');
    try {
      await reloadMotion();
      expect(state.motionMode).toBe('readonly');
      expect($('motionReadOnlyNote').style.display).toBe('');
      expect($('motionReadOnlyNote').textContent).toContain('Editing regions isn’t supported for this camera yet');
      expect($('motionRegionInstructions').style.display).toBe('none');
      expect($('clearMotionRegionsBtn').parentElement.style.display).toBe('none');
      expect(state.motionRegions.map(r => r.points.length)).toEqual([5]);
      expect($('motionRegionList').textContent).toContain('Region 1 (5 pts)');
      expect($('motionRegionList').querySelector('[data-delete-motion]')).toBeNull();

      // Clicks neither draw nor delete
      const { click, dblclick } = canvasPointer();
      click(0.1, 0.1); click(0.3, 0.1); click(0.3, 0.3); dblclick(0.1, 0.3);
      $('drawCanvas').dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 2, clientX: $('drawCanvas').getBoundingClientRect().left + 0.75 * $('drawCanvas').getBoundingClientRect().width,
        clientY: $('drawCanvas').getBoundingClientRect().top + 0.5 * $('drawCanvas').getBoundingClientRect().height,
      }));
      expect([state.drawingPoints.length, state.motionRegions.length]).toEqual([0, 1]);

      // Saving sends the other settings, and the stored area exactly as loaded
      $('motionToggle').click();
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      const { body } = device.puts.at(-1);
      expect(body).toContain('<enabled>false</enabled>');
      expect(body).toContain('<regionType>grid</regionType>');
      expect(body).toContain(`<gridMap>${fixtures.motionDetectionNvr.match(/<gridMap>([^<]+)</)[1]}</gridMap>`);
      const regionList = (xml) => /<RegionList[\s\S]*<\/RegionList>/.exec(xml)?.[0];
      expect(regionList(body)).toBe(regionList(fixtures.motionDetectionNvr));
    } finally {
      delete device.motionCaps['1'];
    }
    await reloadMotion();
    expect(state.motionMode).toBe('region');
    expect($('motionReadOnlyNote').style.display).toBe('none');
    expect($('clearMotionRegionsBtn').parentElement.style.display).toBe('');
    expect($('motionRegionList').querySelector('[data-delete-motion]')).not.toBeNull();
  });

  it('shows and saves the channel moved on to when the previous channel’s motion settings answer last', async () => {
    const path = (ch) => `/ISAPI/ContentMgmt/InputProxy/channels/${ch}/video/motionDetection`;
    // Channel 3's camera stores one square and samples every 2 frames; channel 1's a five-corner region, every 5
    const square = [[100, 900], [400, 900], [400, 600], [100, 600]];
    device.motionDocs['3'] = motionDocWith([square]).replace('<samplingInterval>5<', '<samplingInterval>2<');
    const corners = () => state.motionRegions.map(r => r.points.length);
    const channel3Shown = () => {
      expect(corners()).toEqual([4]);
      expect($('saveMotionBtn').disabled).toBe(false);
    };
    /** Click Save; where the PUT went, the regions' corners and the sampling interval it sent */
    const save = async () => {
      const puts = device.puts.length;
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      const { path: sentTo, body } = device.puts.at(-1);
      const sent = [...body.matchAll(/<positionX>(\d+)<\/positionX><positionY>(\d+)</g)].map(m => [+m[1], +m[2]]);
      return { path: sentTo, corners: sent, interval: /<samplingInterval>(\d+)</.exec(body)?.[1] };
    };
    const channel3Saved = { path: path(3), corners: square, interval: '2' };
    const releases = [];
    try {
      // Channel 1's reload answers after channel 3's settings are shown
      await switchWhileLoading(`GET ${path(1)}`, 'loadMotionBtn', 2, channel3Shown);
      channel3Shown();
      expect(await save()).toEqual(channel3Saved);

      // The other way round: channel 3's reload answering first leaves the panel waiting for channel 1's
      releases.push(holdRequest(`GET ${path(3)}`));
      $('loadMotionBtn').click();
      releases.push(holdRequest(`GET ${path(1)}`));
      pickChannel(0);
      releases[0]();
      await new Promise(r => setTimeout(r, 200));
      expect(state.motionDoc).toBeNull();
      expect(corners()).toEqual([]);
      expect($('saveMotionBtn').disabled).toBe(true);
      releases[1]();
      await vi.waitFor(() => expect($('saveMotionBtn').disabled).toBe(false));
      expect(corners()).toEqual([5]);

      // Channel 1's save finishing after the switch to channel 3 leaves channel 3's settings to save
      const channel1 = { doc: state.motionDoc, from: state.motionFrom };
      const put = `PUT ${path(1)}`;
      const sent = () => device.requests.filter(r => r === put).length;
      const before = sent();
      releases.push(holdRequest(put));
      $('saveMotionBtn').click();
      await vi.waitFor(() => expect(sent()).toBe(before + 1));
      pickChannel(2);
      await vi.waitFor(channel3Shown);
      releases[2]();
      await vi.waitFor(() => expect(toast()).toBe('Motion detection for channel 1 saved successfully!'));
      expect(await save()).toEqual(channel3Saved);

      // Settings of channel 1, or from before a reconnect, back in the panel go nowhere
      const channel3 = { doc: state.motionDoc, from: state.motionFrom };
      const puts = device.puts.length;
      state.motionDoc = channel1.doc;
      state.motionFrom = channel1.from;
      $('saveMotionBtn').click();
      expect(toast()).toBe('These settings were loaded from channel 1. Load channel 3’s from the device before saving');
      state.motionDoc = channel3.doc;
      state.motionFrom = { ...channel3.from, config: { ...channel3.from.config } };
      $('saveMotionBtn').click();
      expect(toast()).toBe('These settings were loaded before reconnecting. Load them from the device again before saving');
      expect(device.puts).toHaveLength(puts);
    } finally {
      releases.forEach(release => release());
      delete device.motionDocs['3'];
    }
  });

  it('keeps a late answer for the previous channel out of the privacy and event panels', async () => {
    const privacyPath = (ch) => `/ISAPI/ContentMgmt/InputProxy/channels/${ch}/video/privacyMask`;
    const masks = (xml) => xml.match(/<PrivacyMaskRegion[\s>]/g)?.length ?? 0;
    // Channel 3's camera stores no masks, channel 1's two
    device.privacy.clear(privacyPath(3));
    $('configTabs').querySelector('[data-tool="privacy"]').click();
    pickChannel(0);
    await vi.waitFor(() => {
      expect(state.privacyRegions).toHaveLength(2);
      expect($('savePrivacyBtn').disabled).toBe(false);
    });

    await switchWhileLoading(`GET ${privacyPath(1)}`, 'loadPrivacyBtn', 2, () => {
      expect(state.privacyDoc).not.toBeNull();
      expect($('savePrivacyBtn').disabled).toBe(false);
    });
    expect(state.privacyRegions).toEqual([]);
    const puts = device.puts.length;
    $('savePrivacyBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
    expect(device.deletes.at(-1)).toBe(`${privacyPath(3)}/regions`);
    expect(device.puts.at(-1).path).toBe(privacyPath(3));
    expect(masks(device.privacy.read(privacyPath(1)))).toBe(2);

    // Event actions: channel 3's reload answers after channel 1's trigger is shown
    const triggerId = () => state.eventTriggerDoc?.getElementsByTagName('id')[0]?.textContent;
    $('configTabs').querySelector('[data-tool="events"]').click();
    await vi.waitFor(() => {
      expect(triggerId()).toBe('VMD-3');
      expect($('saveEventsBtn').disabled).toBe(false);
    });
    await switchWhileLoading('GET /ISAPI/Event/triggers/VMD-3', 'loadEventsBtn', 0, () => {
      expect(triggerId()).toBe('VMD-1');
      expect($('saveEventsBtn').disabled).toBe(false);
    });
    expect(triggerId()).toBe('VMD-1');
    $('saveEventsBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 2));
    expect(device.puts.at(-1).path).toBe('/ISAPI/Event/triggers/VMD-1');
  });

  it('disables the privacy switch where the camera serves only its region list, and saves every mask on', async () => {
    const path = '/ISAPI/ContentMgmt/InputProxy/channels/2/video/privacyMask';
    const row = $('privacyToggleRow');
    const toggle = $('privacyToggle');
    // Firmware without the full document: only {path}/regions answers, a bare list without the global switch
    device.failures[`GET ${path}`] = { httpStatus: 403, ...STATUS.notSupport };
    try {
      $('configTabs').querySelector('[data-tool="privacy"]').click();
      pickChannel(1);
      await vi.waitFor(() => {
        expect(state.privacyPath).toBe(`${path}/regions`);
        expect($('savePrivacyBtn').disabled).toBe(false);
      });
      const masks = state.privacyRegions.length;
      expect(masks).toBeGreaterThan(0);
      expect(row.classList.contains('unavailable')).toBe(true);
      expect(row.title).toBe('This device doesn’t let the extension switch masks on or off');
      expect(toggle.getAttribute('aria-disabled')).toBe('true');
      // Its regions read back enabled=false: shown off, and the switch can't change that
      expect(toggle.classList.contains('on')).toBe(false);
      toggle.click();
      expect([state.privacyEnabled, toggle.classList.contains('on')]).toEqual([false, false]);

      const [puts, deletes] = [device.puts.length, device.deletes.length];
      $('savePrivacyBtn').click();
      await vi.waitFor(() => expect(device.puts).toHaveLength(puts + 1));
      const { path: putPath, body } = device.puts.at(-1);
      expect(putPath).toBe(`${path}/regions`);
      expect(device.deletes).toHaveLength(deletes);
      expect(new DOMParser().parseFromString(body, 'application/xml').documentElement.localName).toBe('PrivacyMaskRegionList');
      // Yet every mask shown is saved on, and the switch then shows that
      expect([...body.matchAll(/<enabled>(\w+)<\/enabled>/g)].map(m => m[1])).toEqual(Array(masks).fill('true'));
      await vi.waitFor(() => expect(toast()).toBe('Privacy mask saved successfully!'));
      expect([state.privacyEnabled, toggle.classList.contains('on')]).toEqual([true, true]);
    } finally {
      delete device.failures[`GET ${path}`];
    }

    // The full document has the switch
    $('loadPrivacyBtn').click();
    await vi.waitFor(() => {
      expect(state.privacyPath).toBe(path);
      expect($('savePrivacyBtn').disabled).toBe(false);
    });
    expect(row.classList.contains('unavailable')).toBe(false);
    expect(row.title).toBe('');
    expect(toggle.getAttribute('aria-disabled')).toBe('false');
    toggle.click();
    expect([state.privacyEnabled, toggle.classList.contains('on')]).toEqual([false, false]);
    toggle.click();
    expect(state.privacyEnabled).toBe(true);
  });

  it('stops all four feeds after one retry when the device rejects the password mid-session', async () => {
    $('liveViewSectionTab').click();
    $('gridViewTab').click();
    // From now on the device challenges requests without credentials, as the NVR does,
    // so the feeds send a cached challenge (a warm session) when the password changes
    device.digestAuth = true;
    device.snapshotDelayMs = 300;
    const pictures = [1, 2, 3, 4].map(ch => `GET /ISAPI/Streaming/channels/${ch}02/picture`);
    let release = () => {};
    try {
      await vi.waitFor(() => expect(device.authorized).toBeGreaterThanOrEqual(8), { timeout: 5000 });
      // The password changes; hold each feed's next request at the device until all four
      // are on their way with the cached challenge, the worst case
      const held = new Promise(resolve => { release = resolve; });
      pictures.forEach(request => { device.holds[request] = held; });
      device.failedLogins = 0;
      device.rejectAuth = true;
      const since = device.requests.length;
      await vi.waitFor(() => expect(new Set(device.requests.slice(since))).toEqual(new Set(pictures)), { timeout: 3000 });
      pictures.forEach(request => { delete device.holds[request]; });
      release();
      await vi.waitFor(() => expect(state.connected).toBe(false), { timeout: 5000 });
      const afterRejection = device.requests.length;
      await new Promise(r => setTimeout(r, 2500));

      expect(device.requests.length).toBe(afterRejection);
      // The four requests already sent with the cached challenge, then one retry for all
      // of them (a retry each would make it 8)
      expect(device.failedLogins).toBe(4 + 1);
      expect($('connectionForm').style.display).toBe('block');
      expect($('passInput').value).toBe('');
      expect(toast()).toBe('The device rejected the login. Re-enter the password to reconnect.');
    } finally {
      pictures.forEach(request => { delete device.holds[request]; });
      release();
      device.digestAuth = false;
      device.snapshotDelayMs = 1200;
    }
  });

  it('logs in with userCheck and keeps the plain message for an unexplained rejection', async () => {
    device.failedLogins = 0;
    $('passInput').value = 'wrong-pass';
    $('connectBtn').click();
    await vi.waitFor(() => expect(toast()).toBe('Connection failed: Device rejected the username or password'));
    expect(device.failedLogins).toBe(1);
    // Then whether the device has been activated (it has), asked without a login
    expect(device.requests.slice(-3)).toEqual(['GET /ISAPI/Security/userCheck', 'GET /ISAPI/Security/userCheck', 'GET /SDK/activateStatus']);
    await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));
  });

  it('says to activate a device that hasn’t been activated, asking it without a login', async () => {
    device.failedLogins = 0;
    device.activated = false;
    try {
      $('connectBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('Connection failed: This device hasn’t been activated yet — ' +
        'activate it with Hikvision SADP or its web page first, then connect with the admin password you set there'));
      expect(device.failedLogins).toBe(1);
      expect(device.activationChecks.at(-1)).toEqual({ authorization: null, credentials: 'omit' });
      await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));

      // Firmware without /SDK/activateStatus: the plain message
      device.activated = null;
      $('toast').textContent = '';
      $('connectBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('Connection failed: Device rejected the username or password'));
      expect(device.requests.at(-1)).toBe('GET /SDK/activateStatus');
    } finally {
      device.activated = true;
    }
    await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));
  });

  it('reads the port once, so a rejected login on a loosely typed port still gets its message', async () => {
    device.failedLogins = 0;
    const activationChecks = device.activationChecks.length;
    try {
      // Leading digits count, as they always have; the activation check uses the same port as the login
      $('portInput').value = '80a';
      $('toast').textContent = '';
      $('connectBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('Connection failed: Device rejected the username or password'));
      expect($('statusText').textContent).toBe('Connection failed');
      expect(device.failedLogins).toBe(1);
      expect(device.activationChecks).toHaveLength(activationChecks + 1);
      await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));

      // Not a port at all: nothing is sent
      const requests = device.requests.length;
      $('portInput').value = 'abc';
      $('connectBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('The port must be a number from 1 to 65535 (80 when left empty)'));
      expect(device.requests).toHaveLength(requests);
    } finally {
      $('portInput').value = '80';
    }
  });

  it('says how many attempts are left before the device locks this computer out', async () => {
    device.loginLock = { lockStatus: 'unlock', unlockTime: 0, retryLoginTime: 2 };
    device.failedLogins = 0;
    const activationChecks = device.activationChecks.length;
    $('connectBtn').click();
    await vi.waitFor(() => expect(toast())
      .toBe('Connection failed: Wrong user name or password — 2 attempts left before the device locks this computer out'));
    expect(device.failedLogins).toBe(1);
    // Whether it has been activated is asked after every rejected login, without one
    expect(device.activationChecks).toHaveLength(activationChecks + 1);
    expect(device.activationChecks.at(-1)).toEqual({ authorization: null, credentials: 'omit' });
    await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));

    // A device that counts attempts may not be activated either: say so, and keep the count
    device.activated = false;
    device.loginLock = { lockStatus: 'unlock', unlockTime: 0, retryLoginTime: 1 };
    try {
      $('connectBtn').click();
      await vi.waitFor(() => expect(toast()).toBe('Connection failed: This device hasn’t been activated yet — ' +
        'activate it with Hikvision SADP or its web page first, then connect with the admin password you set there. ' +
        'Wrong user name or password — 1 attempt left before the device locks this computer out'));
      expect(device.failedLogins).toBe(2);
    } finally {
      device.activated = true;
      device.loginLock = { lockStatus: 'unlock', unlockTime: 0, retryLoginTime: 2 };
    }
    await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));
  });

  it('says how long the device has locked logins, and keeps the password', async () => {
    device.loginLock = { lockStatus: 'lock', unlockTime: 1790, retryLoginTime: 0 };
    $('connectBtn').click();
    await vi.waitFor(() => expect(toast())
      .toBe('Connection failed: The device has temporarily locked logins from this computer — try again in 30 min'));
    expect($('passInput').value).toBe('wrong-pass');
    expect(state.connected).toBe(false);
    await vi.waitFor(() => expect($('connectBtn').disabled).toBe(false));
  });

  it('keeps the password when the device locks logins mid-session', async () => {
    device.rejectAuth = false;
    device.loginLock = null;
    $('passInput').value = 'test-pass';
    $('connectBtn').click();
    await vi.waitFor(() => expect(state.channels).toHaveLength(4));

    // What a request gets when the device explains its 401 (V4.75 sends HTML pages instead)
    Isapi.onAuthFailure?.(new AuthError({ statusValue: 401, locked: true, unlockSeconds: 600 }));
    expect(state.connected).toBe(false);
    expect(toast()).toBe('The device has temporarily locked logins from this computer — try again in 10 min');
    expect($('passInput').value).toBe('test-pass');
  });

  it('shows each device a scan found with its port, says which need activating, and fills in that port', async () => {
    const { showScanResults } = await import('../../extension/src/scan.js');
    showScanResults([
      { ip: '192.168.0.64', port: 8080, confirmed: true, activated: false },
      { ip: '192.168.0.70', port: 80, confirmed: false, activated: null },
    ]);
    expect($('scanResultsText').textContent).toBe('Found 2 devices that may be Hikvision. Click one to connect:');
    const cards = [...document.querySelectorAll('#scanDeviceList .scan-device-card')];
    expect(cards.map(card => [...card.children].map(el => el.textContent))).toEqual([
      ['192.168.0.64', 'Hikvision NVR / Camera • Port 8080', 'Not activated — activate it with Hikvision SADP or its web page first'],
      ['192.168.0.70', 'Possible Hikvision device • Port 80'],
    ]);
    cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect($('connectionForm').style.display).toBe('block');
    expect([$('hostInput').value, $('portInput').value]).toEqual(['192.168.0.64', '8080']);
  });

  it('lists an NVR’s cameras by number from its stream list, and configures them as IP cameras', async () => {
    // Firmware with neither channel list (the analog one is notSupport already)
    const ipList = 'GET /ISAPI/ContentMgmt/InputProxy/channels';
    device.failures[ipList] = { httpStatus: 403, ...STATUS.notSupport };
    const since = device.requests.length;
    try {
      $('hostInput').value = NVR_HOST;
      $('portInput').value = '80';
      $('connectBtn').click();
      await vi.waitFor(() => expect(state.channels).toHaveLength(4));
    } finally {
      delete device.failures[ipList];
    }
    expect(device.requests.slice(since)).toContain('GET /ISAPI/Streaming/channels');
    // Each stream's <channelName> is its own number ("101"), not the camera's name
    const items = [...document.querySelectorAll('.channel-item')];
    expect(items.map(el => [el.querySelector('.ch-num')?.textContent, el.querySelector('span:not(.ch-num)')?.textContent]))
      .toEqual([['1', 'Channel 1'], ['2', 'Channel 2'], ['3', 'Channel 3'], ['4', 'Channel 4']]);
    expect(state.channels.map(ch => ch.kind)).toEqual(['digital', 'digital', 'digital', 'digital']);

    $('configSectionTab').click();
    $('configTabs').querySelector('[data-tool="motion"]').click();
    await vi.waitFor(() => expect(device.requests.slice(since))
      .toContain('GET /ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection'));
    expect(device.requests.slice(since).some(r => r.includes('/ISAPI/System/Video/inputs/channels/'))).toBe(false);
  });
});
