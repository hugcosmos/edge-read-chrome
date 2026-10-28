// ============================================================
// ReadAloud - Background Service Worker
// Native Messaging for Edge TTS + Offscreen for audio playback
// Event-driven chunk playback (survives MV3 service worker restarts)
// ============================================================

const NATIVE_HOST = "com.readaloud.tts";
const DEFAULT_SETTINGS = { voice: "en-US-JennyNeural", rate: 1.0 };

let settings = { ...DEFAULT_SETTINGS };
let activeSynthesis = null;
let nativeCheckPromise = null;
let nativeAvailable = null;
let paused = false;
let currentTabId = null;

// Reading state — persisted to chrome.storage.session so it survives
// service-worker termination between audio chunks.
let readingState = null;
// Shape: { tabId, chunks[], currentIndex, cancelled, useNative }
let nextChunkCache = null; // { index, audio, boundaries, voice, rate }
let pregenPromise = null;
let pregenIndex = -1;
let pregenVoice = null;
let pregenRate = null;
let pregenId = 0; // bumped to invalidate in-flight pre-generations
let consecutiveErrors = 0;

// settingsReady resolves once stored settings are loaded. Without this guard,
// an early message (e.g. getSettings arriving right after a service-worker
// restart) could read the module-load defaults instead of the stored voice/rate.
const settingsReady = chrome.storage.local.get(["voice", "rate"]).then((stored) => {
  if (stored.voice) settings.voice = stored.voice;
  if (stored.rate !== undefined) settings.rate = stored.rate;
});

// Keep the native host's stdin fed while a reading session is active so it
// does not hit its idle timeout (and os._exit) during long playback. Alarms
// survive MV3 service-worker restarts, unlike setInterval in the offscreen.
chrome.alarms.get("native-keepalive", (a) => {
  if (!a) chrome.alarms.create("native-keepalive", { periodInMinutes: 2 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "native-keepalive") return;
  // Only ping while actively reading and not paused; a paused session
  // intentionally lets the host idle (resume will re-establish it).
  if (readingState && !readingState.cancelled && !paused) {
    sendNative({ action: "ping" }).catch(() => {});
  }
});

// Recover reading state after an unexpected service-worker restart.
// Guard: skip if handleAudioEnded or startReading already set readingState.
chrome.storage.session.get("readingState", (data) => {
  if (readingState) return;
  if (!data.readingState || data.readingState.cancelled) {
    if (data.readingState) chrome.storage.session.remove("readingState");
    return;
  }
  readingState = data.readingState;
  currentTabId = readingState.tabId;
  // Restore paused flag from persisted state. Without this, paused stays at
  // its module-load default (false) after a SW restart, so doResume() bails
  // out on its guard and playback never resumes — while the popup still
  // reports "reading".
  paused = !!readingState.paused;
  activeSynthesis = { cancel() { if (readingState) readingState.cancelled = true; } };
});

// ---- Native Messaging ----

function sendNative(msg, retries = 2) {
  console.log("[ReadAloud] sendNative:", msg.action, "retries=" + retries);
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (resp) => {
        const err = chrome.runtime.lastError;
        console.log("[ReadAloud] sendNative response:", err ? "ERROR: " + err.message : "ok", resp ? ("keys=" + Object.keys(resp).join(",")) : "null");
        if (err) {
          reject(new Error(err.message));
        } else if (resp && resp.error) {
          reject(new Error("Native host error: " + resp.error));
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      console.error("[ReadAloud] sendNative exception:", e);
      reject(e);
    }
  }).then((resp) => {
    // Successful round-trip → host is reachable. This also recovers
    // checkNative's permanently-cached false if the host came up later.
    nativeAvailable = true;
    return resp;
  }).catch((err) => {
    nativeAvailable = null;
    if (err.message && err.message.includes("cancelled")) {
      throw err;
    }
    if (retries > 0) {
      console.warn("[ReadAloud] Native retry (" + retries + " left):", err.message);
      return new Promise((r) => setTimeout(r, 500)).then(() => sendNative(msg, retries - 1));
    }
    throw err;
  });
}

