# Hikvision Config Extension

A lightweight Chrome extension designed to help you view live camera feeds and easily configure your Hikvision Network Video Recorder (NVR) directly from your browser.

## The Story Behind It

Configuring Hikvision motion detection through their official applications proved to be incredibly frustrating:
- On **Mac**, the official app simply doesn't trigger the camera feeds at all.
- On **Windows**, the tool only seems to work properly in Internet Explorer, which meant I'd have to constantly dust off an ancient Windows laptop just to change basic settings.
- Even the professional installer who set up my cameras avoided configuring these settings because the official tool tends to get stuck.

To solve this, I opted to build this lightweight Chrome extension as a straightforward, modern, and cross-platform alternative.

## Status

The extension is feature-complete and will receive security fixes only. A desktop app with smooth live video is in development.

## Features

- **Live Camera Feeds**: Single-camera view, or a 4-camera grid with per-cell channel selection and full-screen maximize. The live view is a series of snapshots, not video: an NVR typically refreshes its snapshot about once a second, while a camera connected directly can deliver several a second. Repeated pictures are skipped, and the status bar shows how many new pictures a second actually arrive. The single view switches between SD (faster) and HD, which on an NVR is its full-size still where it offers one (about 1920×1088 instead of 704×576); pictures are shown at the camera's real aspect. A camera that stops answering shows "No signal" and is asked less and less often until it is back. Feeds pause while the tab is in the background.
- **Playback**: See a day's recordings on a 24-hour timeline, with event recordings highlighted (manual and command recordings get their own colours, as in iVMS), day-by-day navigation, the month's days with recordings, and an events-only filter. Every recording of the day is shown, also beyond the 64 an NVR returns per request. Days and times follow the device's own clock, so the timeline is right in any time zone and on the days the clocks change. Pictures the device stores (scheduled or on motion, if enabled on the NVR) appear as yellow markers you can click to view. Where the device provides still images from recorded video, you can step through them. Browsers can't play the recorded video stream itself.
- **Motion Detection**: Draw polygon detection regions on the live image, toggle detection on/off, adjust sensitivity, and choose person/vehicle targets; other detection targets the camera has switched on are kept. The extension follows the limits your device reports (number of regions, corners per region, sensitivity steps), and refuses regions whose edges cross, which the device would reject. Cameras that only support a detection grid get a cell editor instead; on cameras whose regions the extension can't edit yet (older region-only models), the regions are shown read-only and the other settings can still be saved.
- **Privacy Masks**: Draw up to 4 rectangular privacy mask regions on the video feed to block sensitive areas. Masks already stored on the device are shown, and a deleted mask is really removed; if a save fails halfway, the masks as loaded are put back. Where a device serves only its list of mask regions, the extension can't switch masking on or off, so the switch is disabled and every mask shown is saved switched on.
- **Event Actions**: Control what happens when motion is detected on each camera: recording, push notifications (Hik-Connect), email alerts, audible warnings, alarm output, white light, and audio alarms. Alarm output, white light and audio alarm use that channel's own camera, and recording changes only that channel's recording. Actions the device or camera can't do are greyed out, with the reason on hover.
- **Auto-Discovery**: Automatically scan your local network to find your Hikvision NVR — no need to search for the IP manually. The scan looks on port 80 and 8080 across the subnets home routers commonly use, and stops at the first subnet with a device. Each device found is marked as a confirmed Hikvision or only a possible one, and shows its port; a device that hasn't been activated yet says so, since it must be activated with Hikvision SADP or its web page first. A scan that finds nothing takes up to about 2 minutes, and you can cancel it at any time.
- **Login Protection**: Hikvision devices lock a computer out after a few failed logins, and refuse even the right password until the lock lifts. A wrong password costs as few failed logins as possible, and once the device rejects it, it isn't sent again until you press Connect. When the device says it has locked this computer out, or how many attempts are left, the message says so.
- **Auto-Load Settings**: Configuration settings are automatically fetched from the device when switching tools or channels, with a visual loading state so you always know what's current. Settings that arrive after you've moved on to another channel are dropped, and a save always goes to the channel and device its settings were loaded from. When the device refuses a change, its reason is shown, and a change that needs a reboot says so.
- **Remember Credentials**: Your password is kept in memory until Chrome closes. Optionally, you can remember it on this computer (stored unencrypted in Chrome's extension storage).

The extension only asks for access to a device when you connect to it, and for broad network access only while a network scan is running. Chrome will prompt you each time.

> **Note**: You must be connected to your home network to use this extension, as it will not work remotely.

## Installation

1. Download this repository to your local machine. You can do this by clicking the green **Code** button at the top of this repository and selecting **Download ZIP**, then extract the downloaded folder.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top right corner.
4. Click the **Load unpacked** button and select the **`extension`** folder inside the downloaded repository (not the repository folder itself).
5. The extension will now be installed and accessible from your Chrome extensions menu!

## Development

The extension is plain JavaScript (ES modules, no build step) in `extension/`. Tooling lives at the repository root and needs Node.js and a local Google Chrome:

```bash
npm install
npm run check      # lint + type check + tests
```

- `npm run lint`: ESLint
- `npm run typecheck`: TypeScript in strict mode over the JSDoc-annotated JavaScript
- `npm test`: Vitest. Node tests cover the pure modules in `extension/lib` (Digest auth, the network scan, snapshot pacing, shapes, device time and more), also in two time zones with daylight saving. Browser tests run headless in your installed Chrome and cover XML handling, ISAPI requests, playback parsing and an end-to-end run of the config page against a mock NVR.
- `npm run harness`: opens the config page with a mock NVR, for working on the UI without a device.

The committed fixtures in `tests/fixtures` named `*-nvr` are captures from a DS-7604NI-K1/4P NVR (serial numbers removed); the others are synthetic and say why. To test against your own device's XML, `tests/capture-fixtures.sh <host>` downloads its config (read-only) into a git-ignored folder that the tests pick up. What Hikvision's own clients do and what the NVR answered is documented in [docs/isapi-notes.md](docs/isapi-notes.md).

## Contributing

I haven't bothered adding other administrative functionality simply because I never needed to set it up for my own use case. The extension now receives security fixes only, so feel free to fork it if you need more.

## License

[MIT](LICENSE)
