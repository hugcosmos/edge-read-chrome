// Loaded by content script into the page context (MAIN world).
// Calls __RA_GET_TEXT and posts the result back.
;(function () {
  var result = window.__RA_GET_TEXT ? window.__RA_GET_TEXT() : { text: "", chars: [] };
  window.postMessage({
    type: "readaloud-weread-text",
    text: result.text || "",
    chars: result.chars || []
  }, "*");
})();
