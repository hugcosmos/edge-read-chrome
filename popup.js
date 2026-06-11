// ============================================================
// ReadAloud - Popup Script
// ============================================================

const voiceSelect = document.getElementById("voice");
const speedSlider = document.getElementById("speed");
const speedLabel = document.getElementById("speed-val");
const btnPage = document.getElementById("btn-page");
const btnSelection = document.getElementById("btn-selection");
const btnPause = document.getElementById("btn-pause");
const btnStop = document.getElementById("btn-stop");
const buttonsIdle = document.getElementById("buttons-idle");
const buttonsPlaying = document.getElementById("buttons-playing");
const statusEl = document.getElementById("status");

// ---- State machine ----

function showIdle(hasSelection) {
  buttonsIdle.style.display = "";
  buttonsPlaying.style.display = "none";
  btnSelection.style.display = hasSelection ? "" : "none";
}

function showPlaying(paused) {
  buttonsIdle.style.display = "none";
  buttonsPlaying.style.display = "";
  if (paused) {
    btnPause.textContent = "Resume";
    btnPause.className = "btn btn-resume";
    setStatus("Paused");
  } else {
    btnPause.textContent = "Pause";
    btnPause.className = "btn btn-pause";
    setStatus("Reading...", "info");
  }
}

// ---- Init ----

chrome.runtime.sendMessage({ action: "getNativeStatus" }, (nr) => {
  if (nr && nr.available) {
    statusEl.textContent = "Edge TTS connected";
    statusEl.className = "status info";
  } else {
    statusEl.textContent = "Native host not found — run install.sh first";
    statusEl.className = "status error";
  }

  if (nr && nr.active) {
    showPlaying(nr.paused);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: "getSelectedText" }, (r) => {
          const sel = (r && r.text) ? r.text.trim().length > 0 : false;
          showIdle(sel);
        });
      } else {
        showIdle(false);
      }
    });
  }
});

// Load voice & speed
chrome.runtime.sendMessage({ action: "getActualVoice" }, (r) => {
  const actualVoice = (r && r.voice) ? r.voice : null;
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (!s) return;
    if (s.rate !== undefined) {
      speedSlider.value = s.rate;
      updateSpeedLabel(s.rate);
    }
    const voice = actualVoice || s.voice;
    loadVoices(voice);
    // Check if current voice is compatible with reading text
    if (voice && actualVoice) {
      chrome.runtime.sendMessage({ action: "checkVoiceCompatible", voice }, (cr) => {
        if (cr && !cr.compatible) {
          const msg = cr.textLang === "cjk" ? "中文文本需要中文语音，请在下拉框中切换" : "English text requires English voice, please switch";
          setStatus(msg, "error");
        }
      });
    }
  });
});

// ---- Voices ----