async function checkNative() {
  // A confirmed-true result is cached permanently (the host doesn't go away).
  // A confirmed-FALSE result is NOT cached: the failure is often transient —
  // e.g. the onInstalled ping fires before install.sh has registered the host,
  // or the host came up between the ping and now. Caching false would make
  // startReading silently finishReading() forever, forcing an extension reload.
  // Returning null leaves the cache "unknown" so the next caller re-probes.
  if (nativeAvailable === true) return true;
  if (nativeCheckPromise) return nativeCheckPromise;
  nativeCheckPromise = (async () => {
    try {
      await sendNative({ action: "ping" });
      nativeAvailable = true;
    } catch {
      // Leave nativeAvailable at null (unknown), not false, so it re-probes.
      nativeAvailable = null;
    }
    nativeCheckPromise = null;
    return nativeAvailable;
  })();
  return nativeCheckPromise;
}

function rateToStr(m) {
  const p = Math.round((m - 1) * 100);
  return p >= 0 ? `+${p}%` : `${p}%`;
}

// ---- Offscreen Audio ----

async function ensureOffscreen() {
  // Avoid a redundant createDocument() (which rejects "Only a single object...")
  // by checking for an existing document first.
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Playing TTS audio",
    });
  } catch (_) {}
}

async function closeOffscreen() {
  // Release the offscreen document when idle so its keepalive interval stops
  // pinning the service worker (and via it, the native host) awake forever.
  await chrome.offscreen.closeDocument().catch(() => {});
}

function sendOffscreen(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { /* receiver not ready */ }
        resolve(resp || {});
      });
    } catch (_) {
      resolve({});
    }
  });
}

// ---- Content Script ----

async function sendToTab(tabId, message) {
  try {
    return await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(resp);
      });
    });
  } catch (_) {
    try {
      // content.js guards against double-init with window.__readaloudLoaded.
      // If the first load failed mid-way (or a prior navigation left the flag
      // set), re-injecting content.js would hit the guard and re-register
      // nothing — leaving us with no listener again. Clear the flag in the
      // isolated world (content.js's default world) first so the re-injected
      // file actually runs its body.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { window.__readaloudLoaded = false; } catch (e) {} },
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(resp);
        });
      });
    } catch (e) {
      return null;
    }
  }
}

// ---- Context Menu ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "read-selection", title: "Read Aloud (selection)", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "read-page", title: "Read Aloud (page)", contexts: ["page"] });
  checkNative();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === "read-selection" && info.selectionText) {
    startReading(tab.id, info.selectionText);
  } else if (info.menuItemId === "read-page") {
    sendToTab(tab.id, { action: "getPageText" }).then((r) => {
      if (r?.text) startReading(tab.id, r.text);
    });
  }
});

// ---- Auto-stop when reading tab navigates away ----

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.url) {
    stopReading(null);
  }
});

// ---- Keyboard Shortcuts ----

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    if (command === "read-aloud") {
      (async () => {
        // Recover state if service worker was killed while paused
        if (!activeSynthesis) await recoverReadingState();
        if (activeSynthesis && !paused) {
          doPause();
        } else if (activeSynthesis && paused) {
          doResume();
        } else {
          // Not reading → start
          try {
            const sel = await sendToTab(tab.id, { action: "getSelectedText" });
            if (sel && sel.text) {
              startReading(tab.id, sel.text);
              return;
            }
          } catch (_) {}
          try {
            const page = await sendToTab(tab.id, { action: "getPageText" });
            if (page && page.text) {
              startReading(tab.id, page.text);
            }
          } catch (_) {}
        }
      })();
    } else if (command === "stop-reading") {
      stopReading(tab.id);
    }
  });
});

