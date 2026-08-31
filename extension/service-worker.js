"use strict";

const PROTOCOL_VERSION = 7;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&followup=https%3A%2F%2Fgemini.google.com%2Fapp";
const NATIVE_HOST = "com.senkira.gemini_extension_agent";
const FIREBASE_API_KEY = "AIzaSyBAmRwEIELh_AA7E1omzf8TrVV3Cp4HPFc";
const POC_AUTH_EMAIL = "o1234567@poc.invalid";
const RUN_TTL_MS = 10 * 60 * 1000;
const AUTOMATION_RETRY_LIMIT = 20;
const AUTOMATION_RETRY_MS = 250;
const runs = new Map();
const tabToRequest = new Map();
const automationLocks = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRequestId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isAllowedExternalSender(sender) {
  if (!sender || sender.frameId !== 0 || typeof sender.url !== "string") {
    return false;
  }
  try {
    return new URL(sender.url).origin === ALLOWED_ORIGIN;
  } catch {
    return false;
  }
}

function publicRun(run) {
  if (!run) {
    return null;
  }
  return {
    requestId: run.requestId,
    stage: run.stage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    windowId: Number.isInteger(run.windowId) ? run.windowId : null,
    tabId: Number.isInteger(run.tabId) ? run.tabId : null,
    incognito: run.incognito === true,
    observedOrigin: run.observedOrigin || null,
    targetAccountConfirmed: run.targetAccountConfirmed === true,
    identityCheckComplete: run.identityCheckComplete === true,
    credentialDelivered: run.credentialDelivered === true,
    closed: run.closed === true,
    note: run.note || null
  };
}

function updateRun(run, patch) {
  Object.assign(run, patch, { updatedAt: Date.now() });
  return run;
}

function getRun(requestId) {
  const run = runs.get(requestId);
  if (!run) {
    return null;
  }
  if (Date.now() - run.createdAt > RUN_TTL_MS) {
    runs.delete(requestId);
    if (Number.isInteger(run.tabId)) {
      tabToRequest.delete(run.tabId);
    }
    return null;
  }
  return run;
}

async function pingExtension() {
  const incognitoAccessAllowed = await new Promise((resolve) => {
    if (typeof chrome.extension?.isAllowedIncognitoAccess !== "function") {
      resolve(false);
      return;
    }
    chrome.extension.isAllowedIncognitoAccess((allowed) => resolve(allowed === true));
  });
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    protocolVersion: PROTOCOL_VERSION,
    capability: "EXTENSION_AGENT_ONE_SHOT_BRIDGE",
    incognitoAccessAllowed
  };
}

async function verifyPocIdToken(idToken) {
  if (typeof idToken !== "string" || idToken.length < 100 || idToken.length > 4096) {
    throw new Error("POC_AUTH_REQUIRED");
  }
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );
  if (!response.ok) {
    throw new Error("POC_AUTH_REQUIRED");
  }
  const payload = await response.json();
  const user = Array.isArray(payload?.users) ? payload.users[0] : null;
  if (!user
      || typeof user.localId !== "string"
      || user.localId.length === 0
      || user.email?.toLowerCase() !== POC_AUTH_EMAIL) {
    throw new Error("POC_AUTH_REQUIRED");
  }
  return user.localId;
}

async function startAgent(message) {
  if (message.version !== PROTOCOL_VERSION
      || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  let pocUid;
  try {
    pocUid = await verifyPocIdToken(message.pocIdToken);
  } catch {
    return { ok: false, error: "POC_AUTH_REQUIRED" };
  }
  const existing = getRun(message.requestId);
  if (existing) {
    return existing.pocUid === pocUid
      ? { ok: true, run: publicRun(existing), replayed: true }
      : { ok: false, error: "POC_AUTH_REQUIRED" };
  }

  const run = {
    requestId: message.requestId,
    stage: "OPENING_ISOLATED_WINDOW",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    incognito: true,
    observedOrigin: null,
    targetAccountConfirmed: false,
    identityCheckComplete: false,
    credentialDelivered: false,
    pocUid,
    closed: false,
    note: "Starting the extension agent in a minimized InPrivate window."
  };
  runs.set(run.requestId, run);

  try {
    const createdWindow = await chrome.windows.create({
      url: LOGIN_URL,
      type: "normal",
      incognito: true,
      focused: false,
      state: "minimized"
    });
    const tab = createdWindow.tabs?.[0];
    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error("Browser did not return the isolated Google tab.");
    }
    run.windowId = createdWindow.id;
    run.tabId = tab.id;
    tabToRequest.set(tab.id, run.requestId);
    updateRun(run, {
      stage: "ISOLATED_WINDOW_CREATED",
      note: "The isolated window is hidden while the extension agent authenticates."
    });
    return { ok: true, run: publicRun(run), replayed: false };
  } catch (error) {
    updateRun(run, {
      stage: "OPEN_FAILED",
      note: error instanceof Error ? error.message : "Could not open the isolated window."
    });
    return { ok: false, error: "OPEN_FAILED", run: publicRun(run) };
  }
}

