"use strict";

const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const MAX_IDENTITY_ATTEMPTS = 8;

function targetAccountIsVisible() {
  const normalized = TARGET_EMAIL.toLowerCase();
  return Array.from(document.querySelectorAll("[aria-label],[title],[data-email],[data-identifier]")).some((node) => {
    const candidates = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-email"),
      node.getAttribute("data-identifier")
    ];
    return candidates.some((candidate) => typeof candidate === "string"
      && candidate.toLowerCase().includes(normalized));
  });
}

async function reportGeminiDocument(attempt = 0) {
  const targetAccountObserved = targetAccountIsVisible();
  const identityCheckComplete = targetAccountObserved || attempt >= MAX_IDENTITY_ATTEMPTS;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GEMINI_DOCUMENT_SIGNAL",
      version: 3,
      origin: location.origin,
      readyState: document.readyState,
      targetAccountObserved,
      identityCheckComplete
    });
    if ((!response?.ok || !response.confirmed) && !identityCheckComplete) {
      setTimeout(() => reportGeminiDocument(attempt + 1), 250 * (attempt + 1));
    }
  } catch {
    if (!identityCheckComplete) {
      setTimeout(() => reportGeminiDocument(attempt + 1), 250 * (attempt + 1));
    }
  }
}

if (document.readyState === "complete") {
  reportGeminiDocument();
} else {
  window.addEventListener("load", () => void reportGeminiDocument(0), { once: true });
}
