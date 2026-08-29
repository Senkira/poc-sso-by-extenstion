"use strict";

function reportGeminiDocument() {
  chrome.runtime.sendMessage({
    type: "GEMINI_DOCUMENT_SIGNAL",
    version: 1,
    origin: location.origin,
    readyState: document.readyState
  }).catch(() => {});
}

if (document.readyState === "complete") {
  reportGeminiDocument();
} else {
  window.addEventListener("load", reportGeminiDocument, { once: true });
}