function inspectGooglePage(targetEmail) {
  function exactAccountEvidence(email) {
    const normalizedEmail = email.toLowerCase();
    const values = Array.from(document.querySelectorAll(
      "[data-profile-identifier],[data-email],[data-identifier],[role='link'][aria-label]"
    )).flatMap((element) => [
      element.getAttribute("data-profile-identifier"),
      element.getAttribute("data-email"),
      element.getAttribute("data-identifier"),
      element.getAttribute("aria-label")
    ]).filter(Boolean);
    const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
    const emails = [...new Set(values.flatMap((value) => value.match(pattern) || [])
      .map((value) => value.toLowerCase()))];
    return emails.length === 1 && emails[0] === normalizedEmail;
  }
  const normalized = targetEmail.toLowerCase();
  const path = location.pathname;
  const challenge = Boolean(document.querySelector(
    "iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']"
  ));
  if (challenge || (/\/challenge\//.test(path) && !/\/challenge\/pwd(?:\/|$)/.test(path))) {
    return { step: "USER_ACTION_REQUIRED" };
  }

  const passwordInput = document.querySelector("input[name='Passwd'], input[type='password']");
  if (passwordInput && /\/challenge\/pwd(?:\/|$)/.test(path)) {
    return exactAccountEvidence(targetEmail)
      ? { step: "PASSWORD_REQUIRED" }
      : { step: "TARGET_ACCOUNT_NOT_CONFIRMED" };
  }

  const targetAccount = Array.from(document.querySelectorAll("[data-identifier]")).find((element) =>
    (element.getAttribute("data-identifier") || "").toLowerCase() === normalized
  );
  if (targetAccount) {
    (targetAccount.closest("a,[role='link']") || targetAccount).click();
    return { step: "ACCOUNT_SELECTED" };
  }

  const emailInput = document.querySelector("#identifierId, input[type='email'], input[name='identifier']");
  if (emailInput) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(emailInput, targetEmail); else emailInput.value = targetEmail;
    emailInput.dispatchEvent(new Event("input", { bubbles: true }));
    emailInput.dispatchEvent(new Event("change", { bubbles: true }));
    const next = document.querySelector("#identifierNext button, #identifierNext, button[type='submit']");
    if (next) {
      next.click();
      return { step: "EMAIL_SUBMITTED" };
    }
  }
  return { step: "WAITING_FOR_SUPPORTED_FORM" };
}

function submitPassword(targetEmail, password) {
  function exactAccountEvidence(email) {
    const normalizedEmail = email.toLowerCase();
    const values = Array.from(document.querySelectorAll(
      "[data-profile-identifier],[data-email],[data-identifier],[role='link'][aria-label]"
    )).flatMap((element) => [
      element.getAttribute("data-profile-identifier"),
      element.getAttribute("data-email"),
      element.getAttribute("data-identifier"),
      element.getAttribute("aria-label")
    ]).filter(Boolean);
    const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
    const emails = [...new Set(values.flatMap((value) => value.match(pattern) || [])
      .map((value) => value.toLowerCase()))];
    return emails.length === 1 && emails[0] === normalizedEmail;
  }
  if (!/\/challenge\/pwd(?:\/|$)/.test(location.pathname)) {
    return { step: "STALE_PASSWORD_DOCUMENT" };
  }
  if (document.querySelector("iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']")) {
    return { step: "USER_ACTION_REQUIRED" };
  }
  if (!exactAccountEvidence(targetEmail)) {
    return { step: "TARGET_ACCOUNT_NOT_CONFIRMED" };
  }
  const input = document.querySelector("input[name='Passwd'], input[type='password']");
  const next = document.querySelector("#passwordNext button, #passwordNext");
  if (!input || !next || typeof password !== "string" || password.length === 0) {
    return { step: "PASSWORD_FORM_UNAVAILABLE" };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, password); else input.value = password;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  next.click();
  return { step: "PASSWORD_SUBMITTED" };
}