// ---- Messages from popup / offscreen ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    // Offscreen reports audio finished → drive the next chunk
    case "audioEnded":
      handleAudioEnded();
      return false;

    // Offscreen drives highlight timing via audio.currentTime
    case "highlightWord":
      if (currentTabId) sendToTab(currentTabId, msg).catch(() => {});
      return false;

    // Offscreen keepalive — receiving this keeps service worker alive
    case "keepalive":
      return false;

    // Content script reports an SPA route change (history.pushState) that
    // tabs.onUpdated wouldn't fire with changeInfo.url. Stop reading on the
    // current tab so audio doesn't desync from the new page content.
    case "urlChanged":
      if (sender.tab && sender.tab.id === currentTabId) stopReading(null);
      return false;

    case "readPage":
    case "readSelection":
    case "stop":
    case "pause":
    case "resume": {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) return sendResponse({ error: "No active tab" });
        if (msg.action === "stop") { stopReading(tab.id); return sendResponse({ ok: true }); }
        if (msg.action === "pause") { doPause(); return sendResponse({ ok: true }); }
        if (msg.action === "resume") {
          doResume().then(() => sendResponse({ ok: true }))
                    .catch((e) => sendResponse({ error: e.message }));
          return;
        }
        const act = msg.action === "readPage" ? "getPageText" : "getSelectedText";
        sendToTab(tab.id, { action: act })
          .then((r) => {
            console.log("[ReadAloud] readPage: getPageText returned textLen=" + (r?.text?.length || 0));
            if (r?.text) { startReading(tab.id, r.text); sendResponse({ ok: true }); }
            else sendResponse({ error: "No text found" });
          })
          .catch((e) => sendResponse({ error: e.message }));
      });
      return true;
    }

    case "getSettings":
      settingsReady.then(() => sendResponse(settings));
      return true;

    case "updateSettings":
      settings = { ...settings, ...msg.settings };
      chrome.storage.local.set(settings);
      // If reading, apply voice/rate change to next chunk immediately
      if (readingState && (msg.settings.voice || msg.settings.rate !== undefined)) {
        // Honor the user's explicit voice choice — do NOT re-run pickVoice
        // here. pickVoice already auto-matched language once at startReading;
        // overriding now would silently revert a manual switch (e.g. user
        // picks an English voice while reading Chinese text).
        if (msg.settings.voice) {
          readingState.voice = msg.settings.voice;
        }
        nextChunkCache = null;
        pregenId++; // invalidate any in-flight pre-generation
        chrome.storage.session.set({ readingState });
      }
      sendResponse({ ok: true });
      break;

    case "getVoices": {
      // Cache-first: return cached voices immediately, refresh in background if expired
      chrome.storage.local.get(["voices", "voicesTs"], (data) => {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        const cached = data.voices;
        const cacheValid = cached && cached.length && (now - (data.voicesTs || 0)) < maxAge;

        if (cacheValid) {
          sendResponse({ voices: cached });
          return;
        }

        // No valid cache — fetch from native host
        checkNative()
          .then((ok) => {
            if (ok) {
              sendNative({ action: "getVoices" }).then((r) => {
                const voices = r?.voices || [];
                if (voices.length) {
                  chrome.storage.local.set({ voices, voicesTs: Date.now() });
                }
                sendResponse({ voices });
              }).catch(() => sendResponse({ voices: cached || [] }));
            } else {
              sendResponse({ voices: cached || [], nativeAvailable: false });
            }
          })
          .catch(() => sendResponse({ voices: cached || [], nativeAvailable: false }));
      });
      return true;
    }

    case "getNativeStatus":
      (async () => {
        // Read-only: peek persisted state without creating a dummy
        // activeSynthesis (status queries must not mutate playback state).
        const peek = activeSynthesis ? null : await peekReadingState();
        const ok = await checkNative().catch(() => false);
        const active = activeSynthesis || (peek && peek.active);
        sendResponse({ available: ok, active: !!active, paused: peek ? peek.paused : paused });
      })();
      return true;

    case "getStatus":
      (async () => {
        const peek = activeSynthesis ? null : await peekReadingState();
        const active = activeSynthesis || (peek && peek.active);
        sendResponse({ active: !!active, paused: peek ? peek.paused : paused });
      })();
      return true;

    case "getActualVoice":
      settingsReady.then(() => sendResponse({ voice: (readingState?.voice) || settings.voice }));
      return true;

    case "getReadingLanguage":
      if (!readingState || !readingState.chunks.length) {
        sendResponse({ lang: "none" });
      } else {
        const text = readingState.chunks[readingState.currentIndex] || "";
        sendResponse({ lang: detectLang(text) });
      }
      break;

    case "checkVoiceCompatible": {
      const voice = msg.voice || "";
      const voiceFam = voice.substring(0, 2).toLowerCase();

      let textLang = "none";
      if (readingState && readingState.chunks.length) {
        const text = readingState.chunks[readingState.currentIndex] || "";
        textLang = detectLang(text);
      }

      // Compatible when the voice's language family matches the detected
      // text language. "other" (non-CJK) accepts any non-CJK family (en/fr/
      // de/es/...); a CJK lang requires its own family (ja voice on ja text).
      let compatible;
      if (textLang === "none") {
        compatible = true;
      } else if (textLang === "other") {
        const cjkFamilies = ["zh", "ja", "ko"];
        compatible = !cjkFamilies.includes(voiceFam);
      } else {
        compatible = voiceFam === textLang;
      }
      sendResponse({ compatible, textLang });
      break;
    }
  }
});

