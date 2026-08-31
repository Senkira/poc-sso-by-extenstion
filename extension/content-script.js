"use strict";

const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const MAX_IDENTITY_ATTEMPTS = 20;

function targetAccountIsVisible() {
  const normalized = TARGET_EMAIL.toLowerCase();
  const machineReadableMatch = Array.from(document.querySelectorAll("[data-email],[data-identifier]")).some((node) => {
    const declared = node.getAttribute("data-email") || node.getAttribute("data-identifier") || "";
    return declared.trim().toLowerCase() === normalized;
  });
  if (machineReadableMatch) {
    return true;
  }

  const accountControls = document.querySelectorAll([
    "a[href*='accounts.google.com/SignOutOptions'][aria-label]",
    "a[href*='accounts.google.com/AccountChooser'][aria-label]",
    "button[data-ogsr-up][aria-label]",
    "[role='button'][data-ogsr-up][aria-label]"
  ].join(","));
  return Array.from(accountControls).some((node) => {
    const label = node.getAttribute("aria-label") || "";
    const emailTokens = label.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi) || [];
    return emailTokens.some((email) => email.toLowerCase() === normalized);
  });
}

async function reportGeminiDocument(attempt = 0) {
  const targetAccountObserved = targetAccountIsVisible();
  const identityCheckComplete = targetAccountObserved || attempt >= MAX_IDENTITY_ATTEMPTS;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GEMINI_DOCUMENT_SIGNAL",
      version: 8,
      origin: location.origin,
      readyState: document.readyState,
      targetAccountObserved,
      identityCheckComplete
    });
    if ((!response?.ok || !response.confirmed) && !identityCheckComplete) {
      setTimeout(() => reportGeminiDocument(attempt + 1), Math.min(1000, 250 * (attempt + 1)));
    }
  } catch {
    if (!identityCheckComplete) {
      setTimeout(() => reportGeminiDocument(attempt + 1), Math.min(1000, 250 * (attempt + 1)));
    }
  }
}

if (document.readyState === "complete") {
  reportGeminiDocument();
} else {
  window.addEventListener("load", () => void reportGeminiDocument(0), { once: true });
}
