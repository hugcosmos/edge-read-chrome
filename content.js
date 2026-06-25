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
  console.log("[ReadAloud] content.js v20260614-preScroll LOADED on " + location.hostname);

  let highlightedEls = [];
  let lastHighlightIdx = -1; // track which word is highlighted to detect changes
  let boundaryToSpan = {};   // boundary index → span index
  let originalTexts = [];    // { span, text } per wrapped span — used to restore DOM on clear

  // ---- WeRead canvas-based highlighting state ----
  let wereadChars = null;        // [{text, x, y, ci}, ...] one per char, matches extracted text
  let wereadBoundaries = null;   // TTS word boundaries for current chunk
  let wereadChunkOffset = -1;    // char index in wereadChars where current chunk starts
  let wereadWordRanges = null;   // [{startCharIdx, endCharIdx}, ...] precomputed per boundary
  let wereadOverlay = null;      // highlight overlay element
  let wereadCursorOffset = 0;    // forward-only cursor: end char offset of last matched chunk

  // ---- SPA route change detection ----
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      try { chrome.runtime.sendMessage({ action: "urlChanged" }); } catch (_) {}
    }
  }, 1500);

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
            wereadCursorOffset = 0;
            // DOM text: highlight the whole chapter content area.
            if (!wereadChars) {
              const el = document.querySelector(".readerChapterContent");
              if (el) el.classList.add("readaloud-active");
            }
            break;
          case "stop":
          case "done":
            clearHighlight();
            removeWereadOverlay();
            if (!wereadChars) {
              const el = document.querySelector(".readerChapterContent");
              if (el) el.classList.remove("readaloud-active");
            }
            break;
          case "highlight":
            if (wereadChars) handleWereadHighlight(msg);
            break;
          case "highlightWord":
            if (wereadChars) highlightWereadWord(msg.index);
            break;
          case "error":
            console.error("[ReadAloud]", msg.error);
            break;
        }
        sendResponse({ ok: true });
        return false;
      }

      // ---- QQ Reading: early return for text extraction, fall through for highlighting ----
      if (host === "book.qq.com") {
        switch (msg.action) {
          case "getPageText":
            sendResponse({ text: extractQQReadText() });
            return false;
        }
        // highlight, highlightWord, start, stop, done → fall through to generic handling
      }

      // ---- Tianya: early return for text extraction, fall through for highlighting ----
      if (host === "tianya.net" || host.endsWith(".tianya.net")) {
        switch (msg.action) {
          case "getPageText":
            sendResponse({ text: extractTianyaText() });
            return false;
        }
      }

      // ---- Douban: early return for text extraction, fall through for highlighting ----
      if (host === "www.douban.com") {
        switch (msg.action) {
          case "getPageText":
            sendResponse({ text: extractDoubanText() });
            return false;
        }
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
          // msg.index < 0 signals a gap (clear highlight); pass it through.
          applyHighlight(msg.index < 0 ? msg.index : boundaryToSpan[msg.index]);
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

  // Inject weread-read.js once and resolve with {text, chars} from the hook's
  // __RA_GET_TEXT. Returns chars for canvases currently in the DOM.
  function fetchCapturedText() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve({ text: "", chars: [] });
      }, 2000);
      function handler(e) {
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
  }

  // Extract text for the current chapter. WeRead renders the chapter lazily
  // over a few seconds (all canvases eventually appear in the buffer). We poll
  // until the buffer stops growing, then return the full text.
  //
  // extractSeq guards against concurrent calls (e.g. user re-clicks read
  // before a previous extraction finished): a newer call bumps extractSeq, so
  // stale in-flight extractions bail out instead of overwriting wereadChars.
  let extractSeq = 0;

  // ---- WeRead: slice to one section ----
  // Detects section breaks by three signals: larger font than body, no
  // Chinese punctuation in the line, and a fill color that differs from
  // the body text. More robust than max(fs) alone.
  function sliceToSection(chars) {
    if (chars.length < 4) return chars;

    // Group chars into lines: same cid, similar Y (±5px).
    const lines = [];
    let cur = null;
    for (const c of chars) {
      const cid = c.cid >>> 0;
      if (!cur || cid !== cur.cid || Math.abs(c.y - cur.lastY) > 5) {
        cur = { cid, lastY: c.y, chars: [], fsSum: 0, colors: {} };
        lines.push(cur);
      }
      cur.chars.push(c);
      cur.fsSum += c.fs;
      cur.lastY = c.y;
      const col = c.col || "";
      cur.colors[col] = (cur.colors[col] || 0) + 1;
    }

    // Title lines may include ？！""'' but not sentence/flow punctuation.
    const bodyPunct = /[。，、：；…—]/;
    for (const ln of lines) {
      ln.text = ln.chars.map(c => c.text).join("");
      ln.avgFs = ln.fsSum / ln.chars.length;
      ln.hasPunct = bodyPunct.test(ln.text);
      // Dominant color for this line
      let topCol = "", topN = 0;
      for (const col in ln.colors) {
        if (ln.colors[col] > topN) { topN = ln.colors[col]; topCol = col; }
      }
      ln.col = topCol;
    }

    // Body = most common font size and color across lines.
    const fsCounts = {}, colCounts = {};
    for (const ln of lines) {
      const k = Math.round(ln.avgFs);
      fsCounts[k] = (fsCounts[k] || 0) + 1;
      colCounts[ln.col] = (colCounts[ln.col] || 0) + 1;
    }
    let bodyFs = 0, bodyCol = "";
    let maxFSC = 0, maxColC = 0;
    for (const k in fsCounts) {
      if (fsCounts[k] > maxFSC) { maxFSC = fsCounts[k]; bodyFs = parseInt(k); }
    }
    for (const k in colCounts) {
      if (colCounts[k] > maxColC) { maxColC = colCounts[k]; bodyCol = k; }
    }

    // Title: font larger than body AND color differs from body.
    const isTitle = (ln) =>
      Math.round(ln.avgFs) > bodyFs && ln.col !== bodyCol;

    // Find the first visible character (screen Y ≥ 0).
    const cv = {};
    for (const c of chars) {
      const k = String(c.cid >>> 0);
      if (cv[k]) continue;
      const cnv = document.querySelector('canvas[data-ra-cid="' + k + '"]');
      if (!cnv) { cv[k] = null; continue; }
      cv[k] = {
        top: cnv.getBoundingClientRect().top,
        sy: cnv.offsetHeight > 0 ? cnv.height / cnv.offsetHeight : 1,
      };
    }
    // Diagnostic: print canvas rects and a few sample screen-Y values.
    console.log("[ReadAloud] weread cv cids:", Object.keys(cv).join(","),
      "scrollY=" + window.scrollY);
    for (const k in cv) {
      if (cv[k]) console.log("  cid=" + k + " top=" + Math.round(cv[k].top) + " sy=" + cv[k].sy);
      else console.log("  cid=" + k + " MISSING");
    }
    let visStart = 0;
    for (let i = 0; i < chars.length; i++) {
      const m = cv[String(chars[i].cid >>> 0)];
      if (m && m.top + chars[i].y / m.sy >= 0) { visStart = i; break; }
    }

    // Find which line contains visStart.
    let visLine = -1;
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      if (visStart < pos + lines[i].chars.length) { visLine = i; break; }
      pos += lines[i].chars.length;
    }
    if (visLine < 0) visLine = lines.length - 1;

    // Diagnostic: print lines around visLine.
    const dbgStart = Math.max(0, visLine - 3);
    const dbgEnd = Math.min(lines.length, visLine + 5);
    console.log("[ReadAloud] weread lines around visLine=" + visLine +
      " bodyFs=" + bodyFs + " bodyCol=" + bodyCol + ":");
    for (let i = dbgStart; i < dbgEnd; i++) {
      const ln = lines[i];
      console.log("  [" + i + "]" + (isTitle(ln) ? " TITLE" : " body") +
        " fs=" + Math.round(ln.avgFs) + " col=" + ln.col +
        " punct=" + ln.hasPunct + " text=\"" + ln.text.substring(0, 30) + "\"");
    }

    // Search forward (≤3 lines) then backward for nearest title.
    let startLine = -1;
    for (let i = visLine; i < Math.min(lines.length, visLine + 4); i++) {
      if (isTitle(lines[i])) { startLine = i; break; }
    }
    if (startLine < 0) {
      for (let i = visLine; i >= 0; i--) {
        if (isTitle(lines[i])) { startLine = i; break; }
      }
    }
    if (startLine < 0) startLine = visLine;

    // Multi-line title: merge preceding consecutive title lines so the slice
    // starts at the first line of the title, not mid-title.
    while (startLine > 0 && isTitle(lines[startLine - 1])) startLine--;

    // Walk forward to next title line. Skip consecutive title lines at the
    // start (multi-line titles) — only a title line after body content marks
    // the next section.
    let endLine = lines.length;
    let sawBody = false;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (isTitle(lines[i])) {
        if (sawBody) { endLine = i; break; }
      } else {
        sawBody = true;
      }
    }

    // Convert line indices back to char range.
    let startIdx = 0;
    for (let i = 0; i < startLine; i++) startIdx += lines[i].chars.length;
    let endIdx = startIdx;
    for (let i = startLine; i < endLine; i++) endIdx += lines[i].chars.length;

    const slice = chars.slice(startIdx, endIdx);
    console.log("[ReadAloud] weread section: bodyFs=" + bodyFs +
      " bodyCol=" + bodyCol +
      " visStart=" + visStart + " visLine=" + visLine +
      " startLine=" + startLine + " endLine=" + endLine +
      "/" + lines.length + " lines" +
      " len=" + slice.length +
      " preview=\"" + slice.map(c => c.text).join("").substring(0, 30) + "\"");
    return slice;
  }

  // Fallback: extract text from WeRead's DOM text layer (.readerChapterContent
  // absolutely-positioned spans). Used when the canvas buffer is stale.
  function extractWereadDomText() {
    const spans = document.querySelectorAll(".readerChapterContent span[data-wr-role=text]");
    if (!spans.length) return "";
    const arr = Array.from(spans).map(s => {
      const r = s.getBoundingClientRect();
      return { text: s.textContent, x: Math.round(r.left), y: Math.round(r.top) };
    });
    // Vertical text: primary sort Y (top→bottom), secondary X ascending.
    // Right-to-left columns are correct, but since we concat row-by-row,
    // we need left-to-right within each row so the output reads naturally.
    arr.sort((a, b) => a.y - b.y || a.x - b.x);
    // Start from the first visible char.
    let visStart = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].y >= 0) { visStart = i; break; }
    }
    const text = arr.map(c => c.text).join("").substring(visStart);
    console.log("[ReadAloud] weread DOM text: " + arr.length + " spans, start=" +
      visStart + " preview=\"" + text.substring(0, 40) + "\"");
    return text;
  }

  // Extract text from WeRead. Canvas first (section detection + overlay);
  // fall back to DOM text layer only when canvas has no visible chars.
  //
  // extractSeq guards against concurrent calls.
  async function extractWereadText() {
    const mySeq = ++extractSeq;

    let bestChars = [];
    let bestLen = 0;
    let stableCount = 0;
    for (let i = 0; i < 10; i++) {
      if (mySeq !== extractSeq) return "";
      const data = await fetchCapturedText();
      const chars = data.chars || [];
      if (chars.length > bestLen) {
        bestChars = chars;
        bestLen = chars.length;
        stableCount = 0;
      } else {
        stableCount++;
        if (stableCount >= 2 && bestLen > 100) break;
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    if (mySeq !== extractSeq) return "";
    if (bestLen <= 50) {
      // Canvas empty → try DOM.
      const domText = extractWereadDomText();
      if (domText) { wereadChars = null; console.log("[ReadAloud] weread: using DOM text, " + domText.length + " chars"); return domText; }
      console.log("[ReadAloud] weread: no text after polling (" + bestLen + " chars)");
      return "";
    }
    const sectionChars = sliceToSection(bestChars);
    if (sectionChars.length === 0 || !sectionChars.some(c => {
      const cnv = document.querySelector('canvas[data-ra-cid="' + (c.cid >>> 0) + '"]');
      if (!cnv) return false;
      const top = cnv.getBoundingClientRect().top;
      const sy = cnv.offsetHeight > 0 ? cnv.height / cnv.offsetHeight : 1;
      return top + c.y / sy >= 0;
    })) {
      // Sliced section has no visible chars → canvas is stale, use DOM.
      const domText = extractWereadDomText();
      if (domText) { wereadChars = null; console.log("[ReadAloud] weread: using DOM text, " + domText.length + " chars"); return domText; }
      console.log("[ReadAloud] weread: section slice empty / no visible");
      return "";
    }
    wereadChars = sectionChars;
    wereadChunkOffset = 0;
    wereadCursorOffset = 0;
    const text = sectionChars.map(c => c.text).join("");
    console.log("[ReadAloud] weread: extracted " + sectionChars.length + " chars");
    return text;
  }




  // ---- WeRead: highlight message handler ----

  function handleWereadHighlight(msg) {
    wereadBoundaries = msg.boundaries || [];
    wereadWordRanges = null;
    if (!wereadBoundaries.length) return;
    if (!wereadChars) return;

    const fullFlat = wereadChars.map(c => c.text).join("");
    // Forward-only cursor: search from where the previous chunk ended.
    // CJK pages contain many repeated phrases; indexOf would otherwise keep
    // matching the earliest occurrence and snap the overlay back to the top.
    let chunkOff = fullFlat.indexOf(msg.text, wereadCursorOffset);
    // Fall back to a fresh search only if the cursor overshoots the text end
    // (e.g. after a re-extraction trimmed wereadChars). Never fall back to 0
    // unconditionally — that would re-read from page top.
    if (chunkOff < 0 && wereadCursorOffset > 0) {
      chunkOff = fullFlat.indexOf(msg.text, 0);
      if (chunkOff >= 0) wereadCursorOffset = 0;
    }
    console.log("[ReadAloud] weread highlight: fullFlat len=" + fullFlat.length +
      " chunkText len=" + msg.text.length +
      " chunkOff=" + chunkOff +
      " cursor=" + wereadCursorOffset +
      " charsStored=" + wereadChars.length +
      " chunkPreview=\"" + msg.text.substring(0, 40) + "\"");

    // Not found: skip this chunk's highlight entirely rather than anchoring
    // to offset 0 (page top). Cursor stays put so the next chunk can still
    // match forward from here.
    if (chunkOff < 0) {
      console.warn("[ReadAloud] weread highlight: chunk not found, skipping (cursor=" +
        wereadCursorOffset + ")");
      return;
    }

    wereadChunkOffset = chunkOff;
    // Advance cursor past this chunk so the next indexOf cannot rematch it.
    wereadCursorOffset = chunkOff + msg.text.length;

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

  // ---- QQ Reading: extract #article body only ----

  function extractQQReadText() {
    const el = document.querySelector("#article");
    if (el) {
      const text = extractInnerText(el);
      if (text.length > 0) return text;
    }
    return extractPageText(); // fallback to strategy chain
  }

  // ---- Tianya: extract title + post content, skip metadata ----

  function extractTianyaText() {
    const parts = [];
    // Title
    const h1 = document.querySelector("h1.post-title");
    if (h1) parts.push(h1.textContent.trim());
    // Main post + all replies: only .post-rich-text-body (skip .action-buttons)
    const bodies = document.querySelectorAll(".post-rich-text-body");
    for (const body of bodies) {
      const t = extractInnerText(body);
      if (t) parts.push(t);
    }
    if (parts.length > 0) return parts.join("\n");
    return extractPageText(); // fallback
  }

  // ---- Douban: extract title + note body, skip author/time/copyright/likes ----

  function extractDoubanText() {
    const parts = [];
    // Title
    const h1 = document.querySelector(".note-header h1");
    if (h1) parts.push(h1.textContent.trim());
    // Note body: only #link-report .note (pure text, no metadata)
    const noteBody = document.querySelector("#link-report .note");
    if (noteBody) {
      const t = extractInnerText(noteBody);
      if (t) parts.push(t);
    }
    if (parts.length > 0) return parts.join("\n");
    return extractPageText(); // fallback
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
          break;   // foundStart only needed for the sliding-window branch below
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
    originalTexts = [];
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
        originalTexts.push({ span, text: fullText.substring(w.origStart, w.origEnd) });
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
    // idx < 0 means a gap between word boundaries (sent by offscreen): clear
    // the active highlight instead of leaving the previous word stuck.
    if (idx < 0) {
      for (const el of highlightedEls) el.classList.remove("readaloud-active-word");
      return;
    }
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

    // Find the canvas element that owns this character. WeRead stacks one
    // canvas per page; without resolving the owning canvas, a word on page 2+
    // would be positioned against page 1's rect and snap to the top.
    // Resolve by cid (canvas unique id), NOT ci (positional index = sorted cid
    // order): ci and DOM order can diverge after re-render/turn, so matching
    // 'data-ra-cidx="<ci>"' would pick the wrong page. data-ra-cid is stable.
    const cid = (startChar.cid !== undefined) ? (startChar.cid >>> 0) : 0;
    let canvas = document.querySelector('canvas[data-ra-cid="' + cid + '"]');
    if (!canvas) canvas = document.querySelector("canvas[data-ra-cid]");
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
        "cid:", cid,
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
    if (idx <= 2) {
      console.log("[ReadAloud] weread overlay idx=" + idx +
        " charIdx=" + range.startCharIdx +
        " screenY=" + Math.round(screenY) +
        " overlayTop=" + Math.round(overlayTop) +
        " canvasTop=" + Math.round(cr.top) +
        " canvasH=" + Math.round(cr.height) +
        " scrollTo=" + (overlayTop < 50 || overlayTop > window.innerHeight - 100));
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
    wereadCursorOffset = 0;
  }

  function clearHighlight() {
    lastHighlightIdx = -1;
    // Restore the original text nodes by replacing each wrapped span back
    // with a plain Text node of its original text. This reverses the DOM
    // mutation exactly, instead of leaving orphaned <span> elements behind
    // (the old approach only stripped classes and called parent.normalize(),
    // which merges adjacent Text nodes but never removes the span tags).
    for (const { span, text } of originalTexts) {
      if (span.parentNode) span.parentNode.replaceChild(document.createTextNode(text), span);
    }
    originalTexts = [];
    // Still clear any paragraph-level active marks from the highlightParagraph fallback.
    for (const el of highlightedEls) {
      el.classList.remove("readaloud-active-word");
      el.classList.remove("readaloud-word");
      el.classList.remove("readaloud-active");
    }
    highlightedEls = [];
  }
})();
