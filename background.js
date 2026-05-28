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

chrome.storage.local.get(["voice", "rate"], (stored) => {
  if (stored.voice) settings.voice = stored.voice;
  if (stored.rate !== undefined) settings.rate = stored.rate;
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
      if (activeSynthesis && !paused) {
        // Already reading → pause
        doPause();
      } else if (activeSynthesis && paused) {
        // Paused → resume
        doResume();
      } else {
        // Not reading → start
        (async () => {
          try {
            const sel = await sendToTab(tab.id, { action: "getSelectedText" });
            if (sel && sel.text) {
              startReading(tab.id, sel.text);
              return;
            }
          } catch (_) {}
          // No selection or failed → read entire page
          try {
            const page = await sendToTab(tab.id, { action: "getPageText" });
            if (page && page.text) {
              startReading(tab.id, page.text);
            }
          } catch (_) {}
        })();
      }
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

    case "readPage":
    case "readSelection":
    case "stop":
    case "pause":
    case "resume": {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) return sendResponse({ error: "No active tab" });
        if (msg.action === "stop") { stopReading(tab.id); return sendResponse({ ok: true }); }
        if (msg.action === "pause") { doPause(); return sendResponse({ ok: true }); }
        if (msg.action === "resume") { doResume(); return sendResponse({ ok: true }); }
        const act = msg.action === "readPage" ? "getPageText" : "getSelectedText";
        sendToTab(tab.id, { action: act })
          .then((r) => {
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
      // If reading, apply voice change to next chunk immediately
      if (readingState && msg.settings.voice) {
        const newVoice = pickVoice(readingState.chunks[0], msg.settings.voice);
        readingState.voice = newVoice;
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
      checkNative().then((ok) => sendResponse({ available: ok })).catch(() => sendResponse({ available: false }));
      return true;

    case "getStatus":
      sendResponse({ active: !!(activeSynthesis || readingState), paused });
      break;
  }
});

// ---- Pause / Resume ----

function doPause() {
  if (!activeSynthesis || paused) return;
  paused = true;
  sendOffscreen({ action: "pauseAudio" });
}

function doResume() {
  if (!activeSynthesis || !paused) return;
  paused = false;
  sendOffscreen({ action: "resumeAudio" });
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

async function startReading(tabId, text) {
  await stopReading(tabId);
  currentTabId = tabId;
  paused = false;

  const useNative = await checkNative();
  const cjk = isCJK(text);
  // CJK text produces ~3x larger audio per char, use smaller chunks
  // to stay under Chrome's 1MB native messaging response limit
  const maxLen = cjk ? 300 : 1000;
  const chunks = splitText(text, maxLen);
  const voice = pickVoice(text, settings.voice);

  readingState = { tabId, chunks, currentIndex: 0, cancelled: false, useNative, voice };
  activeSynthesis = { cancel() { if (readingState) readingState.cancelled = true; } };

  await chrome.storage.session.set({ readingState });

  await sendToTab(tabId, { action: "start", totalChunks: chunks.length });
  await ensureOffscreen();

  if (useNative) {
    await synthesizeAndPlayChunk();
  } else {
    await finishReading();
  }
}

// Synthesize the current chunk and hand off to offscreen for playback.
// Returns immediately — audioEnded event drives the next chunk.
async function synthesizeAndPlayChunk() {
  if (!readingState || readingState.cancelled) { await finishReading(); return; }

  const { tabId, chunks, currentIndex, voice } = readingState;
  if (currentIndex >= chunks.length) { await finishReading(); return; }

  try {
    const resp = await sendNative({
      action: "synthesize",
      text: chunks[currentIndex],
      voice: voice,
      rate: rateToStr(settings.rate),
    });

    if (!readingState || readingState.cancelled) { await finishReading(); return; }

    await sendToTab(tabId, {
      action: "highlight",
      text: chunks[currentIndex],
      boundaries: resp.boundaries || [],
    });

    await sendOffscreen({ action: "playAudio", audioBase64: resp.audio, boundaries: resp.boundaries || [] });

  } catch (err) {
    console.warn("[ReadAloud] Chunk", currentIndex + 1, "failed, skipping:", err.message);
    if (readingState) {
      readingState.currentIndex++;
      await chrome.storage.session.set({ readingState });
      await synthesizeAndPlayChunk();
    }
  }
}

// Called when offscreen reports audioEnded. Advances to next chunk.
let audioEndedBusy = false;

async function handleAudioEnded() {
  if (audioEndedBusy) return;
  audioEndedBusy = true;
  try {
    // If service worker was restarted, recover state from session storage
    if (!readingState) {
      const data = await chrome.storage.session.get("readingState");
      readingState = data.readingState || null;
      if (readingState) {
        currentTabId = readingState.tabId;
        activeSynthesis = { cancel() { if (readingState) readingState.cancelled = true; } };
        // Reload rate only — voice is stored in readingState
        const stored = await chrome.storage.local.get(["rate"]);
        if (stored.rate !== undefined) settings.rate = stored.rate;
      }
    }

    if (!readingState || readingState.cancelled) { await finishReading(); return; }

    readingState.currentIndex++;
    await chrome.storage.session.set({ readingState });
    await synthesizeAndPlayChunk();
  } finally {
    audioEndedBusy = false;
  }
}

async function finishReading() {
  const tabId = readingState?.tabId || currentTabId;
  readingState = null;
  activeSynthesis = null;
  currentTabId = null;
  paused = false;
  await chrome.storage.session.remove("readingState").catch(() => {});
  if (tabId) await sendToTab(tabId, { action: "done" }).catch(() => {});
}

async function stopReading(tabId) {
  // Clear highlights on the OLD tab (currentTabId), not the new one
  const oldTabId = currentTabId;
  if (readingState) readingState.cancelled = true;
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
