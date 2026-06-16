# ReadAloud

Chrome extension that reads web pages aloud using Edge Neural TTS voices, with word-by-word highlighting synced to audio.

Uses [edge-tts](https://github.com/rany2/edge-tts) via native messaging — not the browser's built-in Web Speech API — for high-quality neural voices.

## Features

- **Word-by-word highlighting** — synced with audio via a 60 ms timer driven by `audio.currentTime`
- **Neural voices** — any voice Microsoft Edge TTS exposes (fetched live at runtime; the popup lists whatever the host returns)
- **Special-site extraction** — built-in support for WeRead (微信读书, canvas-based), QQ Reading, Tianya, and Douban
- **Single-section reading (WeRead)** — reads one section at a time (title → next title), then stops; start the next section from the table of contents
- **Speed control** — 0.5x to 2.0x
- **Voice auto-switching** — picks a voice matching the page's detected language (Chinese / Japanese / Korean / other)
- **Keyboard shortcuts** — Alt+R start/pause/resume, Alt+S stop
- **Right-click context menu** — read selection or full page
- **Pause & resume** — see [Pause/resume behavior](#pause--resume-behavior) for the exact semantics
- **Survives MV3 service-worker restarts** — reading state is persisted to `chrome.storage.session` and recovered across restarts

## Install

macOS only. Requires Python 3 and Google Chrome.

```bash
git clone https://github.com/hugcosmos/edge-read-chrome.git
cd edge-read-chrome
bash install.sh
```

The install script will install the `edge-tts` dependency and register the native messaging host. When it pauses, it is waiting for the extension to be loaded so it can auto-detect its ID:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the cloned folder
4. Press Enter in the terminal — the script re-checks and finishes

After it completes, **reload ReadAloud** in `chrome://extensions` so Chrome picks up the native host registration. The popup should then say "Edge TTS connected".

> `install.sh` uses macOS-only paths and the BSD form of `sed -i`, so it will not run correctly on Linux/Windows.

## Usage

| Action | How |
|---|---|
| Read page / selection | Alt+R, right-click menu, or popup button |
| Pause / Resume | Alt+R (toggle) |
| Stop | Alt+S or popup button |
| Voice / Speed | Click extension icon |

Alt+R is context-aware: with a selection → reads the selection; no selection → reads full page. Already reading → pauses. Paused → resumes.

## Architecture

```
 ┌─────────┐  commands/menu/popup   ┌──────────────┐  nativeMessaging   ┌───────────────┐
 │ popup.js│ ─────────────────────▶ │ background.js│ ◀────────────────▶│ native_host.py│
 └─────────┘                        │ (MV3 worker) │                    │ (edge-tts)    │
                                    └──────┬───────┘                    └───────────────┘
                                           │ tabs.sendMessage
                           ┌───────────────┼────────────────┐
                                           ▼                  ▼
                                  ┌──────────────┐   ┌──────────────┐
                                  │ content.js   │   │ offscreen.js │  audio playback +
                                  │ (isolated)   │   │ (offscreen)  │  highlight timer
                                  └──────┬───────┘   └──────────────┘
                                         │ postMessage (MAIN ↔ isolated)
                                         ▼
                                ┌─────────────────┐
                                │ weread-hook.js  │  patches CanvasRenderingContext2D.fillText
                                │ (MAIN world)    │  to capture per-character text + coordinates
                                └─────────────────┘
```

Audio is played in an **offscreen document** (`offscreen.js`) because MV3 service workers cannot play media. The worker synthesizes a chunk, sends the base64 audio to offscreen, and offscreen drives both `<audio>.play()` and a 60 ms highlight timer. On `audioEnded` the worker advances to the next chunk.

### Text Extraction

#### Strategy Chain (generic pages)

Generic pages use a priority-ordered strategy chain in `content.js` (`EXTRACTORS` array). Each strategy independently decides if it can handle the page; the first match wins.

```
semantic → og-article → common-content → body-fallback
```

| Strategy | Match condition | Min length | Target pages |
|---|---|---|---|
| `semantic` | `<article>`, `<main>`, `[role="main"]` | > 50 chars | Blogs, news sites with HTML5 semantic tags |
| `og-article` | `<meta og:type="article">` + content container (`#content`, `.article-content`, `.post-body`, `.entry-content`, `.note-container`, `.article-detail`) | > 50 chars | Douban-style, WordPress, non-semantic article pages |
| `common-content` | Common content selectors (`#article-content`, `.post-content`, etc.) | > 200 chars | Generic CMS pages |
| `body-fallback` | `document.body.innerText` | > 0 chars | Last resort |

#### Special-Site Support

Some sites have dedicated extractors that bypass the strategy chain. All except WeRead use the generic highlighter — only WeRead's text extraction path is fully custom (canvas-based).

| Site (`host`) | Method | Highlighting |
|---|---|---|
| **WeRead** (`weread.qq.com`) | Canvas `fillText` interception + per-character coordinate overlay. Injects `weread-hook.js` into the MAIN world to intercept `CanvasRenderingContext2D.fillText`, capturing each char's text, x/y, font size, and fill color. Reads **one section at a time** (see below). | Custom canvas overlay positioned by per-char x/y |
| **QQ Reading** (`book.qq.com`) | `#article` | Generic (DOM word-wrapping) |
| **Tianya** (`tianya.net`) | `h1.post-title` + `.post-rich-text-body` | Generic |
| **Douban** (`www.douban.com`) | `.note-header h1` + `#link-report .note` | Generic |

Each special extractor falls back to the strategy chain if its selector yields nothing. To support a new page type: add a strategy function to `EXTRACTORS`, or for canvas-rendered sites, inject a MAIN-world script following the `weread-hook.js` pattern.

### Single-Section Reading (WeRead)

WeRead renders text onto canvases in page-reader mode, keeping only 2 canvases in the DOM at a time. For sections far into a chapter the canvases may hold stale text from earlier pages — the extension detects this and falls back to WeRead's DOM text layer.

**Canvas path** (sections with visible canvas chars): `sliceToSection` in `content.js` slices the buffer to one section at a time and stops.

- A **section title** is detected by two signals: a font size larger than the body text (mode across all captured chars), AND a fill color that differs from the body color. No percentage multiplier — just `fs > bodyFs && col != bodyCol`.
- **start** = search forward (≤3 lines) then backward from the visible line to the nearest title.
- **end** = the next title run, or end of buffer.
- Canvas chars feed the per-character overlay highlighter.

**DOM fallback** (sections where no canvas char has screenY ≥ 0): extracts text from `.readerChapterContent`'s absolutely-positioned `<span data-wr-role=text>` elements (vertical layout), sorted by Y then X. Reads from the first visible span onward with a simple chapter-level highlight. No section boundaries on the DOM path — the user stops manually via Alt+S.

### Language Detection & Voices

Voice selection is automatic based on the detected script of the text. `detectLang` distinguishes **Chinese** (Han ideographs, no kana/hangul), **Japanese** (kana present), **Korean** (Hangul), and **other** (non-CJK). If the user's selected voice's language family matches the detected language, it's kept; otherwise the system auto-switches to a default voice for that language (`pickVoice` in `background.js` — e.g. Japanese text gets `ja-JP-NanamiNeural`, not the Chinese voice). This happens at read start time and is stored in session state, so it survives MV3 service worker restarts. The popup also warns and blocks manually selecting a voice whose language family mismatches the current text.

- CJK text uses smaller chunks (300 chars vs 1000 for non-CJK) to stay under Chrome's 1 MB native-messaging response limit
- Sentence splitting supports ASCII (`.!?`), newline (`\n`), and CJK (`。！？；`) punctuation
- Oversized single sentences are hard-split on code-point boundaries so UTF-16 surrogate pairs (e.g. emoji) are never broken

### Pause / Resume Behavior

Resume prefers **seek-to-position**: if the offscreen document survived and still holds the paused `<audio>`, it is simply un-paused and the highlight re-syncs to `currentTime`, so playback continues exactly where it stopped with nothing re-heard. If the offscreen (and its audio) was torn down along with an idle service worker — which MV3 does after ~30 s — there is no paused audio to resume, so it falls back to re-synthesizing the current chunk from its start. In that fallback you re-hear the portion of the current chunk that already played before the pause; audio and highlighting stay aligned with each other either way.

### Reliability

- **Service-worker restart recovery** — `readingState` (tab, chunk index, voice, paused flag) is persisted to `chrome.storage.session` and rebuilt on worker startup, so a killed worker resumes the correct chunk on the next `audioEnded`.
- **Pre-generation** — the next chunk is synthesized concurrently during playback (`pregenerateNextChunk`) and cached, so playback is gapless. The cache is invalidated on voice/rate change.
- **Native-host keepalive** — a 2-minute `chrome.alarms` ping keeps stdin fed during active reading; the host self-exits after 1 h idle.
- **Consecutive-error handling** — a chunk that fails to synthesize/play is skipped after bumping an error counter; 3 consecutive errors stop reading instead of hanging.
- **Empty-audio chunks** — punctuation/whitespace-only chunks (which Edge TTS returns as `""` and would never fire `onended`) are detected and skipped without stalling the loop.

### Debugging

Open DevTools Console and look for `[ReadAloud]` prefixed logs. These cover: which extraction strategy matched and an extracted-text preview (content script), text-cleaning preview, chunk index/length and synthesis results, the WeRead `section cut` line (body font size + slice boundaries — useful for tuning title detection), and pause/resume (background). Note: the *chosen voice* is currently not logged — if you need to confirm voice auto-switching, inspect `readingState.voice` via the extension's session storage.

## License

This project is licensed under the [MIT License](LICENSE).

### Third-Party Components

| Component | License |
|---|---|
| [edge-tts](https://github.com/rany2/edge-tts) | [LGPL-3.0](https://github.com/rany2/edge-tts/blob/master/LICENSE) |

`edge-tts` is installed and runs as a standalone process via native messaging — it is not linked or bundled with this extension.

### Disclaimer

The TTS voices and speech synthesis service are provided by third parties. This project does not host, distribute, or guarantee the availability of any voice models or cloud services.