// ---- Pause / Resume ----

// Read-only peek at persisted reading state for status queries. Loads
// readingState + paused from storage so the popup reflects truth, but does
// NOT create a dummy activeSynthesis (creating one would let a later stop()
// mark the recovered state cancelled as a side effect of a read-only query).
async function peekReadingState() {
  if (!readingState) {
    const data = await chrome.storage.session.get("readingState");
    readingState = data.readingState || null;
  }
  return { active: !!(readingState && !readingState.cancelled), paused: !!(readingState && readingState.paused) };
}

// Recover in-memory state after service worker restart.
// Returns true if a paused reading session was recovered.
async function recoverReadingState() {
  if (!readingState) {
    const data = await chrome.storage.session.get("readingState");
    readingState = data.readingState || null;
  }
  if (!readingState || readingState.cancelled) return false;
  currentTabId = readingState.tabId;
  activeSynthesis = { cancel() { if (readingState) readingState.cancelled = true; } };
  paused = !!readingState.paused;
  // Reload rate — voice is stored in readingState
  const stored = await chrome.storage.local.get(["rate"]);
  if (stored.rate !== undefined) settings.rate = stored.rate;
  return true;
}

function doPause() {
  if (!activeSynthesis || paused) return;
  paused = true;
  if (readingState) {
    readingState.paused = true;
    chrome.storage.session.set({ readingState });
  }
  sendOffscreen({ action: "pauseAudio" });
}

async function doResume() {
  // Recover state if service worker was killed while paused
  if (!activeSynthesis || !readingState) {
    const recovered = await recoverReadingState();
    if (!recovered || !paused) return;
  }
  // Sync paused from the persisted source of truth. The top-level restart
  // recovery sets a dummy activeSynthesis but previously left paused at its
  // default (false); guard against that stale state here.
  if (readingState) paused = !!readingState.paused;
  if (!paused) return;
  paused = false;
  if (readingState) {
    readingState.paused = false;
    chrome.storage.session.set({ readingState });
  }

  // Seek-to-position resume: if the offscreen document survived AND still
  // holds the paused Audio, just un-pause it — playback continues exactly
  // where it stopped and the highlight re-syncs to currentTime. This avoids
  // re-hearing the portion of the chunk that already played before pause.
  const resumed = await sendOffscreen({ action: "resumeAudio" });
  if (resumed && resumed.resumed) {
    console.log("[ReadAloud] doResume: resumed existing audio in place");
    return;
  }

  // Fallback: the offscreen (and its Audio) was torn down with the idle
  // service worker. Recreate offscreen + re-synthesize the current chunk
  // from its start. Less ideal (replays pre-pause audio of this chunk) but
  // robust — there's no paused Audio to resume.
  console.log("[ReadAloud] doResume: offscreen audio gone, re-synthesizing current chunk");
  await ensureOffscreen();
  await synthesizeAndPlayChunk();
}

// ---- Core: Event-Driven Reading Loop ----
//
// Old approach: for-loop with await waitForAudioEnd().
// Problem: MV3 service worker gets killed after ~30 s idle while waiting
// for audio to finish, losing all in-flight state.
//
// New approach: each chunk is triggered by the "audioEnded" message.
// State is persisted to chrome.storage.session so the worker can be
// restarted between chunks without losing progress.

