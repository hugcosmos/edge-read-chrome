// ============================================================
// WeRead Hook - runs in page's MAIN world at document_start
// Intercepts CanvasRenderingContext2D.fillText to capture
// book text. Uses getTransform() to compute real positions.
// Returns {text, chars} where chars[] maps 1:1 to the text.
// ============================================================

;(function () {
  window.__RA_HOOK_LOADED = true;
  window.__RA_CANVAS_LINES = [];
  window.__RA_CANVAS_DONE = false;

  var origFillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
    if (text && typeof text === "string" && text.trim()) {
      // Skip font measurement strings
      if (text.length > 30 && /^[\x20-\x7e]+$/.test(text)) {
        return origFillText.apply(this, arguments);
      }
      // Apply current canvas transform to get real pixel position
      var tx = x, ty = y;
      try {
        var t = this.getTransform();
        tx = t.a * x + t.c * y + t.e;
        ty = t.b * x + t.d * y + t.f;
      } catch (e) {}
      // Capture font size for accurate overlay positioning
      var fs = 16;
      var fm = this.font && this.font.match(/(\d+)px/);
      if (fm) fs = parseInt(fm[1], 10);
      // Split multi-char fillText into individual char entries for 1:1 mapping
      if (text.length === 1) {
        window.__RA_CANVAS_LINES.push({ text: text, x: tx, y: ty, fs: fs });
      } else {
        var charWidth = fs;
        try { charWidth *= this.getTransform().a; } catch (e) {}
        for (var ci = 0; ci < text.length; ci++) {
          window.__RA_CANVAS_LINES.push({ text: text[ci], x: tx + ci * charWidth, y: ty, fs: fs });
        }
      }
    }
    return origFillText.apply(this, arguments);
  };

  var origRestore = CanvasRenderingContext2D.prototype.restore;
  CanvasRenderingContext2D.prototype.restore = function () {
    var result = origRestore.apply(this, arguments);
    window.__RA_CANVAS_DONE = true;
    return result;
  };

  // Returns { text: "...\n...", chars: [{text,x,y}, ...] }
  // chars[] maps 1:1 to text.replace(/\n/g, "")
  window.__RA_GET_TEXT = function () {
    var items = window.__RA_CANVAS_LINES;
    if (!items || !items.length) return { text: "", chars: [] };

    // WeRead renders character-by-character in reading order (top-to-bottom,
    // left-to-right). We verified this — sorting BREAKS the order.
    // Process in render order, deduplicate by position to remove multi-pass renders.

    var deduped = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      // Same character at same position (5px bucket) = duplicate render
      var key = items[i].text + "|" + Math.round(items[i].y / 5) + "|" + Math.round(items[i].x / 5);
      if (!seen[key]) {
        seen[key] = true;
        deduped.push(items[i]);
      }
    }

    // Group into lines by Y proximity (render order is top-to-bottom)
    var allLines = [];
    var currentLine = [];
    var lastY = null;

    for (var i = 0; i < deduped.length; i++) {
      var item = deduped[i];
      if (lastY !== null && Math.abs(item.y - lastY) > 5) {
        allLines.push({
          lineText: currentLine.map(function (c) { return c.text; }).join(""),
          lineChars: currentLine.slice()
        });
        currentLine = [];
      }
      currentLine.push(item);
      lastY = item.y;
    }
    if (currentLine.length > 0) {
      allLines.push({
        lineText: currentLine.map(function (c) { return c.text; }).join(""),
        lineChars: currentLine.slice()
      });
    }

    // Remove consecutive duplicate lines
    var cleanLines = [];
    for (var i = 0; i < allLines.length; i++) {
      if (cleanLines.length === 0 || allLines[i].lineText !== cleanLines[cleanLines.length - 1].lineText) {
        cleanLines.push(allLines[i]);
      }
    }

    // Build text and chars arrays
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
