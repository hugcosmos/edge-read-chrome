// ============================================================
// ReadAloud - Popup Script
// ============================================================

const voiceSelect = document.getElementById("voice");
const speedSlider = document.getElementById("speed");
const speedLabel = document.getElementById("speed-val");
const btnPage = document.getElementById("btn-page");
const btnSelection = document.getElementById("btn-selection");
const btnStop = document.getElementById("btn-stop");
const statusEl = document.getElementById("status");

// ---- Init ----

chrome.runtime.sendMessage({ action: "getActualVoice" }, (r) => {
  const actualVoice = (r && r.voice) ? r.voice : null;
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (!s) return;
    if (s.rate !== undefined) {
      speedSlider.value = s.rate;
      updateSpeedLabel(s.rate);
    }
    loadVoices(actualVoice || s.voice);
  });
});

// Check native host status
chrome.runtime.sendMessage({ action: "getNativeStatus" }, (r) => {
  if (r && r.available) {
    statusEl.textContent = "Edge TTS connected";
    statusEl.className = "status info";
  } else {
    statusEl.textContent = "Native host not found — run install.sh first";
    statusEl.className = "status error";
  }
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

    // Sort: Chinese & English (US/UK) first, then other English, then by locale, then by name
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
      // Female first within same locale
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

  // Check if voice is compatible with current text
  chrome.runtime.sendMessage({ action: "checkVoiceCompatible", voice: newVoice }, (r) => {
    if (r && !r.compatible) {
      // Not compatible - restore actual voice and show error
      chrome.runtime.sendMessage({ action: "getActualVoice" }, (v) => {
        if (v && v.voice) {
          voiceSelect.value = v.voice;
          const msg = r.textLang === "cjk" ? "中文文本需要中文语音" : "English text requires English voice";
          setStatus(msg, "error");
        }
      });
      return;
    }
    // Compatible - update settings
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
    else window.close();
  });
});

btnSelection.addEventListener("click", () => {
  setStatus("Reading selection...", "info");
  chrome.runtime.sendMessage({ action: "readSelection" }, (resp) => {
    if (resp && resp.error) setStatus(resp.error, "error");
    else window.close();
  });
});

btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop" }, () => setStatus("Stopped"));
});
