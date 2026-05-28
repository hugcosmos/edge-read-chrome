// ============================================================
// ReadAloud - Content Script
// Text extraction + word-level highlighting synced with audio
// Timer starts on "startHighlight" (when audio actually begins)
// Supports pause/resume
// ============================================================

;(function () {
  "use strict";

  if (window.__readaloudLoaded) return;
  window.__readaloudLoaded = true;

  let highlightedEls = [];
  let highlightTimer = null;
  let startTime = 0;
  let pausedElapsed = 0; // elapsed ms when paused
  let lastHighlightIdx = -1; // track which word is highlighted to detect changes

  // ---- Message handling ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.action) {
        case "getPageText":
          sendResponse({ text: extractPageText() });
          return false;

        case "getSelectedText":
          sendResponse({ text: window.getSelection().toString().trim() });
          return false;

        case "start":
        case "stop":
        case "done":
          clearHighlight();
          break;

        case "highlight":
          clearHighlight();
          setupWordHighlights(msg.text, msg.boundaries || []);
          break;

        case "startHighlight":
          startTimer();
          break;

        case "pauseHighlight":
          pauseTimer();
          break;

        case "resumeHighlight":
          resumeTimer();
          break;

        case "error":
          console.error("[ReadAloud]", msg.error);
          break;
      }
      sendResponse({ ok: true });
    } catch (e) {
      console.error("[ReadAloud] content error:", e);
      sendResponse({ ok: true }); // always respond so background doesn't hang
    }
    return false;
  });

  // ---- Text Extraction ----

  function extractPageText() {
    const el =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;
    return (el.innerText || "").replace(/\s+/g, " ").trim();
  }

  // Normalize whitespace for matching: collapse all whitespace runs to single space
  function norm(s) {
    return s.replace(/[\s\u00a0]+/g, " ").trim();
  }

  // Build a mapping from normalized char index -> original char index
  // Returns an array where map[i] = original index for normalized position i
  function buildNormMap(orig) {
    const map = [];
    let oi = 0;
    // Skip leading whitespace (matches trim)
    while (oi < orig.length && /[\s\u00a0]/.test(orig[oi])) oi++;
    for (; oi < orig.length; oi++) {
      if (/[\s\u00a0]/.test(orig[oi])) {
        map.push(oi); // first space char maps to this normalized space
        while (oi < orig.length - 1 && /[\s\u00a0]/.test(orig[oi + 1])) oi++;
        // skip subsequent whitespace chars
      } else {
        map.push(oi);
      }
    }
    return map;
  }


  // ---- Word-Level Highlighting ----

  function setupWordHighlights(text, boundaries) {
    if (!text || !boundaries.length) {
      highlightParagraph(text);
      return;
    }

    const allSpans = [];
    const nodeWords = {}; // nodeIdx -> [{ origStart, origEnd, boundary }]

    // Collect non-empty text nodes in document order
    const textNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;
      if (parent.classList.contains("readaloud-word")) continue;
      if (norm(node.textContent)) textNodes.push(node);
    }

    if (!textNodes.length) {
      highlightParagraph(text);
      return;
    }

    // For each word from boundaries, find it in the DOM text nodes sequentially
    // We walk through textNodes maintaining a cursor, matching words in order
    let walkerNodeIdx = 0; // which text node we're currently scanning
    let walkerCharIdx = 0; // how far into that node's normalized text we've scanned

    for (const b of boundaries) {
      const wordNorm = norm(b.text);
      if (!wordNorm) continue;

      // Search from current position forward through text nodes
      let found = false;
      for (let ni = walkerNodeIdx; ni < textNodes.length; ni++) {
        const nodeNorm = norm(textNodes[ni].textContent);
        const searchStart = (ni === walkerNodeIdx) ? walkerCharIdx : 0;
        const pos = nodeNorm.indexOf(wordNorm, searchStart);

        if (pos !== -1) {
          // Found the word in this text node
          const nOrig = textNodes[ni].textContent;
          const nMap = buildNormMap(nOrig);
          if (pos < nMap.length && pos + wordNorm.length - 1 < nMap.length) {
            const origStart = nMap[pos];
            const origEnd = nMap[pos + wordNorm.length - 1] + 1;

            if (!nodeWords[ni]) nodeWords[ni] = [];
            nodeWords[ni].push({ origStart, origEnd, boundary: b });

            // Advance cursor past this word
            walkerNodeIdx = ni;
            walkerCharIdx = pos + wordNorm.length;
            found = true;
          }
          break;
        }

        // Didn't find in this node, move to next
        if (ni > walkerNodeIdx) {
          walkerNodeIdx = ni + 1;
          walkerCharIdx = 0;
        }
      }

      if (!found) {
        // Word not found from current position; reset cursor to scan from beginning
        walkerNodeIdx = 0;
        walkerCharIdx = 0;
      }
    }

    // Modify DOM: for each text node that has words, create a fragment
    for (const niStr of Object.keys(nodeWords)) {
      const ni = parseInt(niStr, 10);
      const node = textNodes[ni];
      const parent = node.parentElement;
      if (!parent || !node.parentNode) continue;

      const words = nodeWords[ni];
      const fullText = node.textContent;
      const fragment = document.createDocumentFragment();
      let pos = 0;

      for (const w of words) {
        if (w.origStart > pos) {
          fragment.appendChild(document.createTextNode(fullText.substring(pos, w.origStart)));
        }
        const span = document.createElement("span");
        span.className = "readaloud-word";
        span.textContent = fullText.substring(w.origStart, w.origEnd);
        span.dataset.offset = w.boundary.offset;
        span.dataset.duration = w.boundary.duration;
        fragment.appendChild(span);
        allSpans.push(span);
        pos = w.origEnd;
      }

      if (pos < fullText.length) {
        fragment.appendChild(document.createTextNode(fullText.substring(pos)));
      }

      try {
        parent.replaceChild(fragment, node);
      } catch (_) {}
    }

    highlightedEls = allSpans;

    if (allSpans.length > 0) {
      allSpans[0].scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      highlightParagraph(text);
    }
  }

  // ---- Timer ----

  function startTimer() {
    stopTimer();
    if (!highlightedEls.length) return;
    pausedElapsed = 0;
    lastHighlightIdx = -1;
    startTime = Date.now();
    runTimer();
  }

  function pauseTimer() {
    if (!highlightTimer) return;
    clearInterval(highlightTimer);
    highlightTimer = null;
    pausedElapsed += Date.now() - startTime;
  }

  function resumeTimer() {
    if (!highlightedEls.length) return;
    startTime = Date.now();
    runTimer();
  }

  function stopTimer() {
    if (highlightTimer) { clearInterval(highlightTimer); highlightTimer = null; }
    pausedElapsed = 0;
  }

  function runTimer() {
    highlightTimer = setInterval(() => {
      const elapsed = pausedElapsed + (Date.now() - startTime);
      const ticks = elapsed * 10000; // ms → 100ns ticks

      let currentIdx = -1;
      for (let i = 0; i < highlightedEls.length; i++) {
        const off = parseInt(highlightedEls[i].dataset.offset, 10);
        const dur = parseInt(highlightedEls[i].dataset.duration, 10);
        if (ticks >= off && ticks < off + dur) { currentIdx = i; break; }
      }

      for (let i = 0; i < highlightedEls.length; i++) {
        highlightedEls[i].classList.toggle("readaloud-active-word", i === currentIdx);
      }

      // Scroll to follow the active word, but only when it changes
      if (currentIdx !== lastHighlightIdx && currentIdx >= 0) {
        lastHighlightIdx = currentIdx;
        const el = highlightedEls[currentIdx];
        if (el) {
          const rect = el.getBoundingClientRect();
          // Only scroll if the word is outside the visible middle band
          if (rect.top < 0 || rect.bottom > window.innerHeight * 0.8) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      }
    }, 60);
  }

  // ---- Paragraph Fallback ----

  function highlightParagraph(text) {
    if (!text) return;
    const textNorm = norm(text);
    const probe = textNorm.substring(0, 30);
    if (!probe) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;

      if (norm(node.textContent).includes(probe)) {
        parent.classList.add("readaloud-active");
        highlightedEls.push(parent);
        parent.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  }

  function clearHighlight() {
    stopTimer();
    const parents = new Set();
    for (const el of highlightedEls) {
      el.classList.remove("readaloud-active-word");
      el.classList.remove("readaloud-word");
      el.classList.remove("readaloud-active");
      if (el.parentElement) parents.add(el.parentElement);
    }
    for (const p of parents) p.normalize();
    highlightedEls = [];
  }
})();
