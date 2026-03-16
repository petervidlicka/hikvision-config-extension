# Hikvision Config Extension

A lightweight Chrome extension designed to help you view live camera feeds and easily configure your Hikvision Network Video Recorder (NVR) directly from your browser.

## The Story Behind It

Configuring Hikvision motion detection through their official applications proved to be incredibly frustrating:
- On **Mac**, the official app simply doesn't trigger the camera feeds at all.
- On **Windows**, the tool only seems to work properly in Internet Explorer, which meant I'd have to constantly dust off an ancient Windows laptop just to change basic settings.
- Even the professional installer who set up my cameras avoided configuring these settings because the official tool tends to get stuck.

To solve this, I opted to build this lightweight Chrome extension as a straightforward, modern, and cross-platform alternative.

## Features

- **Live Camera Feeds**: View single-camera or 4-camera grid view with per-cell channel selection and full-screen maximize.
- **Motion Detection**: Configure motion detection zones by painting grid cells, toggle detection on/off, and adjust sensitivity.
- **Privacy Masks**: Draw up to 4 rectangular privacy mask regions on the video feed to block sensitive areas.
- **Event Actions**: Control what happens when motion is detected — toggle recording, push notifications (Hik-Connect), email alerts, audible warnings, alarm output, white light, and audio alarms per channel.
- **Auto-Discovery**: Automatically scan your local network to find your Hikvision NVR — no need to search for the IP manually.
- **Auto-Load Settings**: Configuration settings are automatically fetched from the device when switching tools or channels, with a visual loading state so you always know what's current.
- **Remember Credentials**: Optionally save your connection details locally for quick reconnection.

> **Note**: You must be connected to your home network to use this extension, as it will not work remotely.

## Installation

1. Download this repository to your local machine. You can do this by clicking the green **Code** button at the top of this repository and selecting **Download ZIP**, then extract the downloaded folder. 
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top right corner.
4. Click the **Load unpacked** button and select the directory containing this extension.
5. The extension will now be installed and accessible from your Chrome extensions menu!

## Contributing

I haven't bothered adding other administrative functionality simply because I never needed to set it up for my own use case. I am happy to add more features in the future, or feel free to fork this project and send me a Pull Request!
