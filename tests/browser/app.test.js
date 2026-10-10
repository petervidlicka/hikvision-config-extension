/**
 * End-to-end: the real config page (app.html + src/main.js) against a mock
 * NVR. Steps share one page, so they run in order.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import appHtml from '../../extension/app.html?raw';
import '../../extension/app.css';
import { NVR_HOST, STATUS, createChromeStub, createMockNvr } from '../support/mock-nvr.js';

let device, chromeStub, state, dom;
const $ = (id) => document.getElementById(id);
const toast = () => $('toast').textContent;

/** Dispatch canvas mouse events at a fraction of the canvas size. */
function canvasPointer() {
  const canvas = $('drawCanvas');
  const at = (fx, fy) => {
    const r = canvas.getBoundingClientRect();
    return { clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, bubbles: true, button: 0 };
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

  it('connects and lists channels as text', async () => {
    $('manualEntryBtn').click();
    $('hostInput').value = NVR_HOST;
    $('passInput').value = 'test-pass';
    $('connectBtn').click();
    await vi.waitFor(() => expect(state.channels).toHaveLength(2));

    expect($('deviceInfo').textContent).toBe('Mock NVR • FW V4.0');
    const names = [...document.querySelectorAll('.channel-item span')].map(s => s.textContent);
    expect(names).toEqual(['Front & Gate', '<img src=x onerror=alert(1)>']);
    expect(document.querySelector('.channel-item img')).toBeNull();
    expect(chromeStub.store.session.password).toBe('test-pass');
    expect(chromeStub.store.local.password).toBeUndefined();
  });

  it('streams SD frames as blobs without overlapping requests', async () => {
    await vi.waitFor(() => expect(dom.videoFeed.src).toMatch(/^blob:/), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 2500));
    expect(device.maxInFlightSnapshots).toBe(1);
    expect(device.requests.filter(r => r.endsWith('/picture'))).toContain('GET /ISAPI/Streaming/channels/102/picture');
    expect($('statusRight').textContent).toMatch(/^Channel 1 · SD · \d+ fps$/);
  });

  it('switches the single view to the HD stream and remembers it', async () => {
    $('streamBtnHd').click();
    expect(chromeStub.store.local.streamType).toBe('main');
    await vi.waitFor(() => expect(device.requests.at(-1)).toBe('GET /ISAPI/Streaming/channels/101/picture'), { timeout: 3000 });
    expect($('statusRight').textContent).toMatch(/^Channel 1 · HD/);
    // The SD frame in flight was cancelled, not left running next to the HD one
    expect(device.maxInFlightSnapshots).toBe(1);
  });

  it('loads motion detection with the device limits', async () => {
    $('configSectionTab').click();
    await vi.waitFor(() => expect(state.motionDoc).not.toBeNull());
    expect($('sensitivitySlider').step).toBe('20');
    expect($('motionMaxRegions').textContent).toBe('4');
    expect($('motionPointRange').textContent).toBe('4–10');
    expect($('detectHuman').checked).toBe(true);
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
    $('saveMotionBtn').click();
    await vi.waitFor(() => expect(device.puts).toHaveLength(1));

    const { path, body } = device.puts[0];
    expect(path).toBe('/ISAPI/ContentMgmt/InputProxy/channels/1/video/motionDetection');
    expect(body).toMatch(/<sensitivityLevel>60<\/sensitivityLevel>/);
    expect(body).toMatch(/<targetType[^>]*>human,vehicle<\/targetType>/);
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

  it('edits the cell grid on a grid-only camera', async () => {
    $('configTabs').querySelector('[data-tool="motion"]').click();
    document.querySelectorAll('.channel-item')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(state.motionMode).toBe('grid'));
    expect($('motionGridInstructions').style.display).toBe('');
    expect($('motionRegionInstructions').style.display).toBe('none');
    expect($('dynamicAnalysisRow').style.display).toBe(''); // the fixture has the field

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
  });

  it('shows stored privacy masks the right way up and saves exactly the drawn ones', async () => {
    $('configTabs').querySelector('[data-tool="privacy"]').click();
    await vi.waitFor(() => expect(state.privacyDoc).not.toBeNull());
    // The NVR stores a mask at the top left and one at the bottom right, both reading enabled=false
    const { width, height } = dom.canvas;
    expect(state.privacyRegions.map(r => [r.x / width, r.y / height, r.w / width, r.h / height]))
      .toEqual([[0, 0, 0.25, 0.25], [0.75, 0.75, 0.25, 0.25]]);
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
    expect(state.privacyRegions[1].y / height).toBeCloseTo(0.05, 2);
  });

  it('shows the day’s recordings and frames in Playback', async () => {
    $('playbackSectionTab').click();
    await vi.waitFor(() => expect($('pbInfo').textContent).toMatch(/^2 recordings, 32 min, 1 triggered by events\./));
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

  it('stops everything after one failed login when the device rejects the password', async () => {
    $('liveViewSectionTab').click();
    device.rejectAuth = true;
    await vi.waitFor(() => expect(state.connected).toBe(false), { timeout: 5000 });
    const afterRejection = device.requests.length;
    await new Promise(r => setTimeout(r, 2500));

    expect(device.requests.length).toBe(afterRejection);
    expect($('connectionForm').style.display).toBe('block');
    expect($('passInput').value).toBe('');
    expect(toast()).toMatch(/rejected the login/);
  });
});