async function fetchOneShotCredential(run) {
  const payload = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "getCredential",
    requestId: run.requestId
  });
  if (payload?.ok !== true
      || typeof payload.email !== "string"
      || payload.email.toLowerCase() !== TARGET_EMAIL
      || typeof payload.password !== "string"
      || payload.password.length === 0) {
    throw new Error(payload?.error || "Credential bridge returned an invalid target credential.");
  }
  return payload;
}

async function closeFailedWindow(run) {
  if (Number.isInteger(run.windowId)) {
    await chrome.windows.remove(run.windowId).catch(() => {});
  }
}

async function failRun(run, stage, note) {
  updateRun(run, { stage, note, identityCheckComplete: true });
  await closeFailedWindow(run);
}

async function automateGoogle(run, tabId) {
  const existing = automationLocks.get(tabId);
  if (existing) return existing;
  const operation = (async () => {
    for (let attempt = 0; attempt < AUTOMATION_RETRY_LIMIT; attempt += 1) {
      if (run.closed || run.tabId !== tabId) return;
      let result;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId }, func: inspectGooglePage, args: [TARGET_EMAIL]
        });
        result = results?.[0]?.result;
      } catch {
        await delay(AUTOMATION_RETRY_MS);
        continue;
      }
      const step = result?.step || "WAITING_FOR_SUPPORTED_FORM";
      if (step === "WAITING_FOR_SUPPORTED_FORM") {
        await delay(AUTOMATION_RETRY_MS);
        continue;
      }
      if (step === "USER_ACTION_REQUIRED" || step === "TARGET_ACCOUNT_NOT_CONFIRMED") {
        await failRun(run, step, step === "USER_ACTION_REQUIRED"
          ? "Google requested MFA, CAPTCHA, device approval, or another interactive challenge."
          : "The password page was not bound to the exact target account.");
        return;
      }
      if (step !== "PASSWORD_REQUIRED") {
        updateRun(run, { stage: step, note: null });
        return;
      }

      updateRun(run, {
        stage: "FETCHING_ONE_SHOT_CREDENTIAL",
        note: "Requesting the target credential from the local one-shot bridge."
      });
      let credential;
      try {
        credential = await fetchOneShotCredential(run);
        updateRun(run, { credentialDelivered: true });
        const results = await chrome.scripting.executeScript({
          target: { tabId }, func: submitPassword, args: [TARGET_EMAIL, credential.password]
        });
        const passwordStep = results?.[0]?.result?.step || "PASSWORD_FORM_UNAVAILABLE";
        credential.password = "";
        credential = null;
        if (passwordStep === "PASSWORD_SUBMITTED") {
          updateRun(run, {
            stage: "PASSWORD_SUBMITTED",
            note: "The one-shot credential was submitted and discarded from extension memory."
          });
          return;
        }
        await failRun(run, passwordStep, "The exact Google password form could not be submitted safely.");
        return;
      } catch (error) {
        if (credential) credential.password = "";
        credential = null;
        await failRun(run, "CREDENTIAL_BRIDGE_FAILED",
          error instanceof Error ? error.message : "The one-shot credential bridge failed.");
        return;
      }
    }
    await failRun(run, "GOOGLE_PAGE_UNRECOGNIZED", "Google did not expose a supported login document in time.");
  })();
  automationLocks.set(tabId, operation);
  try {
    await operation;
  } finally {
    if (automationLocks.get(tabId) === operation) automationLocks.delete(tabId);
  }
}

async function handleNavigation(details) {
  if (details.frameId !== 0) return;
  const requestId = tabToRequest.get(details.tabId);
  const run = requestId ? getRun(requestId) : null;
  if (!run || run.closed) return;
  let url;
  try { url = new URL(details.url); } catch { return; }
  updateRun(run, { observedOrigin: url.origin });
  if (url.origin === "https://accounts.google.com") {
    updateRun(run, { stage: "GOOGLE_LOGIN_PAGE", note: null });
    await automateGoogle(run, details.tabId);
  } else if (url.origin === "https://gemini.google.com") {
    updateRun(run, {
      stage: "GEMINI_DOCUMENT_LOADING",
      note: "Gemini loaded; waiting for exact account confirmation."
    });
  }
}