// Detect the dominant script of the text. Returns one of:
//   "zh", "ja", "ko", "cjk" (ambiguous CJK, can't tell which), "other".
// Sampled over the first 200 chars so a long page is cheap to classify.
function detectLang(text) {
  const sample = text.substring(0, 200);
  if (!sample) return "other";
  // Japanese: Hiragana/Katakana are unambiguous; CJK ideographs alone are
  // ambiguous between zh/ja, so only flag ja when kana is present.
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  // Hangul is unambiguous for Korean.
  const hangul = (sample.match(/[\uac00-\ud7af]/g) || []).length;
  // Han ideographs (shared by zh/ja).
  const han = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  if (kana > 0 && kana + han > sample.length * 0.15) return "ja";
  if (hangul > sample.length * 0.15) return "ko";
  if (han > sample.length * 0.3) {
    // Han without kana/hangul → most likely Chinese.
    return "zh";
  }
  return "other";
}

// Detect if text is primarily CJK (produces larger audio per character).
// Kept for callers that only need the binary CJK/non-CJK split (chunk sizing).
function isCJK(text) {
  const lang = detectLang(text);
  return lang === "zh" || lang === "ja" || lang === "ko";
}

// Map a detected language to a sensible default voice.
const DEFAULT_VOICE_BY_LANG = {
  zh: "zh-CN-XiaoxiaoNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  other: "en-US-JennyNeural",
};

// Pick the right voice for the text language.
// If the user's selected voice matches the detected language, keep it;
// otherwise auto-switch to a default voice for that language.
function pickVoice(text, userVoice) {
  const lang = detectLang(text);
  // userVoice looks like "zh-CN-XiaoxiaoNeural"; its language family prefix
  // is the first 2 chars (e.g. "zh", "ja", "ko", "en", "fr").
  const userFam = (userVoice || "").substring(0, 2).toLowerCase();
  if (lang === "other") {
    // Non-CJK text: accept any non-CJK user voice (en/fr/de/es/...).
    const cjkFamilies = ["zh", "ja", "ko"];
    if (userFam && !cjkFamilies.includes(userFam)) return userVoice;
    return DEFAULT_VOICE_BY_LANG.other;
  }
  // CJK text: accept a user voice whose family matches the detected CJK lang.
  if (userFam === lang) return userVoice;
  return DEFAULT_VOICE_BY_LANG[lang] || DEFAULT_VOICE_BY_LANG.zh;
}

