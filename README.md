# Hikvision Config Extension

A lightweight Chrome extension designed to help you view live camera feeds and easily configure your Hikvision Network Video Recorder (NVR) directly from your browser.

## The Story Behind It

Configuring Hikvision motion detection through their official applications proved to be incredibly frustrating:
- On **Mac**, the official app simply doesn't trigger the camera feeds at all.
- On **Windows**, the tool only seems to work properly in Internet Explorer, which meant I'd have to constantly dust off an ancient Windows laptop just to change basic settings.
- Even the professional installer who set up my cameras avoided configuring these settings because the official tool tends to get stuck.

To solve this, I opted to build this lightweight Chrome extension as a straightforward, modern, and cross-platform alternative.

## Features

- **Live Camera Feeds**: View single-camera or 4-camera grid view with per-cell channel selection and full-screen maximize. Switch the single view between SD (faster) and HD; the status bar shows frames per second.
- **Playback**: See a day's recordings on a 24-hour timeline, with motion events highlighted, day-by-day navigation and an events-only filter. Where the device provides still images from recordings, you can step through them; browsers can't play the recorded video stream itself.
- **Motion Detection**: Draw polygon detection regions on the live image, toggle detection on/off, adjust sensitivity, and choose person/vehicle targets. The extension follows the limits your device reports (number of regions, corners per region, sensitivity steps). Cameras that only support a detection grid get a cell editor instead.
- **Privacy Masks**: Draw up to 4 rectangular privacy mask regions on the video feed to block sensitive areas.
- **Event Actions**: Control what happens when motion is detected — toggle recording, push notifications (Hik-Connect), email alerts, audible warnings, alarm output, white light, and audio alarms per channel.
- **Auto-Discovery**: Automatically scan your local network to find your Hikvision NVR — no need to search for the IP manually.
- **Auto-Load Settings**: Configuration settings are automatically fetched from the device when switching tools or channels, with a visual loading state so you always know what's current.
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
- `npm test`: Vitest. Node tests cover Digest auth and the network scan. Browser tests run headless in your installed Chrome and cover XML handling and an end-to-end run of the config page against a mock NVR.
- `npm run harness`: opens the config page with a mock NVR, for working on the UI without a device.

To test against your own device's XML, `tests/capture-fixtures.sh <host>` downloads its config (read-only) into a git-ignored folder that the tests pick up. How Hikvision's own web UI talks to the device is documented in [docs/isapi-notes.md](docs/isapi-notes.md).

## Contributing

I haven't bothered adding other administrative functionality simply because I never needed to set it up for my own use case. I am happy to add more features in the future, or feel free to fork this project and send me a Pull Request!

## License

[MIT](LICENSE)
