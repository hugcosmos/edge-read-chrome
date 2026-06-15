// ReadAloud - Offscreen Document
// Plays audio and drives word-level highlighting via audio.currentTime

let currentAudio = null;
let currentUrl = null;
let boundaries = [];
let highlightTimer = null;
let lastIdx = -1;

// Keep service worker alive while offscreen exists (MV3 kills idle workers after ~30s)
setInterval(() => {
  try { chrome.runtime.sendMessage({ action: "keepalive" }).catch(() => {}); } catch (_) {}
}, 25000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "playAudio") {
    stopHighlightTimer();
    boundaries = msg.boundaries || [];

    const bytes = Uint8Array.from(atob(msg.audioBase64), c => c.charCodeAt(0));
    const blob = new Blob([bytes.buffer], { type: "audio/mpeg" });

    if (currentAudio) {
      currentAudio.pause();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    }

    currentUrl = URL.createObjectURL(blob);
    currentAudio = new Audio(currentUrl);
    currentAudio.volume = 1.0;

    currentAudio.onended = () => {
      console.log("[ReadAloud] offscreen: audio onended, sending audioEnded");
      stopHighlightTimer();
      cleanup();
      chrome.runtime.sendMessage({ action: "audioEnded" });
    };

    currentAudio.onerror = () => {
      console.log("[ReadAloud] offscreen: audio onerror, sending audioEnded");
      stopHighlightTimer();
      cleanup();
      chrome.runtime.sendMessage({ action: "audioEnded" });
    };

    currentAudio.play().then(() => {
      console.log("[ReadAloud] offscreen: play() resolved ok, audio duration=" + currentAudio.duration);
      sendResponse({ ok: true });
      startHighlightTimer();
    }).catch((e) => {
      console.log("[ReadAloud] offscreen: play() rejected: " + e.message);
      cleanup();
      sendResponse({ error: e.message });
    });

    return true;
  }

  if (msg.action === "pauseAudio") {
    stopHighlightTimer();
    if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "resumeAudio") {
    if (currentAudio && currentAudio.paused) {
      currentAudio.play().then(() => {
        startHighlightTimer();
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "stopAudio") {
    stopHighlightTimer();
    cleanup();
    sendResponse({ ok: true });
    return false;
  }
});

// ---- Highlight Timer (driven by audio.currentTime) ----

function startHighlightTimer() {
  stopHighlightTimer();
  lastIdx = -1;
  highlightTimer = setInterval(() => {
    if (!currentAudio || !boundaries.length) return;

    const ticks = currentAudio.currentTime * 10000000; // seconds → 100ns ticks

    let currentIdx = -1;
    for (let i = 0; i < boundaries.length; i++) {
      const off = boundaries[i].offset;
      const dur = boundaries[i].duration;
      if (ticks >= off && ticks < off + dur) {
        currentIdx = i;
        break;
      }
    }

    if (currentIdx !== lastIdx) {
      lastIdx = currentIdx;
      // Send even when currentIdx === -1 (gap between word boundaries): the
      // content script clears the active highlight, so it doesn't stay stuck
      // on the previous word during the silent gap.
      chrome.runtime.sendMessage({
        action: "highlightWord",
        index: currentIdx,
      });
    }
  }, 60);
}

function stopHighlightTimer() {
  if (highlightTimer) {
    clearInterval(highlightTimer);
    highlightTimer = null;
  }
  lastIdx = -1;
}

function cleanup() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  boundaries = [];
}
