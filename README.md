# ReadAloud

Chrome extension that reads web pages aloud using Edge Neural TTS voices, with word-by-word highlighting synced to audio.

Uses [edge-tts](https://github.com/rany2/edge-tts) via native messaging — not the browser's built-in Web Speech API — for high-quality neural voices.

## Features

- **Word-by-word highlighting** — synced with audio, smooth transitions
- **50+ neural voices** — Microsoft Edge TTS voices across 30+ locales
- **Canvas-rendered site support** — works with WeRead (微信读书) and other canvas-based book readers
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

The install script will install the `edge-tts` dependency and register the native messaging host. When it pauses, open Chrome and load the extension:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the cloned folder

Then press Enter in the terminal to finish.

## Usage

| Action | How |
|---|---|
| Read page / selection | Alt+R, right-click menu, or popup button |
| Pause / Resume | Alt+R (toggle) |
| Stop | Alt+S or popup button |
| Voice / Speed | Click extension icon |

Alt+R is context-aware: no selection → reads full page. Already reading → pauses. Paused → resumes.

## Architecture

### Text Extraction (Strategy Chain)

Page text extraction uses a priority-ordered strategy chain. Each strategy independently decides if it can handle the current page. The first match wins.

```
semantic → og-article → common-content → body-fallback
    ↓           ↓             ↓              ↓
  match=return  match=return  match=return   fallback
```

| Strategy | Match condition | Target pages |
|---|---|---|
| `semantic` | `<article>`, `<main>`, `[role="main"]` | Blogs, news sites with HTML5 semantic tags |
| `og-article` | `<meta og:type="article">` + content container (`#content`, `.article-content`, etc.) | Douban, WordPress, non-semantic article pages |
| `common-content` | Common content selectors (`#article-content`, `.post-content`, etc.) with 200-char threshold | Generic CMS pages |
| `body-fallback` | `document.body.innerText` | Last resort |

#### Special Site Support

Some sites require custom extraction methods and bypass the strategy chain entirely:

| Site | Method | Notes |
|---|---|---|
| **WeRead (weread.qq.com)** | Canvas fillText interception + position overlay | Injects into MAIN world to intercept `CanvasRenderingContext2D.fillText`, captures per-character coordinates for accurate highlighting |

- Each strategy is independent — adding new ones doesn't affect existing behavior
- To support a new page type: add a strategy function to the `EXTRACTORS` array in `content.js`
- For canvas-rendered sites: inject a MAIN world script (see `weread-hook.js` pattern)
- Existing pages: `semantic` and `body-fallback` behave identically to before the change

### Language Detection

Voice selection is automatic based on the text language. If the user's selected voice doesn't match the text (e.g. English voice on a Chinese page), the system auto-switches to a compatible voice. This happens at read start time and is stored in session state, so it survives MV3 service worker restarts.

- CJK text uses smaller chunks (300 chars vs 1000 for English) to stay under Chrome's 1MB native messaging response limit
- Sentence splitting supports both ASCII (`.!?`) and CJK (`。！？；`) punctuation

### Debugging

Open DevTools Console and look for `[ReadAloud]` prefixed logs. These show which extraction strategy matched, the extracted text preview, voice selection, and chunk synthesis details.

## License

This project is licensed under the [MIT License](LICENSE).

### Third-Party Components

| Component | License |
|---|---|
| [edge-tts](https://github.com/rany2/edge-tts) | [LGPL-3.0](https://github.com/rany2/edge-tts/blob/master/LICENSE) |

`edge-tts` is installed and runs as a standalone process via native messaging — it is not linked or bundled with this extension.

### Disclaimer

The TTS voices and speech synthesis service are provided by third parties. This project does not host, distribute, or guarantee the availability of any voice models or cloud services.
