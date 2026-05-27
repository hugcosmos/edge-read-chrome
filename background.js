// ============================================================
// ReadAloud - Background Service Worker
// Native Messaging for Edge TTS + Offscreen for audio playback
// ============================================================

const NATIVE_HOST = "com.readaloud.tts";
const DEFAULT_SETTINGS = { voice: "en-US-JennyNeural", rate: 1.0 };

let settings = { ...DEFAULT_SETTINGS };
let activeSynthesis = null;
let nativeCheckPromise = null;
let nativeAvailable = null;
let paused = false;
let currentTabId = null;

chrome.storage.local.get(["voice", "rate"], (stored) => {
  if (stored.voice) settings.voice = stored.voice;
  if (stored.rate !== undefined) settings.rate = stored.rate;
});

// ---- Native Messaging ----

function sendNative(msg, retries = 2) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (resp && resp.error) {
        reject(new Error("Native host error: " + resp.error));
      } else {
        resolve(resp);
      }
    });
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

function waitForAudioEnd() {
  return new Promise((resolve) => {
    const listener = (msg) => {
      if (msg.action === "audioEnded") {
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
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

// ---- Messages from popup ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
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
      sendResponse({ ok: true });
      break;

    case "getVoices": {
      checkNative()
        .then((ok) => {
          if (ok) sendNative({ action: "getVoices" }).then((r) => sendResponse(r || { voices: [] })).catch(() => sendResponse({ voices: [] }));
          else sendResponse({ voices: [], nativeAvailable: false });
        })
        .catch(() => sendResponse({ voices: [], nativeAvailable: false }));
      return true;
    }

    case "getNativeStatus":
      checkNative().then((ok) => sendResponse({ available: ok })).catch(() => sendResponse({ available: false }));
      return true;

    case "getStatus":
      sendResponse({ active: !!activeSynthesis, paused });
      break;
  }
});

// ---- Pause / Resume ----

function doPause() {
  if (!activeSynthesis || paused) return;
  paused = true;
  sendOffscreen({ action: "pauseAudio" });
  if (currentTabId) sendToTab(currentTabId, { action: "pauseHighlight" });
}

function doResume() {
  if (!activeSynthesis || !paused) return;
  paused = false;
  sendOffscreen({ action: "resumeAudio" });
  if (currentTabId) sendToTab(currentTabId, { action: "resumeHighlight" });
}

// ---- Core: Start / Stop Reading ----

async function startReading(tabId, text) {
  stopReading(tabId);
  currentTabId = tabId;
  paused = false;

  const useNative = await checkNative();
  const chunks = splitText(text, 1000);
  let cancelled = false;
  activeSynthesis = { cancel: () => { cancelled = true; } };

  await sendToTab(tabId, { action: "start", totalChunks: chunks.length });
  await ensureOffscreen();

  if (useNative) {
    for (let i = 0; i < chunks.length; i++) {
      if (cancelled) break;
      try {
        const resp = await sendNative({
          action: "synthesize",
          text: chunks[i],
          voice: settings.voice,
          rate: rateToStr(settings.rate),
        });
        if (cancelled) break;

        // Set up word spans (no timer yet)
        await sendToTab(tabId, {
          action: "highlight",
          text: chunks[i],
          boundaries: resp.boundaries || [],
        });

        // Play audio
        await sendOffscreen({ action: "playAudio", audioBase64: resp.audio });

        // Audio is playing — start the highlight timer NOW
        await sendToTab(tabId, { action: "startHighlight" });

        if (!cancelled) await waitForAudioEnd();
      } catch (err) {
        console.error("[ReadAloud]", err);
        break;
      }
    }
  }

  if (!cancelled) await sendToTab(tabId, { action: "done" }).catch(() => {});
  activeSynthesis = null;
  currentTabId = null;
}

function stopReading(tabId) {
  if (activeSynthesis) { activeSynthesis.cancel(); activeSynthesis = null; }
  paused = false;
  currentTabId = null;
  sendOffscreen({ action: "stopAudio" });
  if (tabId) sendToTab(tabId, { action: "stop" }).catch(() => {});
}

// ---- Utilities ----

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > maxLen && cur.length > 0) { chunks.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}
