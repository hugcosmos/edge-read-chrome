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
  let lastHighlightIdx = -1; // track which word is highlighted to detect changes
  let boundaryToSpan = {};   // boundary index → span index

  // ---- WeRead canvas-based highlighting state ----
  let wereadChars = null;        // [{text, x, y}, ...] one per char, matches extracted text
  let wereadBoundaries = null;   // TTS word boundaries for current chunk
  let wereadChunkOffset = -1;    // char index in wereadChars where current chunk starts
  let wereadWordRanges = null;   // [{startCharIdx, endCharIdx}, ...] precomputed per boundary
  let wereadOverlay = null;      // highlight overlay element

  // ---- Message handling ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      // ---- WeRead-specific handling (early return, does not affect other sites) ----
      const host = location.hostname;
      if (host === "weread.qq.com" || host.endsWith(".weread.qq.com")) {
        switch (msg.action) {
          case "getPageText":
            extractWereadText().then(text => sendResponse({ text }));
            return true;
          case "getSelectedText":
            sendResponse({ text: window.getSelection().toString().trim() });
            return false;
          case "start":
            clearHighlight();
            if (wereadOverlay) { wereadOverlay.remove(); wereadOverlay = null; }
            wereadBoundaries = null;
            wereadChunkOffset = -1;
            break;
          case "stop":
          case "done":
            clearHighlight();
            removeWereadOverlay();
            break;
          case "highlight":
            handleWereadHighlight(msg);
            break;
          case "highlightWord":
            highlightWereadWord(msg.index);
            break;
          case "error":
            console.error("[ReadAloud]", msg.error);
            break;
        }
        sendResponse({ ok: true });
        return false;
      }

      // ---- Original code for all other sites (unchanged from f8ccea4) ----
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

        case "highlightWord":
          applyHighlight(boundaryToSpan[msg.index]);
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

  // ---- Text Extraction (Strategy Chain) ----
  // Each extractor returns { text, name } or null.
  // Strategies are ordered by precision: most specific first.
  // To add a new strategy, insert it into EXTRACTORS before body-fallback.

  function extractInnerText(el) {
    return (el.innerText || "").replace(/\s+/g, " ").trim();
  }

  // ---- WeRead: async text extraction from canvas ----

  async function extractWereadText() {
    const data = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve({ text: "", chars: [] });
      }, 2000);
      function handler(e) {
        // Verify message comes from same window and origin
        if (e.source !== window) return;
        if (e.origin !== window.location.origin && e.origin !== "null") return;
        if (e.data?.type === "readaloud-weread-text") {
          clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve({ text: e.data.text || "", chars: e.data.chars || [] });
        }
      }
      window.addEventListener("message", handler);
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("weread-read.js");
      s.onload = () => s.remove();
      document.head.appendChild(s);
    });
    const text = data.text.replace(/\n/g, "");
    const chars = data.chars;
    console.log("[ReadAloud] weread: text len=" + text.length + " chars len=" + chars.length);
    if (text.length <= 50) return "";
    // Trim to start from current viewport
    let viewStartIdx = 0;
    const canvas = document.querySelector("canvas[data-random]");
    if (canvas && chars.length) {
      const scaleY = canvas.offsetHeight > 0 ? canvas.height / canvas.offsetHeight : 1;
      const visibleTopY = Math.max(0, -canvas.getBoundingClientRect().top);
      const canvasVisibleTopY = visibleTopY * scaleY;
      const found = chars.findIndex(c => c.y >= canvasVisibleTopY);
      if (found > 0) viewStartIdx = found;
    }
    wereadChars = chars;
    wereadChunkOffset = viewStartIdx;
    return text.substring(viewStartIdx);
  }

  // ---- WeRead: highlight message handler ----

  function handleWereadHighlight(msg) {
    wereadBoundaries = msg.boundaries || [];
    wereadWordRanges = null;
    if (!wereadChars || !wereadBoundaries.length) return;
    const fullFlat = wereadChars.map(c => c.text).join("");
    const chunkOff = fullFlat.indexOf(msg.text);
    wereadChunkOffset = chunkOff >= 0 ? chunkOff : 0;
    // Build char ranges by searching for each boundary word in actual text
    wereadWordRanges = [];
    let searchFrom = wereadChunkOffset;
    const chunkEnd = wereadChunkOffset + msg.text.length;
    for (const b of wereadBoundaries) {
      const wordText = b.text || "";
      if (wordText && searchFrom < chunkEnd) {
        const pos = fullFlat.indexOf(wordText, searchFrom);
        if (pos >= 0 && pos < chunkEnd) {
          wereadWordRanges.push({ startCharIdx: pos, endCharIdx: pos + wordText.length });
          searchFrom = pos + wordText.length;
        } else {
          wereadWordRanges.push(null);
        }
      } else {
        wereadWordRanges.push(null);
      }
    }
  }

  // ---- Text Extraction (Strategy Chain) for non-WeRead sites ----

  const EXTRACTORS = [
    {
      name: "semantic",
      run() {
        const tags = ["article", "main", '[role="main"]'];
        for (const t of tags) {
          const el = document.querySelector(t);
          if (el) {
            const text = extractInnerText(el);
            console.log("[ReadAloud] semantic:", t, "len=" + text.length);
            if (text.length > 50) return { text, name: "semantic" };
          }
        }
        console.log("[ReadAloud] semantic: no match");
        return null;
      }
    },
    {
      name: "og-article",
      run() {
        const ogType = document.querySelector('meta[property="og:type"]');
        console.log("[ReadAloud] og-article: og:type =", ogType ? ogType.content : "none");
        if (!ogType || ogType.content !== "article") return null;
        const selectors = ["#content", ".article-content", ".post-body", ".entry-content", ".note-container", ".article-detail"];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const text = extractInnerText(el);
            console.log("[ReadAloud] og-article:", sel, "len=" + text.length);
            if (text.length > 50) return { text, name: "og-article" };
          }
        }
        console.log("[ReadAloud] og-article: no content container found");
        return null;
      }
    },
    {
      name: "common-content",
      run() {
        const selectors = [
          "#article-content", "#articleContent",
          "#post-content", "#postContent",
          "#entry-content",
          ".article-content", ".post-content",
          ".entry-content", ".content-body",
          "#content", ".content"
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const text = extractInnerText(el);
          console.log("[ReadAloud] common-content:", sel, "len=" + text.length);
          if (text.length > 200) return { text, name: "common-content" };
        }
        console.log("[ReadAloud] common-content: no match");
        return null;
      }
    },
    {
      name: "body-fallback",
      run() {
        const text = extractInnerText(document.body);
        console.log("[ReadAloud] body-fallback: len=" + text.length);
        return text.length > 0 ? { text, name: "body-fallback" } : null;
      }
    }
  ];

  function extractPageText() {
    console.log("[ReadAloud] extractPageText start, URL:", location.href);
    for (const extractor of EXTRACTORS) {
      const result = extractor.run();
      if (result) {
        console.log("[ReadAloud] matched:", result.name, "len=" + result.text.length, "preview:", result.text.substring(0, 80));
        return result.text;
      }
    }
    console.log("[ReadAloud] all extractors failed");
    return "";
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
    boundaryToSpan = {};  // boundary index → span index

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

    // Locate where this chunk starts in the DOM so we match from the
    // correct position instead of always starting at node 0.
    const chunkProbe = norm(text.substring(0, 40));
    let startNodeIdx = 0;
    let startCharIdx = 0;
    let foundStart = false;
    if (chunkProbe.length >= 8) {
      const probe = chunkProbe.substring(0, 20);
      for (let ni = 0; ni < textNodes.length && !foundStart; ni++) {
        const nodeNorm = norm(textNodes[ni].textContent);
        const probePos = nodeNorm.indexOf(probe);
        if (probePos !== -1) {
          startNodeIdx = ni;
          startCharIdx = probePos;
          foundStart = true;
          break;
        }
        // Try sliding window across concatenated nodes for chunks that
        // span multiple text nodes.
        let combined = nodeNorm;
        for (let nj = ni + 1; nj < textNodes.length && combined.length < 200; nj++) {
          combined += " " + norm(textNodes[nj].textContent);
          const cp = combined.indexOf(probe);
          if (cp !== -1) {
            // Walk back to figure out which node the match starts in
            let walkCombined = norm(textNodes[ni].textContent);
            if (cp < walkCombined.length) {
              startNodeIdx = ni;
              startCharIdx = cp;
            } else {
              let remaining = cp - walkCombined.length - 1; // -1 for the joining space
              for (let nk = ni + 1; nk <= nj; nk++) {
                const nnk = norm(textNodes[nk].textContent);
                if (remaining < nnk.length) {
                  startNodeIdx = nk;
                  startCharIdx = remaining;
                  break;
                }
                remaining -= nnk.length + 1; // +1 for joining space
              }
            }
            foundStart = true;
            break;
          }
        }
      }
    }

    // For each word from boundaries, find it in the DOM text nodes sequentially.
    // Cursor only moves forward — never resets to 0.
    let walkerNodeIdx = startNodeIdx;
    let walkerCharIdx = startCharIdx;

    for (const b of boundaries) {
      const wordNorm = norm(b.text);
      if (!wordNorm) continue;

      let found = false;
      for (let ni = walkerNodeIdx; ni < textNodes.length; ni++) {
        const nodeNorm = norm(textNodes[ni].textContent);
        const searchStart = (ni === walkerNodeIdx) ? walkerCharIdx : 0;
        const pos = nodeNorm.indexOf(wordNorm, searchStart);

        if (pos !== -1) {
          const nOrig = textNodes[ni].textContent;
          const nMap = buildNormMap(nOrig);
          if (pos < nMap.length && pos + wordNorm.length - 1 < nMap.length) {
            const origStart = nMap[pos];
            const origEnd = nMap[pos + wordNorm.length - 1] + 1;

            if (!nodeWords[ni]) nodeWords[ni] = [];
            nodeWords[ni].push({ origStart, origEnd, boundary: b });

            walkerNodeIdx = ni;
            walkerCharIdx = pos + wordNorm.length;
            found = true;
          }
          // Only break on successful match; nMap failure → continue to next node
          if (found) break;
        }

        if (ni > walkerNodeIdx) {
          walkerNodeIdx = ni + 1;
          walkerCharIdx = 0;
        }
      }
      // Not found → keep cursor where it is (don't reset to 0)
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
        boundaryToSpan[w.boundary.index] = allSpans.length;
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

    if (allSpans.length === 0) {
      highlightParagraph(text);
    }
  }

  // ---- Highlight Application (driven by offscreen via audio.currentTime) ----

  function applyHighlight(idx) {
    for (let i = 0; i < highlightedEls.length; i++) {
      highlightedEls[i].classList.toggle("readaloud-active-word", i === idx);
    }

    // Scroll to follow the active word, but only when it changes
    if (idx !== lastHighlightIdx && idx >= 0) {
      lastHighlightIdx = idx;
      const el = highlightedEls[idx];
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight * 0.8) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
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

  // ---- WeRead Canvas Highlighting ----

  function highlightWereadWord(idx) {
    if (!wereadChars || !wereadWordRanges || idx < 0) return;
    const range = wereadWordRanges[idx];
    if (!range) return;

    const startChar = wereadChars[range.startCharIdx];
    const endChar = wereadChars[range.endCharIdx - 1];
    if (!startChar || !endChar) {
      console.log("[ReadAloud] weread highlight: char not found", idx, "range:", JSON.stringify(range), "chars:", wereadChars.length);
      return;
    }

    // Find the canvas element
    const canvas = document.querySelector("canvas[data-random]");
    if (!canvas) return;

    // Create overlay if needed
    if (!wereadOverlay) {
      wereadOverlay = document.createElement("div");
      wereadOverlay.style.cssText =
        "position:fixed;background:rgba(211,227,253,0.45);border-radius:3px;" +
        "pointer-events:none;z-index:9999;transition:left 0.08s,top 0.08s,width 0.08s;";
      document.body.appendChild(wereadOverlay);
    }

    // Position overlay over the word on the canvas using viewport coordinates
    const cr = canvas.getBoundingClientRect();
    // Canvas internal coords may be scaled by DPR relative to CSS size
    const scaleX = canvas.offsetWidth > 0 ? canvas.width / canvas.offsetWidth : 1;
    const scaleY = canvas.offsetHeight > 0 ? canvas.height / canvas.offsetHeight : 1;
    if (idx === 0) {
      console.log("[ReadAloud] weread overlay: canvasRect:", Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height),
        "scale:", scaleX.toFixed(2), scaleY.toFixed(2),
        "char[0]:", JSON.stringify(startChar),
        "overlayPos:", Math.round(cr.left + startChar.x / scaleX), Math.round(cr.top + startChar.y / scaleY));
    }
    const screenX = startChar.x / scaleX;
    const screenY = startChar.y / scaleY;
    const endScreenX = endChar.x / scaleX;
    // Compute line spacing from smallest Y gap between chars (actual line height)
    let lineSpacing = 25;
    let minGap = Infinity;
    for (let i = 1; i < Math.min(wereadChars.length, 500); i++) {
      const dy = wereadChars[i].y - wereadChars[i - 1].y;
      if (dy > 8 && dy < minGap) minGap = dy;
    }
    if (minGap < Infinity) lineSpacing = minGap / scaleY;
    // Position overlay: y is likely near-baseline. Center overlay on the text line.
    // overlay covers: screenY - lineSpacing*0.35 to screenY + lineSpacing*0.35
    const overlayH = lineSpacing * 0.75;
    const overlayTop = cr.top + screenY - lineSpacing * 0.35;
    if (idx === 0) {
      console.log("[ReadAloud] weread overlay: lineSpacing=" + Math.round(lineSpacing) +
        " screenY=" + Math.round(screenY) + " overlayH=" + Math.round(overlayH));
    }

    // position:fixed — use viewport coordinates directly
    wereadOverlay.style.left = (cr.left + screenX - 2) + "px";
    wereadOverlay.style.top = overlayTop + "px";
    wereadOverlay.style.width = (endScreenX - screenX + 24) + "px";
    wereadOverlay.style.height = overlayH + "px";
    wereadOverlay.style.display = "block";

    // Scroll the word into view if needed
    if (overlayTop < 50 || overlayTop > window.innerHeight - 100) {
      const pageY = window.scrollY + overlayTop;
      window.scrollTo({ top: pageY - window.innerHeight / 3, behavior: "smooth" });
    }
  }

  function removeWereadOverlay() {
    if (wereadOverlay) {
      wereadOverlay.remove();
      wereadOverlay = null;
    }
    wereadBoundaries = null;
    wereadWordRanges = null;
    wereadChunkOffset = -1;
    wereadChars = null;
  }

  function clearHighlight() {
    lastHighlightIdx = -1;
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