// Clean text for EdgeTTS compatibility.
// Removes problematic characters that may cause TTS issues.
// WeRead text is already clean and doesn't need preprocessing.
function cleanTextForTTS(text, isWeRead) {
  if (isWeRead) return text;
  return text
    // Remove emoji (covers common emoji ranges)
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    // Replace tabs with space
    .replace(/\t/g, ' ')
    // Remove ampersands (won't highlight but TTS will work)
    .replace(/&/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

async function startReading(tabId, text) {
  await stopReading(tabId);
  currentTabId = tabId;
  paused = false;
  consecutiveErrors = 0;

  // Detect WeRead to skip text cleaning (canvas text is already clean)
  const tab = await chrome.tabs.get(tabId);
  let isWeRead = false;
  let isChineseAll = false;
  try {
    const host = new URL(tab?.url || "").hostname;
    isWeRead = host === "weread.qq.com" || host.endsWith(".weread.qq.com");
    isChineseAll = host === "chineseall.cn" || host.endsWith(".chineseall.cn");
  } catch (_) { /* invalid URL */ }

  const useNative = await checkNative();
  // checkNative returns true (confirmed) or null (unknown — not cached).
  // Only treat a CONFIRMED-false (shouldn't happen now, but be safe) as a hard
  // stop. When unknown, fall through to synthesizeAndPlayChunk: sendNative has
  // its own retry logic and will set nativeAvailable on a real round-trip, so
  // a transient "host not ready yet" no longer kills the whole reading session.
  const nativeBlocked = (useNative === false);

  // Clean text for EdgeTTS compatibility (skip WeRead)
  const cleanedText = cleanTextForTTS(text, isWeRead);
  if (text !== cleanedText) {
    console.log("[ReadAloud] text cleaned, preview:", cleanedText.substring(0, 100));
  }

  const cjk = isCJK(cleanedText);
  // CJK text produces ~3x larger audio per char, use smaller chunks
  // to stay under Chrome's 1MB native messaging response limit
  const maxLen = cjk ? 300 : 1000;
  const chunks = splitText(cleanedText, maxLen);
  console.log("[ReadAloud] startReading: textLen=" + cleanedText.length +
    " cjk=" + cjk + " chunks=" + chunks.length + " isWeRead=" + isWeRead +
    " useNative=" + useNative);
  if (chunks.length === 0) {
    console.log("[ReadAloud] startReading: NO CHUNKS, finishReading");
    await finishReading();
    return;
  }

  // Make first chunk short so audio starts playing faster.
  // This splits the first chunk at the nearest sentence boundary.
  if (chunks[0].length > (cjk ? 80 : 200)) {
    const firstMax = cjk ? 80 : 200;
    const first = chunks[0];
    const re = /[.!?\n。！？；]/g;
    let cut = -1;
    let m;
    while ((m = re.exec(first)) !== null) {
      if (m.index >= firstMax) break;
      cut = m.index + 1;
    }
    const remainder = first.substring(cut).trim();
    if (cut > 0 && remainder && first.substring(0, cut).trim()) {
      chunks[0] = first.substring(0, cut).trim();
      chunks.splice(1, 0, remainder);
    }
  }

  const voice = pickVoice(cleanedText, settings.voice);

  readingState = { tabId, chunks, currentIndex: 0, cancelled: false, useNative: !!useNative, voice, isWeRead, isChineseAll };
  activeSynthesis = { cancel() { if (readingState) readingState.cancelled = true; } };

  await chrome.storage.session.set({ readingState });

  await sendToTab(tabId, { action: "start", totalChunks: chunks.length });
  await ensureOffscreen();

  if (nativeBlocked) {
    console.log("[ReadAloud] startReading: native host confirmed unavailable, finishReading");
    await finishReading();
  } else {
    console.log("[ReadAloud] startReading: calling synthesizeAndPlayChunk, currentIndex=" + readingState.currentIndex);
    await synthesizeAndPlayChunk();
  }
}

// Synthesize the current chunk and hand off to offscreen for playback.
// Returns immediately — audioEnded event drives the next chunk.
// Uses pre-generated cache when available to eliminate inter-chunk gaps.
async function synthesizeAndPlayChunk() {
  if (!readingState || readingState.cancelled) {
    console.log("[ReadAloud] synthesize: no readingState/cancelled, finishReading");
    await finishReading(); return;
  }

  const { tabId, voice } = readingState;
  console.log("[ReadAloud] synthesize: currentIndex=" + readingState.currentIndex + "/" + readingState.chunks.length);

  const rate = rateToStr(settings.rate);

  // Loop so that empty-audio chunks (punctuation/whitespace-only) advance
  // without recursion — a long run of silent chunks used to grow an unbounded
  // promise chain. `break` exits on any terminal path; the only re-entry is
  // the empty-audio continue.
  while (true) {
    if (!readingState || readingState.cancelled) {
      console.log("[ReadAloud] synthesize: no readingState/cancelled, finishReading");
      await finishReading(); return;
    }
    // Re-read currentIndex/voice each iteration: the empty-audio path bumps it.
    const curIndex = readingState.currentIndex;
    const curVoice = readingState.voice;

    if (curIndex >= readingState.chunks.length) {
      if (readingState.isChineseAll) {
        console.log("[ReadAloud] synthesize: end of ChineseAll page, turning page");
        const r = await sendToTab(tabId, { action: "turnAndExtract" });
        const moreText = r?.text || "";
        if (moreText) {
          const cjk = isCJK(moreText);
          const more = splitText(moreText, cjk ? 300 : 1000);
          readingState.chunks = readingState.chunks.concat(more);
          await chrome.storage.session.set({ readingState });
          console.log("[ReadAloud] synthesize: turned page, +" + more.length + " chunks, continuing");
          continue;
        }
      }
      console.log("[ReadAloud] synthesize: end of chunks, finishReading");
      await finishReading(); return;
    }

    try {
      let resp;
      if (nextChunkCache && nextChunkCache.index === curIndex &&
          nextChunkCache.voice === curVoice && nextChunkCache.rate === rate) {
        console.log("[ReadAloud] synthesize: using cache for chunk " + curIndex);
        resp = nextChunkCache;
        nextChunkCache = null;
        pregenPromise = null;
      } else if (pregenPromise && pregenIndex === curIndex &&
                 pregenVoice === curVoice && pregenRate === rate) {
        console.log("[ReadAloud] synthesize: awaiting in-flight pregen for chunk " + curIndex);
        resp = await pregenPromise;
        pregenPromise = null;
        nextChunkCache = null;
        if (!resp || resp.audio === undefined) {
          throw new Error("Pregeneration failed for chunk " + curIndex);
        }
      } else {
        nextChunkCache = null;
        pregenPromise = null;
        console.log("[ReadAloud] synthesize: sending to native, chunk " + curIndex + " len=" + readingState.chunks[curIndex].length);
        resp = await sendNative({
          action: "synthesize",
          text: readingState.chunks[curIndex],
          voice: curVoice,
          rate: rate,
        });
        console.log("[ReadAloud] synthesize: native returned, audioLen=" + (resp.audio?.length || 0) + " boundaries=" + (resp.boundaries?.length || 0));
      }

      if (!readingState || readingState.cancelled) {
        console.log("[ReadAloud] synthesize: readingState gone after native, finishReading");
        await finishReading(); return;
      }
      if (resp.audio === undefined || resp.audio === null) {
        console.log("[ReadAloud] synthesize: no audio in response, treating as error");
        throw new Error("No audio in response");
      }

      // Empty audio (Edge TTS returns "" for punctuation-only / whitespace
      // chunks): a zero-length Audio won't fire onended, which would deadlock
      // playback waiting for audioEnded that never comes. Skip playback,
      // advance, and loop to the next chunk (no recursion).
      if (resp.audio.length === 0) {
        console.log("[ReadAloud] synthesize: empty audio for chunk " + curIndex + ", skipping playback");
        readingState.currentIndex++;
        await chrome.storage.session.set({ readingState });
        continue;
      }

      console.log("[ReadAloud] synthesize: sending highlight + playAudio for chunk " + curIndex);
      await sendToTab(tabId, {
        action: "highlight",
        text: readingState.chunks[curIndex],
        boundaries: resp.boundaries || [],
      });

      // Check playAudio's response: if offscreen is dead or play() rejected,
      // audioEnded will never arrive and playback would hang silently. Throw so
      // the catch below retries via consecutiveErrors instead of stalling.
      const playResp = await sendOffscreen({ action: "playAudio", audioBase64: resp.audio, boundaries: resp.boundaries || [] });
      if (playResp.error) {
        throw new Error("playAudio: " + playResp.error);
      }

      consecutiveErrors = 0;
      pregenerateNextChunk(curIndex + 1, curVoice, rate);
      break;  // playback started; audioEnded event drives the next chunk

    } catch (err) {
      consecutiveErrors++;
      console.warn("[ReadAloud] synthesize: chunk " + curIndex + " failed (" + consecutiveErrors + " consecutive):", err.message);
      if (consecutiveErrors >= 3) {
        console.error("[ReadAloud] synthesize: too many consecutive errors, finishReading");
        await finishReading();
        return;
      }
      if (readingState) {
        readingState.currentIndex++;
        await chrome.storage.session.set({ readingState });
        continue;  // retry next chunk within the loop (no recursion)
      }
      return;
    }
  }  // end while
}

// Pre-generate the next chunk in the background so playback is gapless.
function pregenerateNextChunk(nextIndex, voice, rate) {
  if (!readingState || readingState.cancelled) return;
  if (nextIndex >= readingState.chunks.length) return;

  const myId = ++pregenId;
  pregenIndex = nextIndex;
  pregenVoice = voice;
  pregenRate = rate;

  pregenPromise = sendNative({
    action: "synthesize",
    text: readingState.chunks[nextIndex],
    voice: voice,
    rate: rate,
  }).then((resp) => {
    // Discard if a newer pre-generation was started (voice/rate change)
    if (myId !== pregenId) return null;
    // Only cache if still relevant (user hasn't stopped or moved past)
    if (readingState && !readingState.cancelled) {
      nextChunkCache = {
        index: nextIndex,
        audio: resp.audio,
        boundaries: resp.boundaries || [],
        voice,
        rate,
      };
    }
    return resp;
  }).catch((err) => {
    if (myId === pregenId) {
      console.warn("[ReadAloud] Pre-generate chunk", nextIndex, "failed:", err.message);
    }
    return null;
  });
}

// Called when offscreen reports audioEnded. Advances to next chunk.
let audioEndedBusy = false;

async function handleAudioEnded() {
  console.log("[ReadAloud] handleAudioEnded: called, busy=" + audioEndedBusy);
  if (audioEndedBusy) {
    console.log("[ReadAloud] handleAudioEnded: already busy, ignoring");
    return;
  }
  audioEndedBusy = true;
  try {
    if (!activeSynthesis) {
      console.log("[ReadAloud] handleAudioEnded: no activeSynthesis, recovering");
      await recoverReadingState();
    }

    if (!readingState || readingState.cancelled) {
      console.log("[ReadAloud] handleAudioEnded: no readingState/cancelled, finishReading");
      await finishReading(); return;
    }

    // User paused: ignore this (possibly late-arriving) ended event so the
    // pause isn't lost. Playback resumes from doResume() when the user unpauses.
    if (paused) {
      console.log("[ReadAloud] handleAudioEnded: paused, ignoring");
      return;
    }

    readingState.currentIndex++;
    console.log("[ReadAloud] handleAudioEnded: advancing to chunk " + readingState.currentIndex);
    await chrome.storage.session.set({ readingState });
    await synthesizeAndPlayChunk();
  } catch (e) {
    console.error("[ReadAloud] handleAudioEnded: error:", e.message);
  } finally {
    audioEndedBusy = false;
  }
}

async function finishReading() {
  console.log("[ReadAloud] finishReading: called, tabId=" + (readingState?.tabId || currentTabId));
  const tabId = readingState?.tabId || currentTabId;
  readingState = null;
  nextChunkCache = null;
  pregenPromise = null;
  pregenIndex = -1;
  pregenId++;
  activeSynthesis = null;
  currentTabId = null;
  paused = false;
  await chrome.storage.session.remove("readingState").catch(() => {});
  await closeOffscreen();
  if (tabId) await sendToTab(tabId, { action: "done" }).catch(() => {});
}

async function stopReading(tabId) {
  console.log("[ReadAloud] stopReading: called, tabId=" + tabId + " oldTabId=" + currentTabId);
  // Clear highlights on the OLD tab (currentTabId), not the new one
  const oldTabId = currentTabId;
  if (readingState) readingState.cancelled = true;
  nextChunkCache = null;
  pregenPromise = null;
  pregenIndex = -1;
  pregenId++;
  if (activeSynthesis) { activeSynthesis.cancel(); activeSynthesis = null; }
  paused = false;
  currentTabId = null;
  readingState = null;
  audioEndedBusy = false;
  await chrome.storage.session.remove("readingState").catch(() => {});
  sendOffscreen({ action: "stopAudio" });
  await closeOffscreen();
  if (oldTabId) sendToTab(oldTabId, { action: "stop" }).catch(() => {});
}

// ---- Utilities ----

function splitText(text, maxLen) {
  // Empty / whitespace-only input → no chunks (caller bails before any native call).
  if (!text || !text.trim()) return [];
  if (text.length <= maxLen) return [text];
  const chunks = [];
  // Split on ASCII and CJK sentence terminators
  const sentences = text.match(/[^.!?\n。！？；]+[.!?\n。！？；]+|[^.!?\n。！？；]+$/g) || [text];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > maxLen && cur.length > 0) {
      chunks.push(cur.trim());
      cur = "";
    }
    // If a single sentence still exceeds maxLen, hard-split it. Step by code
    // points so a UTF-16 surrogate pair (emoji/astral char) is never split in
    // half — a lone surrogate produces broken text for Edge TTS.
    if (s.length > maxLen) {
      let i = 0;
      while (i < s.length) {
        let end = i + maxLen;
        if (end >= s.length) {
          end = s.length;
        } else if (end > i + 1) {
          // If the cut would land on a low surrogate, back up one so the
          // pair stays whole. Guarded by end > i+1 so we never produce an
          // empty chunk when the high surrogate sits right at the boundary.
          const code = s.charCodeAt(end - 1);
          if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
        }
        const piece = s.substring(i, end).trim();
        if (piece) chunks.push(piece);
        i = end;
      }
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}
