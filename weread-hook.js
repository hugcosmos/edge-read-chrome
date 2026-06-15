// ============================================================
// WeRead Hook - runs in page's MAIN world at document_start
// Intercepts CanvasRenderingContext2D.fillText to capture book text + per-char
// coordinates. GET_TEXT returns chars for canvases currently in the DOM
// (filtered by canvas unique id), excluding stale old-chapter text.
// Coordinates are canvas-internal (y from 0 per canvas) for overlay positioning.
// ============================================================

;(function () {
  window.__RA_HOOK_LOADED = true;
  console.log("[ReadAloud] weread-hook v20260615-clean LOADED");
  window.__RA_CANVAS_LINES = [];   // captured chars: {text,x,y,fs,cid}

  // ---- canvas → unique id mapping ----
  // Each canvas gets a UNIQUE id (ever-incrementing, never reused). On chapter
  // switch old canvases leave the DOM and new ones get new ids — so filtering
  // chars by "owning canvas still in DOM" excludes stale text reliably.
  var canvasIdWeak = new WeakMap();
  var nextCanvasId = 1;

  function canvasIdOf(ctx) {
    var cnv = ctx.canvas;
    if (!cnv) return 0;
    var cached = canvasIdWeak.get(cnv);
    if (cached !== undefined) return cached;
    var id = nextCanvasId++;
    canvasIdWeak.set(cnv, id);
    try { cnv.setAttribute("data-ra-cid", String(id)); } catch (e) {}
    return id;
  }

  // Recompute positional indices (ci = DOM order within canvas container).
  // Stamped as data-ra-cidx for the content script's overlay lookup.
  function refreshPositionalIndices() {
    var root = document.querySelector(".wr_canvasContainer, .renderTargetContainer");
    var scope = root || document;
    var canvases = scope.querySelectorAll("canvas");
    for (var i = 0; i < canvases.length; i++) {
      try { canvases[i].setAttribute("data-ra-cidx", String(i)); } catch (e) {}
    }
  }

  // ---- fillText capture ----
  var origFillText = CanvasRenderingContext2D.prototype.fillText;

  // Auto-capture: wait for the full chapter to render, then post the result.
  // WeRead renders all pages over a few seconds. We poll the buffer; when it
  // stops growing, the chapter is fully captured. We then post the result via
  // postMessage so even the OLD content.js (which doesn't poll) gets the full
  // text. GET_TEXT also returns the full text once ready.
  var captureTimer = null;
  var lastBufLen = 0;
  var stableCount = 0;
  var captureReady = false;
  function checkCaptureReady() {
    var bufLen = window.__RA_CANVAS_LINES.length;
    if (bufLen > lastBufLen) {
      lastBufLen = bufLen;
      stableCount = 0;
    } else {
      stableCount++;
    }
    console.log("[ReadAloud] hook capture check: bufLen=" + bufLen +
      " stable=" + stableCount + " ready=" + captureReady);
    if (stableCount >= 8 && bufLen > 100 && !captureReady) {
      captureReady = true;
      var r = window.__RA_GET_TEXT();
      console.log("[ReadAloud] hook capture READY: " + r.chars.length + " chars, posting");
      window.postMessage({
        type: "readaloud-weread-text",
        text: r.text,
        chars: r.chars,
      }, "*");
    }
  }

  CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
    if (text && typeof text === "string" && text.trim()) {
      if (text.length > 30 && /^[\x20-\x7e]+$/.test(text)) {
        return origFillText.apply(this, arguments);
      }
      var tx = x, ty = y;
      try {
        var t = this.getTransform();
        tx = t.a * x + t.c * y + t.e;
        ty = t.b * x + t.d * y + t.f;
      } catch (e) {}
      var fs = 16;
      var fm = this.font && this.font.match(/(\d+)px/);
      if (fm) fs = parseInt(fm[1], 10);
      var cid = canvasIdOf(this);
      if (text.length === 1) {
        window.__RA_CANVAS_LINES.push({ text: text, x: tx, y: ty, fs: fs, cid: cid });
      } else {
        var charWidth = fs;
        try { charWidth *= this.getTransform().a; } catch (e) {}
        for (var ci = 0; ci < text.length; ci++) {
          window.__RA_CANVAS_LINES.push({
            text: text[ci], x: tx + ci * charWidth, y: ty, fs: fs, cid: cid,
          });
        }
      }
    }
    // Schedule capture-readiness check after each fillText burst
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(function() {
      checkCaptureReady();
      // Keep checking every 1s until ready
      if (!captureReady) {
        captureTimer = setInterval(function() {
          if (captureReady) { clearInterval(captureTimer); return; }
          checkCaptureReady();
        }, 1000);
      }
    }, 1500);
    return origFillText.apply(this, arguments);
  };

  // ---- Diagnostic: find next-page button ----
  // Scans for the next-page button WeRead uses in page-reader mode. Returns
  // a description of what was found so we can wire up auto-page-turn.
  window.__RA_FIND_NEXT_BUTTON = function () {
    var results = [];
    // Broad scan: any clickable element with next/right/arrow/page in class
    var candidates = document.querySelectorAll(
      '[class*=next], [class*=Next], [class*=arrow], [class*=Arrow], ' +
      '[class*=page], [class*=Page], [class*=turn], [class*=Turn], ' +
      'button, [role=button]'
    );
    candidates.forEach(function (e) {
      if (e.offsetWidth === 0 || e.offsetHeight === 0) return;
      var r = e.getBoundingClientRect();
      var cls = (typeof e.className === 'string') ? e.className : '';
      // Only report elements in the bottom area or with relevant class names
      var inBottom = r.top > window.innerHeight * 0.6;
      var relevant = /next|right|arrow|forward|turn/i.test(cls);
      if (inBottom || relevant) {
        results.push({
          tag: e.tagName,
          cls: cls.slice(0, 50),
          text: (e.textContent || '').trim().slice(0, 20),
          x: Math.round(r.left), y: Math.round(r.top),
          w: e.offsetWidth, h: e.offsetHeight,
          inBottom: inBottom, relevant: relevant,
        });
      }
    });
    console.log("[ReadAloud] FIND_NEXT_BUTTON: " + results.length + " candidates");
    results.forEach(function (r) {
      console.log("  " + r.tag + "." + r.cls + ' text="' + r.text + '" ' +
        'pos=' + r.x + ',' + r.y + ' size=' + r.w + 'x' + r.h +
        (r.relevant ? ' [RELEVANT]' : ''));
    });
    return results;
  };

  // ---- Diagnostic: turn page and report canvas changes ----
  // Tries clicking the first relevant candidate, then reports canvas count
  // and GET_TEXT char count before/after.
  window.__RA_TRY_TURN = function () {
    var beforeCids = [];
    document.querySelectorAll("canvas[data-ra-cid]").forEach(function (c) {
      beforeCids.push(c.getAttribute("data-ra-cid"));
    });
    var beforeText = window.__RA_GET_TEXT().text.length;
    console.log("[ReadAloud] TRY_TURN before: cids=[" + beforeCids.join(",") +
      "] textLen=" + beforeText);

    // Find and click next-page button
    var candidates = window.__RA_FIND_NEXT_BUTTON();
    var clicked = null;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].relevant) {
        // Find the actual element again (candidates were plain objects)
        var els = document.querySelectorAll('[class*=next], [class*=Next], [class*=arrow], [class*=Arrow]');
        for (var j = 0; j < els.length; j++) {
          if (els[j].offsetWidth > 0) {
            var r = els[j].getBoundingClientRect();
            if (Math.round(r.left) === candidates[i].x &&
                Math.round(r.top) === candidates[i].y) {
              els[j].click();
              clicked = candidates[i];
              break;
            }
          }
        }
        if (clicked) break;
      }
    }

    if (!clicked) {
      // Fallback: dispatch ArrowRight key events (keydown + keyup) on multiple
      // targets. Some apps listen on document, some on body, some on a specific
      // reader container.
      console.log("[ReadAloud] TRY_TURN: no button clicked, trying ArrowRight key");
      var targets = [document, document.body, document.querySelector('.app_content, .readerChapterContent, .wr_canvasContainer')].filter(Boolean);
      targets.forEach(function (t) {
        t.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true
        }));
        t.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true
        }));
      });
    } else {
      console.log("[ReadAloud] TRY_TURN: clicked " + clicked.tag + "." + clicked.cls);
    }

    // Check after 1.5s
    setTimeout(function () {
      var afterCids = [];
      document.querySelectorAll("canvas[data-ra-cid]").forEach(function (c) {
        afterCids.push(c.getAttribute("data-ra-cid"));
      });
      var afterBuf = window.__RA_CANVAS_LINES.length;
      var newCids = afterCids.filter(function (c) { return beforeCids.indexOf(c) < 0; });
      console.log("[ReadAloud] TRY_TURN after: domCids=[" + afterCids.join(",") +
        "] bufferTotal=" + afterBuf + " newDomCids=[" + newCids.join(",") + "]");
    }, 1500);
  };

  // ---- GET_TEXT: return ALL captured chars ----
  // Returns every char in the buffer (all canvases rendered so far). WeRead
  // renders pages over time, so the buffer grows; callers should poll until it
  // stabilizes. Coordinates stay canvas-internal (y from 0 per canvas).
  window.__RA_GET_TEXT = function () {
    // Only return chars whose owning canvas is still in the DOM (filter by
    // data-ra-cid). On chapter switch, old canvases leave the DOM while the
    // capture buffer keeps growing; without this filter, stale old-chapter
    // text would be returned and re-read.
    var liveCids = {};
    document.querySelectorAll("canvas[data-ra-cid]").forEach(function (c) {
      liveCids[c.getAttribute("data-ra-cid")] = true;
    });
    var all = window.__RA_CANVAS_LINES.filter(function (c) {
      return liveCids[String(c.cid >>> 0)];
    });
    if (!all || !all.length) return { text: "", chars: [] };

    refreshPositionalIndices();

    // Build cid→ci map (positional index = sorted cid order = reading order)
    var allCidsInBuffer = [];
    var seenCid = {};
    for (var i = 0; i < all.length; i++) {
      var c = all[i].cid >>> 0;
      if (!seenCid[c]) { seenCid[c] = true; allCidsInBuffer.push(c); }
    }
    allCidsInBuffer.sort(function (a, b) { return a - b; });
    var cidToCi = {};
    for (var i = 0; i < allCidsInBuffer.length; i++) {
      cidToCi[allCidsInBuffer[i]] = i;
    }

    var items = [];
    for (var i = 0; i < all.length; i++) {
      var cid = all[i].cid >>> 0;
      all[i].ci = cidToCi[cid] !== undefined ? cidToCi[cid] : 0;
      items.push(all[i]);
    }
    console.log("[ReadAloud] hook GET_TEXT: total=" + items.length +
      " cids=[" + allCidsInBuffer.join(",") + "]");
    if (!items.length) return { text: "", chars: [] };

    // Dedup by canvas unique id + position + text
    var deduped = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var key = (items[i].cid >>> 0) + "|" + items[i].text + "|" +
        Math.round(items[i].y / 5) + "|" + Math.round(items[i].x / 5);
      if (!seen[key]) { seen[key] = true; deduped.push(items[i]); }
    }

    // Group into lines by Y proximity; break on canvas change (new page)
    var allLines = [];
    var currentLine = [];
    var lastY = null;
    var lastCi = -1;
    for (var i = 0; i < deduped.length; i++) {
      var item = deduped[i];
      if ((lastY !== null && Math.abs(item.y - lastY) > 5) || item.ci !== lastCi) {
        if (currentLine.length > 0) {
          allLines.push({
            lineText: currentLine.map(function (c) { return c.text; }).join(""),
            lineChars: currentLine.slice(),
          });
        }
        currentLine = [];
      }
      currentLine.push(item);
      lastY = item.y;
      lastCi = item.ci;
    }
    if (currentLine.length > 0) {
      allLines.push({
        lineText: currentLine.map(function (c) { return c.text; }).join(""),
        lineChars: currentLine.slice(),
      });
    }

    // Remove consecutive duplicate lines (multi-pass render of same line)
    var cleanLines = [];
    var lastLineKey = "";
    for (var i = 0; i < allLines.length; i++) {
      var ln = allLines[i];
      var firstCi = ln.lineChars.length ? ln.lineChars[0].ci : -1;
      var lineKey = firstCi + "|" + ln.lineText;
      if (lineKey !== lastLineKey) { cleanLines.push(ln); lastLineKey = lineKey; }
    }

    var textParts = [];
    var finalChars = [];
    for (var i = 0; i < cleanLines.length; i++) {
      textParts.push(cleanLines[i].lineText);
      for (var j = 0; j < cleanLines[i].lineChars.length; j++) {
        finalChars.push(cleanLines[i].lineChars[j]);
      }
    }
    return { text: textParts.join("\n"), chars: finalChars };
  };
})();