function injectPrompt(prompt) {
  const candidate = document.querySelector("div[contenteditable='true'][role='textbox'], textarea[aria-label], textarea");
  if (!candidate) return { ok: false, error: "PROMPT_BOX_NOT_FOUND" };
  candidate.focus();
  if (candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(candidate), "value")?.set;
    if (setter) setter.call(candidate, prompt); else candidate.value = prompt;
    candidate.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    candidate.textContent = prompt;
    candidate.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  }
  const send = document.querySelector("button[aria-label*='Send' i], button[aria-label*='ส่ง' i], button[data-test-id*='send' i]");
  if (!send || send.disabled) return { ok: false, error: "SEND_BUTTON_NOT_READY" };
  send.click();
  return { ok: true };
}

async function postPrompt(message) {
  const run = getRun(message.requestId);
  if (!run || run.stage !== "GEMINI_TARGET_ACCOUNT_CONFIRMED" || !run.targetAccountConfirmed) {
    return { ok: false, error: "GEMINI_NOT_READY" };
  }
  let pocUid;
  try {
    pocUid = await verifyPocIdToken(message.pocIdToken);
  } catch {
    return { ok: false, error: "POC_AUTH_REQUIRED" };
  }
  if (run.pocUid !== pocUid) {
    return { ok: false, error: "POC_AUTH_REQUIRED" };
  }
  if (typeof message.prompt !== "string" || message.prompt.length === 0 || message.prompt.length > 4000) {
    return { ok: false, error: "INVALID_PROMPT" };
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: run.tabId }, func: injectPrompt, args: [message.prompt]
  });
  const result = results?.[0]?.result || { ok: false, error: "PROMPT_SUBMIT_FAILED" };
  if (result.ok) updateRun(run, { stage: "PROMPT_SUBMITTED", note: "The prompt was posted to the confirmed Gemini session." });
  return { ...result, run: publicRun(run) };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isAllowedExternalSender(sender)) {
    sendResponse({ ok: false, error: "UNTRUSTED_SENDER" });
    return false;
  }
  const task = message?.type === "PING" ? pingExtension()
    : message?.type === "START_AGENT" ? startAgent(message)
      : message?.type === "GET_STATUS" ? Promise.resolve({ ok: true, run: publicRun(getRun(message.requestId)) })
        : message?.type === "POST_PROMPT" ? postPrompt(message)
          : Promise.resolve({ ok: false, error: "UNKNOWN_MESSAGE" });
  task.then(sendResponse).catch((error) => sendResponse({
    ok: false, error: error instanceof Error ? error.message : "EXTENSION_ERROR"
  }));
  return true;
});

chrome.webNavigation.onCompleted.addListener((details) => { handleNavigation(details).catch(() => {}); });
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const requestId = tabToRequest.get(details.tabId);
  const run = requestId ? getRun(requestId) : null;
  if (!run || run.closed) return;
  try { updateRun(run, { observedOrigin: new URL(details.url).origin }); } catch { /* ignored */ }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GEMINI_DOCUMENT_SIGNAL"
      || message.version !== PROTOCOL_VERSION
      || typeof message.targetAccountObserved !== "boolean"
      || typeof message.identityCheckComplete !== "boolean"
      || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id)
      || sender.tab.incognito !== true) {
    return false;
  }
  const requestId = tabToRequest.get(sender.tab.id);
  const run = requestId ? getRun(requestId) : null;
  if (!run || run.closed) {
    sendResponse({ ok: false });
    return false;
  }
  let origin;
  try { origin = new URL(sender.url).origin; } catch { sendResponse({ ok: false }); return false; }
  if (origin !== "https://gemini.google.com") {
    sendResponse({ ok: false });
    return false;
  }
  if (message.targetAccountObserved) {
    updateRun(run, {
      stage: "GEMINI_TARGET_ACCOUNT_CONFIRMED",
      targetAccountConfirmed: true,
      identityCheckComplete: true,
      note: "Gemini rendered the exact target account."
    });
    chrome.windows.update(run.windowId, { state: "normal", focused: true }).catch(() => {});
  } else if (message.identityCheckComplete && !run.targetAccountConfirmed) {
    failRun(run, "GEMINI_TARGET_ACCOUNT_NOT_CONFIRMED", "Gemini loaded with an unconfirmed account.").catch(() => {});
  }
  sendResponse({ ok: true, confirmed: run.targetAccountConfirmed, complete: run.identityCheckComplete });
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const requestId = tabToRequest.get(tabId);
  if (!requestId) return;
  const run = getRun(requestId);
  if (run) updateRun(run, { closed: true, stage: "TAB_CLOSED" });
  tabToRequest.delete(tabId);
});
