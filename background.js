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
let pregenId = 0; // bumped to invalidate in-flight pre-generations
let consecutiveErrors = 0;

chrome.storage.local.get(["voice", "rate"], (stored) => {
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
  }).catch((err) => {
    nativeAvailable = null;
    if (retries > 0) {
      console.warn("[ReadAloud] Native retry (" + retries + " left):", err.message);
      return new Promise((r) => setTimeout(r, 500)).then(() => sendNative(msg, retries - 1));
    }
    throw err;
  });
}

async function checkNative() {
  if (nativeAvailable !== null) return nativeAvailable;
  if (nativeCheckPromise) return nativeCheckPromise;
  nativeCheckPromise = (async () => {
    try {
      await sendNative({ action: "ping" });
      nativeAvailable = true;
    } catch {
      nativeAvailable = false;
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
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Playing TTS audio",
    });
  } catch (_) {}
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
      sendResponse(settings);
      break;

    case "updateSettings":
      settings = { ...settings, ...msg.settings };
      chrome.storage.local.set(settings);
      // If reading, apply voice/rate change to next chunk immediately
      if (readingState && (msg.settings.voice || msg.settings.rate !== undefined)) {
        if (msg.settings.voice) {
          const newVoice = pickVoice(readingState.chunks[0], msg.settings.voice);
          readingState.voice = newVoice;
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
        if (!activeSynthesis) await recoverReadingState();
        const ok = await checkNative().catch(() => false);
        sendResponse({ available: ok, active: !!(activeSynthesis || readingState), paused });
      })();
      return true;

    case "getStatus":
      (async () => {
        if (!activeSynthesis) await recoverReadingState();
        sendResponse({ active: !!(activeSynthesis || readingState), paused });
      })();
      return true;

    case "getActualVoice":
      sendResponse({ voice: (readingState?.voice) || settings.voice });
      break;

    case "getReadingLanguage":
      if (!readingState || !readingState.chunks.length) {
        sendResponse({ lang: "none" });
      } else {
        const text = readingState.chunks[readingState.currentIndex] || "";
        sendResponse({ lang: isCJK(text) ? "cjk" : "other" });
      }
      break;

    case "checkVoiceCompatible": {
      const voice = msg.voice || "";
      const voiceLang = voice.substring(0, 5).toLowerCase();
      const cjkLangs = ["zh-cn", "zh-tw", "zh-hk", "ja-jp", "ko-kr"];
      const isCJKVoice = cjkLangs.includes(voiceLang);

      let textLang = "none";
      if (readingState && readingState.chunks.length) {
        const text = readingState.chunks[readingState.currentIndex] || "";
        textLang = isCJK(text) ? "cjk" : "other";
      }

      const compatible = textLang === "none" || (textLang === "cjk" && isCJKVoice) || (textLang === "other" && !isCJKVoice);
      sendResponse({ compatible, textLang });
      break;
    }
  }
});

// ---- Pause / Resume ----

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
  // Always recreate offscreen + re-synthesize current chunk.
  // The offscreen may have been killed along with the service worker,
  // and we can't reliably detect whether its audio is still alive.
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

