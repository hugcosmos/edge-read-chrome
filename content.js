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

  // ---- Message handling ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

  // Find the original-text substring that corresponds to a range in the normalized text
  function normSubstring(orig, normStart, normLen) {
    const map = buildNormMap(orig);
    if (normStart >= map.length) return "";
    const startOrig = map[normStart];
    const endIdx = Math.min(normStart + normLen, map.length) - 1;
    // End is one past the last char's original position
    const endOrig = map[endIdx] + 1;
    return orig.substring(startOrig, endOrig);
  }

  // Find original range [start, end) for a normalized range
  function normRange(orig, normStart, normLen) {
    const map = buildNormMap(orig);
    if (normStart >= map.length) return null;
    const startOrig = map[normStart];
    const endIdx = Math.min(normStart + normLen, map.length) - 1;
    const endOrig = map[endIdx] + 1;
    return { start: startOrig, end: endOrig };
  }

  // ---- Word-Level Highlighting ----

  function setupWordHighlights(text, boundaries) {
    if (!text || !boundaries.length) {
      highlightParagraph(text);
      return;
    }

    const textNorm = norm(text);
    if (!textNorm) return;

    // Collect all text nodes in document order
    const textNodes = [];
    const collectWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (collectWalker.nextNode()) {
      const node = collectWalker.currentNode;
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

    // Build a concatenated normalized string from all text nodes,
    // tracking which node + position each normalized char maps to
    const charMap = []; // charMap[i] = { nodeIdx, charIdx within that node's norm }
    let concatNorm = "";
    const nodeNorms = textNodes.map(n => norm(n.textContent));
    const nodeStarts = []; // nodeStarts[ni] = position in concatNorm where node ni starts

    for (let ni = 0; ni < textNodes.length; ni++) {
      const nNorm = nodeNorms[ni];
      if (concatNorm.length > 0 && nNorm.length > 0) {
        concatNorm += " ";
        charMap.push({ nodeIdx: -1 }); // gap
      }
      nodeStarts[ni] = concatNorm.length;
      for (let ci = 0; ci < nNorm.length; ci++) {
        charMap.push({ nodeIdx: ni, charIdx: ci });
      }
      concatNorm += nNorm;
    }

    // Find where the chunk text starts in concatenated normalized text
    const probeLen = Math.min(20, textNorm.length);
    const probe = textNorm.substring(0, probeLen);
    const startIdx = concatNorm.indexOf(probe);
    if (startIdx === -1) {
      highlightParagraph(text);
      return;
    }

    // Phase 1: Find all word positions (just record, don't modify DOM yet)
    // Group words by nodeIdx, recording each word's original text range in that node
    const nodeWords = {}; // nodeIdx -> [{ origStart, origEnd, boundary }]
    let curOffset = startIdx;

    for (const b of boundaries) {
      const wordNorm = norm(b.text);
      if (!wordNorm) continue;

      const wordStart = concatNorm.indexOf(wordNorm, curOffset);
      if (wordStart === -1) { continue; }
      curOffset = wordStart + wordNorm.length;

      // Map wordStart to a specific text node
      const mi = charMap[wordStart];
      if (!mi || mi.nodeIdx === -1) continue;

      const ni = mi.nodeIdx;
      const localNormStart = wordStart - nodeStarts[ni];

      // Check word doesn't span across nodes
      const wordEndPos = wordStart + wordNorm.length - 1;
      const miEnd = charMap[wordEndPos];
      if (!miEnd || miEnd.nodeIdx !== ni) continue;

      const range = normRange(textNodes[ni].textContent, localNormStart, wordNorm.length);
      if (!range) continue;

      if (!nodeWords[ni]) nodeWords[ni] = [];
      nodeWords[ni].push({ origStart: range.start, origEnd: range.end, boundary: b });
    }

    // Phase 2: Modify DOM — for each text node, create a fragment with all words wrapped
    const allSpans = [];

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
        // Add text before this word
        if (w.origStart > pos) {
          fragment.appendChild(document.createTextNode(fullText.substring(pos, w.origStart)));
        }
        // Add the word span
        const span = document.createElement("span");
        span.className = "readaloud-word";
        span.textContent = fullText.substring(w.origStart, w.origEnd);
        span.dataset.offset = w.boundary.offset;
        span.dataset.duration = w.boundary.duration;
        fragment.appendChild(span);
        allSpans.push(span);
        pos = w.origEnd;
      }

      // Add remaining text
      if (pos < fullText.length) {
        fragment.appendChild(document.createTextNode(fullText.substring(pos)));
      }

      try {
        parent.replaceChild(fragment, node);
      } catch (_) {
        // Node might have been removed, skip
      }
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
