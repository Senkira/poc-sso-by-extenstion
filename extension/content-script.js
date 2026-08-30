"use strict";

async function reportGeminiDocument(attempt = 0) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GEMINI_DOCUMENT_SIGNAL",
      version: 2,
      origin: location.origin,
      readyState: document.readyState
    });
    if (!response?.ok && attempt < 4) {
      setTimeout(() => reportGeminiDocument(attempt + 1), 100 * (attempt + 1));
    }
  } catch {
    if (attempt < 4) {
      setTimeout(() => reportGeminiDocument(attempt + 1), 100 * (attempt + 1));
    }
  }
}

if (document.readyState === "complete") {
  reportGeminiDocument();
} else {
  window.addEventListener("load", () => void reportGeminiDocument(0), { once: true });
}