// Detect if text is primarily CJK (produces larger audio per character)
function isCJK(text) {
  const sample = text.substring(0, 200);
  const cjk = (sample.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk > sample.length * 0.3;
}

// Pick the right voice for the text language.
// If user's selected voice language matches the text, use it; otherwise auto-switch.
function pickVoice(text, userVoice) {
  const cjk = isCJK(text);
  const voiceLang = userVoice.substring(0, 5).toLowerCase();
  const cjkLangs = ["zh-cn", "zh-tw", "zh-hk", "ja-jp", "ko-kr"];
  if (cjk && cjkLangs.includes(voiceLang)) return userVoice;
  if (!cjk && !cjkLangs.includes(voiceLang)) return userVoice;
  if (cjk) return "zh-CN-XiaoxiaoNeural";
  return "en-US-JennyNeural";
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
  try {
    const host = new URL(tab?.url || "").hostname;
    isWeRead = host === "weread.qq.com" || host.endsWith(".weread.qq.com");
  } catch (_) { /* invalid URL */ }

  const useNative = await checkNative();

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

  readingState = { tabId, chunks, currentIndex: 0, cancelled: false, useNative, voice, isWeRead };
  activeSynthesis = { cancel() { if (readingState) readingState.cancelled = true; } };

  await chrome.storage.session.set({ readingState });

  await sendToTab(tabId, { action: "start", totalChunks: chunks.length });
  await ensureOffscreen();

  if (useNative) {
    console.log("[ReadAloud] startReading: calling synthesizeAndPlayChunk, currentIndex=" + readingState.currentIndex);
    await synthesizeAndPlayChunk();
  } else {
    console.log("[ReadAloud] startReading: native not available, finishReading");
    await finishReading();
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

  const { tabId, currentIndex, voice } = readingState;
  console.log("[ReadAloud] synthesize: currentIndex=" + currentIndex + "/" + readingState.chunks.length);
  if (currentIndex >= readingState.chunks.length) {
    console.log("[ReadAloud] synthesize: reached end of chunks, finishReading");
    await finishReading(); return;
  }

  const rate = rateToStr(settings.rate);

  try {
    let resp;
    if (nextChunkCache && nextChunkCache.index === currentIndex &&
        nextChunkCache.voice === voice && nextChunkCache.rate === rate) {
      console.log("[ReadAloud] synthesize: using cache for chunk " + currentIndex);
      resp = nextChunkCache;
      nextChunkCache = null;
    } else {
      nextChunkCache = null;
      console.log("[ReadAloud] synthesize: sending to native, chunk " + currentIndex + " len=" + readingState.chunks[currentIndex].length);
      resp = await sendNative({
        action: "synthesize",
        text: readingState.chunks[currentIndex],
        voice: voice,
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

    console.log("[ReadAloud] synthesize: sending highlight + playAudio for chunk " + currentIndex);
    await sendToTab(tabId, {
      action: "highlight",
      text: readingState.chunks[currentIndex],
      boundaries: resp.boundaries || [],
    });

    await sendOffscreen({ action: "playAudio", audioBase64: resp.audio, boundaries: resp.boundaries || [] });

    consecutiveErrors = 0;
    pregenerateNextChunk(currentIndex + 1, voice, rate);

  } catch (err) {
    consecutiveErrors++;
    console.warn("[ReadAloud] synthesize: chunk " + currentIndex + " failed (" + consecutiveErrors + " consecutive):", err.message);
    if (consecutiveErrors >= 3) {
      console.error("[ReadAloud] synthesize: too many consecutive errors, finishReading");
      await finishReading();
      return;
    }
    if (readingState) {
      readingState.currentIndex++;
      await chrome.storage.session.set({ readingState });
      await synthesizeAndPlayChunk();
    }
  }
}

// Pre-generate the next chunk in the background so playback is gapless.
function pregenerateNextChunk(nextIndex, voice, rate) {
  if (!readingState || readingState.cancelled) return;
  if (nextIndex >= readingState.chunks.length) return;

  const myId = ++pregenId;
  sendNative({
    action: "synthesize",
    text: readingState.chunks[nextIndex],
    voice: voice,
    rate: rate,
  }).then((resp) => {
    // Discard if a newer pre-generation was started (voice/rate change)
    if (myId !== pregenId) return;
    // Only cache if still relevant (user hasn't stopped or moved past)
    if (readingState && !readingState.cancelled &&
        readingState.currentIndex === nextIndex - 1) {
      nextChunkCache = {
        index: nextIndex,
        audio: resp.audio,
        boundaries: resp.boundaries || [],
        voice,
        rate,
      };
    }
  }).catch((err) => {
    // Pre-generation failure is non-critical; will synthesize on demand instead
    console.warn("[ReadAloud] Pre-generate chunk", nextIndex + 1, "failed:", err.message);
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
  activeSynthesis = null;
  currentTabId = null;
  paused = false;
  await chrome.storage.session.remove("readingState").catch(() => {});
  if (tabId) await sendToTab(tabId, { action: "done" }).catch(() => {});
}

async function stopReading(tabId) {
  console.log("[ReadAloud] stopReading: called, tabId=" + tabId + " oldTabId=" + currentTabId);
  // Clear highlights on the OLD tab (currentTabId), not the new one
  const oldTabId = currentTabId;
  if (readingState) readingState.cancelled = true;
  nextChunkCache = null;
  if (activeSynthesis) { activeSynthesis.cancel(); activeSynthesis = null; }
  paused = false;
  currentTabId = null;
  readingState = null;
  audioEndedBusy = false;
  await chrome.storage.session.remove("readingState").catch(() => {});
  sendOffscreen({ action: "stopAudio" });
  if (oldTabId) sendToTab(oldTabId, { action: "stop" }).catch(() => {});
}

// ---- Utilities ----

function splitText(text, maxLen) {
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
    // If a single sentence still exceeds maxLen, hard-split it
    if (s.length > maxLen) {
      for (let i = 0; i < s.length; i += maxLen) {
        chunks.push(s.substring(i, i + maxLen).trim());
      }
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}
