// ReadAloud - Offscreen Document
// Plays audio and drives word-level highlighting via audio.currentTime

let currentAudio = null;
let currentUrl = null;
let boundaries = [];
let highlightTimer = null;
let lastIdx = -1;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "playAudio") {
    stopHighlightTimer();
    boundaries = msg.boundaries || [];

    const bin = atob(msg.audioBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes.buffer], { type: "audio/mpeg" });

    if (currentAudio) {
      currentAudio.pause();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    }

    currentUrl = URL.createObjectURL(blob);
    currentAudio = new Audio(currentUrl);
    currentAudio.volume = 1.0;

    currentAudio.onended = () => {
      stopHighlightTimer();
      cleanup();
      chrome.runtime.sendMessage({ action: "audioEnded" });
    };

    currentAudio.onerror = () => {
      stopHighlightTimer();
      cleanup();
      chrome.runtime.sendMessage({ action: "audioEnded" });
    };

    currentAudio.play().then(() => {
      sendResponse({ ok: true });
      startHighlightTimer();
    }).catch((e) => {
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

    if (currentIdx !== lastIdx && currentIdx >= 0) {
      lastIdx = currentIdx;
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
