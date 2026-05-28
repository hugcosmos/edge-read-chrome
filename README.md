# ReadAloud

Chrome extension that reads web pages aloud using Edge Neural TTS voices, with word-by-word highlighting synced to audio.

Uses [edge-tts](https://github.com/rany2/edge-tts) via native messaging — not the browser's built-in Web Speech API — for high-quality neural voices.

## Features

- **Word-by-word highlighting** — synced with audio, smooth transitions
- **50+ neural voices** — Microsoft Edge TTS voices across 30+ locales
- **Speed control** — 0.5x to 2.0x
- **Keyboard shortcuts** — Alt+R start/pause/resume, Alt+S stop
- **Right-click context menu** — read selection or full page
- **Pause & resume** — audio and highlighting stay in sync

## Install

macOS only. Requires Python 3 and Google Chrome.

```bash
git clone https://github.com/hugcosmos/edge-read-chrome.git
cd edge-read-chrome
bash install.sh
```

## Usage

| Action | How |
|---|---|
| Read page / selection | Alt+R, right-click menu, or popup button |
| Pause / Resume | Alt+R (toggle) |
| Stop | Alt+S or popup button |
| Voice / Speed | Click extension icon |

Alt+R is context-aware: no selection → reads full page. Already reading → pauses. Paused → resumes.

## License

MIT. Depends on [edge-tts](https://github.com/rany2/edge-tts) (LGPL-3.0), installed separately via pip.
