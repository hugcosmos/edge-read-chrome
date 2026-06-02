// Loaded by content script into the page context (MAIN world).
// Reads captured canvas text + character coordinates from weread-hook.js
// and posts them back. Does NOT clear — dedup handles multi-pass renders,
// and hook resets __RA_CANVAS_LINES on page load.
;(function () {
  var result = window.__RA_GET_TEXT ? window.__RA_GET_TEXT() : { text: "", chars: [] };
  window.postMessage({
    type: "readaloud-weread-text",
    text: result.text || "",
    chars: result.chars || []
  }, "*");
})();