function loadVoices(selectedVoice) {
  chrome.runtime.sendMessage({ action: "getVoices" }, (resp) => {
    if (!resp) return;

    if (resp.nativeAvailable === false) {
      statusEl.textContent = "Native host not found — run install.sh first";
      statusEl.className = "status error";
      return;
    }

    const voices = resp.voices || [];
    if (!voices.length) return;

    voices.sort((a, b) => {
      const priority = (loc) => {
        if (loc.startsWith("zh")) return 0;
        if (loc === "en-US" || loc === "en-GB") return 1;
        if (loc.startsWith("en")) return 2;
        return 3;
      };
      const pa = priority(a.locale);
      const pb = priority(b.locale);
      if (pa !== pb) return pa - pb;
      const cmp = a.locale.localeCompare(b.locale);
      if (cmp !== 0) return cmp;
      if (a.gender !== b.gender) return a.gender === "Female" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    voiceSelect.innerHTML = "";
    let currentLocale = "";

    for (const v of voices) {
      if (v.locale !== currentLocale) {
        currentLocale = v.locale;
        const group = document.createElement("optgroup");
        group.label = localeLabel(v.locale);
        voiceSelect.appendChild(group);
      }

      const opt = document.createElement("option");
      opt.value = v.name;
      const g = v.gender === "Male" ? "M" : "F";
      const name = v.name.replace(/^[a-z]{2}-[A-Z]{2}-/, "").replace("Neural", "");
      opt.textContent = `${name} (${g})`;
      if (v.name === selectedVoice) opt.selected = true;

      voiceSelect.lastElementChild.appendChild(opt);
    }
  });
}

function localeLabel(code) {
  const names = {
    "en-US": "English (US)", "en-GB": "English (UK)", "en-AU": "English (AU)",
    "en-IN": "English (India)", "en-CA": "English (Canada)", "en-NZ": "English (NZ)",
    "en-IE": "English (Ireland)", "en-ZA": "English (South Africa)",
    "zh-CN": "Chinese", "zh-TW": "Chinese (TW)", "zh-HK": "Chinese (HK)",
    "ja-JP": "Japanese", "ko-KR": "Korean",
    "fr-FR": "French", "fr-CA": "French (CA)",
    "de-DE": "German", "es-ES": "Spanish", "es-MX": "Spanish (MX)",
    "pt-BR": "Portuguese (BR)", "pt-PT": "Portuguese (PT)",
    "ru-RU": "Russian", "it-IT": "Italian", "nl-NL": "Dutch",
    "pl-PL": "Polish", "sv-SE": "Swedish", "da-DK": "Danish",
    "fi-FI": "Finnish", "nb-NO": "Norwegian", "tr-TR": "Turkish",
    "ar-SA": "Arabic", "ar-EG": "Arabic (EG)",
    "he-IL": "Hebrew", "hi-IN": "Hindi", "th-TH": "Thai",
    "vi-VN": "Vietnamese", "id-ID": "Indonesian", "ms-MY": "Malay",
    "fil-PH": "Filipino", "uk-UA": "Ukrainian", "cs-CZ": "Czech",
    "el-GR": "Greek", "hu-HU": "Hungarian", "ro-RO": "Romanian",
    "sk-SK": "Slovak", "bg-BG": "Bulgarian", "hr-HR": "Croatian",
    "ca-ES": "Catalan",
  };
  return names[code] || code;
}

// ---- Speed ----

function updateSpeedLabel(rate) {
  speedLabel.textContent = parseFloat(rate).toFixed(1) + "x";
}

speedSlider.addEventListener("input", () => {
  const val = parseFloat(speedSlider.value);
  updateSpeedLabel(val);
  chrome.runtime.sendMessage({ action: "updateSettings", settings: { rate: val } });
});

// ---- Voice ----

voiceSelect.addEventListener("change", () => {
  const newVoice = voiceSelect.value;

  chrome.runtime.sendMessage({ action: "checkVoiceCompatible", voice: newVoice }, (r) => {
    if (r && !r.compatible) {
      chrome.runtime.sendMessage({ action: "getActualVoice" }, (v) => {
        if (v && v.voice) {
          voiceSelect.value = v.voice;
          const msg = r.textLang === "cjk" ? "中文文本需要中文语音" : "English text requires English voice";
          setStatus(msg, "error");
        }
      });
      return;
    }
    chrome.runtime.sendMessage({ action: "updateSettings", settings: { voice: newVoice } });
  });
});

// ---- Buttons ----

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? " " + type : "");
}

btnPage.addEventListener("click", () => {
  setStatus("Reading page...", "info");
  chrome.runtime.sendMessage({ action: "readPage" }, (resp) => {
    if (resp && resp.error) setStatus(resp.error, "error");
    else showPlaying(false);
  });
});

btnSelection.addEventListener("click", () => {
  setStatus("Reading selection...", "info");
  chrome.runtime.sendMessage({ action: "readSelection" }, (resp) => {
    if (resp && resp.error) setStatus(resp.error, "error");
    else showPlaying(false);
  });
});

btnPause.addEventListener("click", () => {
  const isPaused = btnPause.textContent === "Resume";
  const action = isPaused ? "resume" : "pause";
  chrome.runtime.sendMessage({ action }, () => {
    if (isPaused) {
      btnPause.textContent = "Pause";
      btnPause.className = "btn btn-pause";
      setStatus("Reading...", "info");
    } else {
      btnPause.textContent = "Resume";
      btnPause.className = "btn btn-resume";
      setStatus("Paused");
    }
  });
});

btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop" }, () => {
    setStatus("Stopped");
    showIdle(false);
  });
});
