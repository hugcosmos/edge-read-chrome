# ReadAloud

Chrome extension that reads web pages aloud using Edge Neural TTS voices, with word-by-word highlighting synced to audio.

Uses [edge-tts](https://github.com/rany2/edge-tts) via native messaging — not the browser's built-in Web Speech API — for high-quality neural voices.

## Features

- **Word-by-word highlighting** — each word is highlighted in sync with the audio, with smooth transitions
- **50+ neural voices** — all Microsoft Edge TTS voices across 30+ locales
- **Speed control** — 0.5x to 2.0x
- **Keyboard shortcuts** — Alt+R to start/pause/resume, Alt+S to stop
- **Right-click context menus** — read selection or full page
- **Pause & resume** — both audio and highlighting stay in sync

## Install

### Prerequisites

- macOS (native messaging host registration is macOS-only)
- Python 3.8+ with `pip`
- Google Chrome

### Steps

```bash
git clone https://github.com/hugcosmos/edge-read-chrome.git
cd edge-read-chrome
bash install.sh
```

The install script will:

1. Install the `edge-tts` Python package
2. Ask you to load the extension in Chrome (`chrome://extensions` → Developer Mode → Load Unpacked → select the project folder)
3. Auto-detect the extension ID and register the native messaging host

After the script finishes, reload the extension in `chrome://extensions`. The popup should show **"Edge TTS connected"**.

## Usage

| Action | How |
|---|---|
| Read page | Alt+R, or right-click → "Read Aloud (page)", or popup button |
| Read selection | Select text, then Alt+R, or right-click → "Read Aloud (selection)", or popup button |
| Pause / Resume | Alt+R (toggle) |
| Stop | Alt+S, or popup button |
| Change voice | Click the extension icon → voice dropdown |
| Change speed | Click the extension icon → speed slider |

Alt+R is context-aware: if no text is selected, it reads the entire page. If already reading, it pauses. If paused, it resumes.

## Architecture

```
Popup ──sendMessage──▶ Background (service worker)
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         Content Script  Offscreen Doc  Native Host (Python)
         (text + highlights) (audio playback) (edge-tts synthesis)
```

- **Background** orchestrates everything: splits text into chunks, calls native host for synthesis, routes audio to offscreen document, sends highlight data to content script
- **Content script** extracts page text, wraps words in highlight spans, runs a 60ms timer synced to audio timestamps
- **Offscreen document** plays audio (required in MV3 — service workers can't play audio)
- **Native host** is a Python process communicating over stdio with 4-byte length-prefixed JSON

## Tech Stack

- Chrome Extension Manifest V3
- Python + [edge-tts](https://github.com/rany2/edge-tts) for TTS synthesis
- Chrome Native Messaging for process communication
- Chrome Offscreen Documents for audio playback

## License

MIT
