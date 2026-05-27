// ReadAloud - Offscreen Document
// Plays audio, supports pause/resume

let currentAudio = null;
let currentUrl = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "playAudio") {
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
      cleanup();
      chrome.runtime.sendMessage({ action: "audioEnded" });
    };

    currentAudio.onerror = () => {
      cleanup();
      chrome.runtime.sendMessage({ action: "audioEnded" });
    };

    currentAudio.play().then(() => {
      sendResponse({ ok: true });
    }).catch((e) => {
      cleanup();
      sendResponse({ error: e.message });
    });

    return true;
  }

  if (msg.action === "pauseAudio") {
    if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "resumeAudio") {
    if (currentAudio && currentAudio.paused) {
      currentAudio.play().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "stopAudio") {
    cleanup();
    sendResponse({ ok: true });
    return false;
  }
});

function cleanup() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}
