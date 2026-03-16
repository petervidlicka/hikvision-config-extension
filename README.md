# Hikvision Config Extension

A lightweight Chrome extension designed to help you view live camera feeds and easily configure your Hikvision Network Video Recorder (NVR) directly from your browser.

## The Story Behind It

Configuring Hikvision motion detection through their official applications proved to be incredibly frustrating:
- On **Mac**, the official app simply doesn't trigger the camera feeds at all.
- On **Windows**, the tool only seems to work properly in Internet Explorer, which meant I'd have to constantly dust off an ancient Windows laptop just to change basic settings.
- Even the professional installer who set up my cameras avoided configuring these settings because the official tool tends to get stuck.

To solve this, I opted to build this lightweight Chrome extension as a straightforward, modern, and cross-platform alternative.

## Features

- **Live Camera Feeds**: View the live stream from your connected cameras.
- **Set Motion Detection**: Quickly configure your camera's motion detection settings.
- **Auto-Discovery**: The extension will automatically scan your local network to identify your Hikvision NVR's IP address. No need to search for it manually, even if the IP happens to change.

> **Note**: You must be connected to your home network to use this extension, as it will not work remotely.

## Contributing

I haven't bothered adding other administrative functionality simply because I never needed to set it up for my own use case. I am happy to add more features in the future, or feel free to fork this project and send me a Pull Request!
