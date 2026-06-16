// ============================================================
// WeRead Hook - runs in page's MAIN world at document_start
// Intercepts CanvasRenderingContext2D.fillText to capture book text + per-char
// coordinates. GET_TEXT returns chars for canvases currently in the DOM
// (filtered by canvas unique id).
// ============================================================

;(function () {
  window.__RA_HOOK_LOADED = true;
  window.__RA_CANVAS_LINES = [];

  // ---- canvas → unique id mapping ----
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

  // ---- fillText intercept ----
  var origFillText = CanvasRenderingContext2D.prototype.fillText;

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
      var fm = this.font && this.font.match(/(\d+(?:\.\d+)?)px/);
      if (fm) fs = parseFloat(fm[1]);
      var cid = canvasIdOf(this);
      var col = "";
      try { col = String(this.fillStyle || "").replace(/\s/g, ""); } catch (e) {}
      if (text.length === 1) {
        window.__RA_CANVAS_LINES.push({ text: text, x: tx, y: ty, fs: fs, cid: cid, col: col });
      } else {
        var charWidth = fs;
        try { charWidth *= this.getTransform().a; } catch (e) {}
        for (var ci = 0; ci < text.length; ci++) {
          window.__RA_CANVAS_LINES.push({
            text: text[ci], x: tx + ci * charWidth, y: ty, fs: fs, cid: cid, col: col,
          });
        }
      }
    }
    return origFillText.apply(this, arguments);
  };

  // ---- GET_TEXT: return chars for canvases currently in DOM ----
  window.__RA_GET_TEXT = function () {
    var liveCids = {};
    document.querySelectorAll("canvas[data-ra-cid]").forEach(function (c) {
      liveCids[c.getAttribute("data-ra-cid")] = true;
    });
    var all = window.__RA_CANVAS_LINES.filter(function (c) {
      return liveCids[String(c.cid >>> 0)];
    });
    if (!all || !all.length) return { text: "", chars: [] };

    // Recompute positional indices for overlay positioning
    var root = document.querySelector(".wr_canvasContainer, .renderTargetContainer");
    var scope = root || document;
    var canvases = scope.querySelectorAll("canvas");
    for (var i = 0; i < canvases.length; i++) {
      try { canvases[i].setAttribute("data-ra-cidx", String(i)); } catch (e) {}
    }

    // Build cid→ci map (sorted by cid = reading order)
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
      all[i].ci = cidToCi[all[i].cid >>> 0] !== undefined ? cidToCi[all[i].cid >>> 0] : 0;
      items.push(all[i]);
    }
    if (!items.length) return { text: "", chars: [] };

    // Dedup by canvas id + position + text
    var deduped = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var key = (items[i].cid >>> 0) + "|" + items[i].text + "|" +
        Math.round(items[i].y / 5) + "|" + Math.round(items[i].x / 5);
      if (!seen[key]) { seen[key] = true; deduped.push(items[i]); }
    }

    // Group into lines by Y proximity; break on canvas change
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

    // Remove consecutive duplicate lines
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
