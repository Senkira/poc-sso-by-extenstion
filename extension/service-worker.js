"use strict";

const PROTOCOL_VERSION = 10;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&followup=https%3A%2F%2Fgemini.google.com%2Fapp";
const GEMINI_URL = "https://gemini.google.com/app";
const CREDENTIAL_BROKER_URL = "https://us-central1-poc-after-sso-login-gemini.cloudfunctions.net/credentialBroker";
const FIREBASE_API_KEY = "AIzaSyBAmRwEIELh_AA7E1omzf8TrVV3Cp4HPFc";
const POC_AUTH_EMAIL = "o1234567@poc.invalid";
const POC_USERNAME = "O1234567";
const POC_FIREBASE_UID = "VHX1QkrsewSrrWB0g3BjyHepdWX2";
const SESSION_STATE_KEY = "geminiExtensionAgentV10";
const RUN_TTL_MS = 20 * 60 * 1000;
const AUTOMATION_RETRY_LIMIT = 60;
const AUTOMATION_RETRY_MS = 500;
const AUTH_TIMEOUT_MINUTES = 15;
const BROKER_TIMEOUT_MS = 20000;
const SCRIPT_TIMEOUT_MS = 20000;
const PROMPT_CONFIRM_TIMEOUT_MS = 15000;
const runs = new Map();
const tabToRequest = new Map();
const automationLocks = new Map();
let stateReady = null;
let persistTail = Promise.resolve();
let startAgentTail = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, errorCode) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

function authAlarmName(requestId) {
  return `gemini-auth-timeout:${requestId}`;
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
    authTabId: Number.isInteger(run.authTabId) ? run.authTabId : null,
    geminiTabId: Number.isInteger(run.geminiTabId) ? run.geminiTabId : null,
    incognito: run.incognito === true,
    observedOrigin: run.observedOrigin || null,
    targetAccountConfirmed: run.targetAccountConfirmed === true,
    identityCheckComplete: run.identityCheckComplete === true,
    credentialDelivered: run.credentialDelivered === true,
    credentialSubmitted: run.credentialSubmitted === true,
    credentialState: typeof run.credentialState === "string" ? run.credentialState : "NOT_REQUESTED",
    closed: run.closed === true,
    note: run.note || null
  };
}

function persistedRun(run) {
  return {
    ...publicRun(run),
    pocUid: typeof run.pocUid === "string" ? run.pocUid : null,
    brokerIdToken: typeof run.brokerIdToken === "string" ? run.brokerIdToken : null,
    currentDocumentId: typeof run.currentDocumentId === "string" ? run.currentDocumentId : null,
    geminiDocumentId: typeof run.geminiDocumentId === "string" ? run.geminiDocumentId : null,
    confirmedDocumentId: typeof run.confirmedDocumentId === "string" ? run.confirmedDocumentId : null,
    currentUrl: typeof run.currentUrl === "string" ? run.currentUrl : null,
    geminiCurrentUrl: typeof run.geminiCurrentUrl === "string" ? run.geminiCurrentUrl : null,
    geminiReloaded: run.geminiReloaded === true,
    googleSessionEstablished: run.googleSessionEstablished === true,
    geminiReadyForIdentityFailure: run.geminiReadyForIdentityFailure === true
  };
}

async function hydrateState() {
  if (!chrome.storage?.session) {
    throw new Error("SESSION_STORAGE_UNAVAILABLE");
  }
  const data = await chrome.storage.session.get(SESSION_STATE_KEY);
  const savedRuns = Array.isArray(data?.[SESSION_STATE_KEY]?.runs)
    ? data[SESSION_STATE_KEY].runs
    : [];
  for (const saved of savedRuns) {
    if (!isRequestId(saved?.requestId)
        || !Number.isFinite(saved.createdAt)
        || Date.now() - saved.createdAt > RUN_TTL_MS
        || typeof saved.pocUid !== "string") {
      continue;
    }
    const run = {
      requestId: saved.requestId,
      stage: typeof saved.stage === "string" ? saved.stage : "STATE_RECOVERY_FAILED",
      createdAt: saved.createdAt,
      updatedAt: Number.isFinite(saved.updatedAt) ? saved.updatedAt : saved.createdAt,
      windowId: Number.isInteger(saved.windowId) ? saved.windowId : null,
      tabId: Number.isInteger(saved.tabId) ? saved.tabId : null,
      authTabId: Number.isInteger(saved.authTabId)
        ? saved.authTabId
        : Number.isInteger(saved.tabId) ? saved.tabId : null,
      geminiTabId: Number.isInteger(saved.geminiTabId) ? saved.geminiTabId : null,
      incognito: saved.incognito === true,
      observedOrigin: typeof saved.observedOrigin === "string" ? saved.observedOrigin : null,
      targetAccountConfirmed: saved.targetAccountConfirmed === true,
      identityCheckComplete: saved.identityCheckComplete === true,
      credentialDelivered: saved.credentialDelivered === true,
      credentialSubmitted: saved.credentialSubmitted === true,
      credentialState: ["NOT_REQUESTED", "REQUESTING", "CONSUMED"].includes(saved.credentialState)
        ? saved.credentialState
        : saved.credentialDelivered === true ? "CONSUMED" : "NOT_REQUESTED",
      pocUid: saved.pocUid,
      brokerIdToken: typeof saved.brokerIdToken === "string" ? saved.brokerIdToken : null,
      currentDocumentId: typeof saved.currentDocumentId === "string" ? saved.currentDocumentId : null,
      geminiDocumentId: typeof saved.geminiDocumentId === "string" ? saved.geminiDocumentId : null,
      confirmedDocumentId: typeof saved.confirmedDocumentId === "string" ? saved.confirmedDocumentId : null,
      currentUrl: typeof saved.currentUrl === "string" ? saved.currentUrl : null,
      geminiCurrentUrl: typeof saved.geminiCurrentUrl === "string" ? saved.geminiCurrentUrl : null,
      geminiReloaded: saved.geminiReloaded === true,
      googleSessionEstablished: saved.googleSessionEstablished === true,
      geminiReadyForIdentityFailure: saved.geminiReadyForIdentityFailure === true,
      closed: saved.closed === true,
      note: typeof saved.note === "string" ? saved.note : null
    };
    runs.set(run.requestId, run);
    if (!run.closed && Number.isInteger(run.tabId)) {
      tabToRequest.set(run.tabId, run.requestId);
    }
    if (!run.closed && Number.isInteger(run.geminiTabId)) {
      tabToRequest.set(run.geminiTabId, run.requestId);
    }
  }
}

function ensureStateReady() {
  if (!stateReady) {
    stateReady = hydrateState();
  }
  return stateReady;
}

function persistState() {
  const state = {
    runs: Array.from(runs.values())
      .filter((run) => Date.now() - run.createdAt <= RUN_TTL_MS)
      .map(persistedRun)
  };
  persistTail = persistTail
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [SESSION_STATE_KEY]: state }));
  return persistTail;
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
    if (Number.isInteger(run.geminiTabId)) {
      tabToRequest.delete(run.geminiTabId);
    }
    void persistState();
    return null;
  }
  return run;
}

function purgeExpiredRuns() {
  let changed = false;
  for (const [requestId, run] of runs.entries()) {
    if (Date.now() - run.createdAt <= RUN_TTL_MS) continue;
    runs.delete(requestId);
    if (Number.isInteger(run.tabId)) {
      tabToRequest.delete(run.tabId);
    }
    if (Number.isInteger(run.geminiTabId)) {
      tabToRequest.delete(run.geminiTabId);
    }
    changed = true;
  }
  return changed;
}

async function isIncognitoAccessAllowed() {
  return new Promise((resolve) => {
    if (typeof chrome.extension?.isAllowedIncognitoAccess !== "function") {
      resolve(false);
      return;
    }
    chrome.extension.isAllowedIncognitoAccess((allowed) => resolve(allowed === true));
  });
}

async function pingExtension() {
  const incognitoAccessAllowed = await isIncognitoAccessAllowed();
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    protocolVersion: PROTOCOL_VERSION,
    capability: "EXTENSION_AGENT_HTTPS_BROKER",
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
      || user.localId !== POC_FIREBASE_UID
      || user.email?.toLowerCase() !== POC_AUTH_EMAIL) {
    throw new Error("POC_AUTH_REQUIRED");
  }
  return user.localId;
}

async function authenticatePoc(message) {
  if (message.version !== PROTOCOL_VERSION
      || !isRequestId(message.requestId)
      || typeof message.username !== "string"
      || message.username.trim().toUpperCase() !== POC_USERNAME) {
    return { ok: false, error: "INVALID_POC_CREDENTIAL" };
  }

  let authorization;
  try {
    authorization = await callCredentialBroker({
      action: "authenticatePoc",
      requestId: message.requestId,
      username: POC_USERNAME,
      version: PROTOCOL_VERSION
    });
    if (authorization?.ok !== true
        || typeof authorization.username !== "string"
        || authorization.username.toUpperCase() !== POC_USERNAME
        || typeof authorization.idToken !== "string") {
      throw new Error("POC_BROKER_AUTH_FAILED");
    }
    await verifyPocIdToken(authorization.idToken);
    const expiresIn = Number(authorization.expiresIn);
    const idToken = authorization.idToken;
    authorization.idToken = "";
    authorization = null;
    return {
      ok: true,
      idToken,
      expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600,
      username: POC_USERNAME
    };
  } catch (error) {
    if (authorization?.idToken) authorization.idToken = "";
    authorization = null;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "POC_BROKER_AUTH_FAILED"
    };
  }
}

async function startAgentUnlocked(message) {
  try {
    await ensureStateReady();
  } catch {
    return { ok: false, error: "SESSION_STORAGE_UNAVAILABLE" };
  }
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

  if (purgeExpiredRuns()) {
    await persistState();
  }
  const activeRun = Array.from(runs.values()).find((run) => !run.closed);
  if (activeRun) {
    return { ok: false, error: "RUN_ALREADY_ACTIVE", run: publicRun(activeRun) };
  }
  if (!await isIncognitoAccessAllowed()) {
    return { ok: false, error: "INCOGNITO_ACCESS_REQUIRED" };
  }
  const browserWindows = await chrome.windows.getAll({ populate: false });
  if (browserWindows.some((browserWindow) => browserWindow.incognito === true)) {
    return { ok: false, error: "INCOGNITO_SESSION_NOT_FRESH" };
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
    credentialSubmitted: false,
    credentialState: "NOT_REQUESTED",
    pocUid,
    brokerIdToken: message.pocIdToken,
    authTabId: null,
    geminiTabId: null,
    currentDocumentId: null,
    geminiDocumentId: null,
    confirmedDocumentId: null,
    currentUrl: "about:blank",
    geminiCurrentUrl: null,
    geminiReloaded: false,
    googleSessionEstablished: false,
    geminiReadyForIdentityFailure: false,
    closed: false,
    note: "Starting the extension agent in a minimized InPrivate window."
  };
  runs.set(run.requestId, run);

  let createdWindow = null;
  try {
    createdWindow = await chrome.windows.create({
      url: "about:blank",
      type: "normal",
      incognito: true,
      focused: false,
      state: "minimized"
    });
    const tab = createdWindow.tabs?.[0];
    if (!Number.isInteger(createdWindow?.id) || !tab || !Number.isInteger(tab.id)) {
      throw new Error("Browser did not return the isolated Google tab.");
    }
    run.windowId = createdWindow.id;
    run.tabId = tab.id;
    run.authTabId = tab.id;
    tabToRequest.set(tab.id, run.requestId);
    updateRun(run, {
      stage: "ISOLATED_WINDOW_CREATED",
      note: "The isolated Google tab is ready for background authentication."
    });
    await persistState();
    await chrome.tabs.update(tab.id, { url: LOGIN_URL, active: true });
    updateRun(run, {
      stage: "NAVIGATING_TO_GOOGLE",
      note: "The isolated tab is mapped before Google navigation begins."
    });
    await persistState();
    return { ok: true, run: publicRun(run), replayed: false };
  } catch (error) {
    updateRun(run, {
      stage: "OPEN_FAILED",
      closed: true,
      note: error instanceof Error ? error.message : "Could not open the isolated window."
    });
    if (Number.isInteger(run.tabId)) {
      tabToRequest.delete(run.tabId);
    }
    if (Number.isInteger(run.geminiTabId)) {
      tabToRequest.delete(run.geminiTabId);
    }
    const failedWindowId = Number.isInteger(run.windowId)
      ? run.windowId
      : Number.isInteger(createdWindow?.id) ? createdWindow.id : null;
    if (Number.isInteger(failedWindowId)) {
      await chrome.windows.remove(failedWindowId).catch(() => {});
    }
    await persistState().catch(() => {});
    return { ok: false, error: "OPEN_FAILED", run: publicRun(run) };
  }
}

function startAgent(message) {
  const operation = startAgentTail
    .catch(() => {})
    .then(() => startAgentUnlocked(message));
  startAgentTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function inspectGooglePage(targetEmail) {
  function exactSelectedAccount(email) {
    const normalizedEmail = email.toLowerCase();
    const controls = Array.from(document.querySelectorAll(
      "[role='link'][jsname='af8ijd'][aria-label], [data-profile-identifier], [data-identifier], [data-email], [aria-label*='@']"
    ));
    const values = controls.flatMap((control) => [
      control.getAttribute("aria-label"),
      control.getAttribute("data-profile-identifier"),
      control.getAttribute("data-identifier"),
      control.getAttribute("data-email")
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
    return exactSelectedAccount(targetEmail)
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

async function submitPassword(targetEmail, password, expectedPath) {
  function exactSelectedAccount(email) {
    const normalizedEmail = email.toLowerCase();
    const controls = Array.from(document.querySelectorAll(
      "[role='link'][jsname='af8ijd'][aria-label], [data-profile-identifier], [data-identifier], [data-email], [aria-label*='@']"
    ));
    const values = controls.flatMap((control) => [
      control.getAttribute("aria-label"),
      control.getAttribute("data-profile-identifier"),
      control.getAttribute("data-identifier"),
      control.getAttribute("data-email")
    ]).filter(Boolean);
    const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
    const emails = [...new Set(values.flatMap((value) => value.match(pattern) || [])
      .map((value) => value.toLowerCase()))];
    return emails.length === 1 && emails[0] === normalizedEmail;
  }
  if (location.pathname !== expectedPath || !/\/challenge\/pwd(?:\/|$)/.test(location.pathname)) {
    return { step: "STALE_PASSWORD_DOCUMENT" };
  }
  if (document.querySelector("iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']")) {
    return { step: "USER_ACTION_REQUIRED" };
  }
  for (let identityPoll = 0; identityPoll < 20 && !exactSelectedAccount(targetEmail); identityPoll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (location.pathname !== expectedPath || !/\/challenge\/pwd(?:\/|$)/.test(location.pathname)) {
      return { step: "STALE_PASSWORD_DOCUMENT" };
    }
    if (document.querySelector("iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']")) {
      return { step: "USER_ACTION_REQUIRED" };
    }
  }
  if (!exactSelectedAccount(targetEmail)) {
    return { step: "TARGET_ACCOUNT_NOT_CONFIRMED" };
  }
  if (typeof password !== "string" || password.length === 0) {
    return { step: "PASSWORD_FORM_UNAVAILABLE" };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  let lastInput = null;
  let stablePolls = 0;
  let injectionAttempts = 0;
  let identityMisses = 0;
  for (let poll = 0; poll < 50; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (location.pathname !== expectedPath) {
      return { step: "STALE_PASSWORD_DOCUMENT" };
    }
    if (!exactSelectedAccount(targetEmail)) {
      identityMisses += 1;
      if (identityMisses >= 10) return { step: "TARGET_ACCOUNT_NOT_CONFIRMED" };
      continue;
    }
    identityMisses = 0;
    const input = document.querySelector("input[name='Passwd'], input[type='password']");
    const next = document.querySelector("#passwordNext button, #passwordNext");
    if (!input || !next) {
      lastInput = null;
      stablePolls = 0;
      continue;
    }
    if (input !== lastInput) {
      lastInput = input;
      stablePolls = 1;
      continue;
    }
    stablePolls += 1;
    if (stablePolls < 2) continue;

    if (input.value === password) {
      const disabled = next.disabled === true
        || next.getAttribute?.("aria-disabled") === "true";
      if (disabled) continue;
      next.click();
      return { step: "PASSWORD_SUBMITTED" };
    }
    if (injectionAttempts >= 3) {
      return { step: "PASSWORD_INPUT_UNSTABLE" };
    }

    const delayedInput = input;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (location.pathname !== expectedPath || !exactSelectedAccount(targetEmail)) {
      return { step: "STALE_PASSWORD_DOCUMENT" };
    }
    if (document.querySelector("iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']")) {
      return { step: "USER_ACTION_REQUIRED" };
    }
    const inputAfterDelay = document.querySelector("input[name='Passwd'], input[type='password']");
    if (inputAfterDelay !== delayedInput) {
      lastInput = inputAfterDelay;
      stablePolls = inputAfterDelay ? 1 : 0;
      continue;
    }

    delayedInput.focus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const focusedInput = document.querySelector("input[name='Passwd'], input[type='password']");
    if (focusedInput !== delayedInput) {
      lastInput = focusedInput;
      stablePolls = focusedInput ? 1 : 0;
      continue;
    }
    if (setter) setter.call(delayedInput, password); else delayedInput.value = password;
    delayedInput.dispatchEvent(new Event("input", { bubbles: true }));
    delayedInput.dispatchEvent(new Event("change", { bubbles: true }));
    injectionAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const submittedInput = document.querySelector("input[name='Passwd'], input[type='password']");
    const submittedNext = document.querySelector("#passwordNext button, #passwordNext");
    const submitDisabled = !submittedNext
      || submittedNext.disabled === true
      || submittedNext.getAttribute?.("aria-disabled") === "true";
    if (location.pathname === expectedPath
        && exactSelectedAccount(targetEmail)
        && submittedInput === delayedInput
        && submittedInput.value === password
        && !submitDisabled) {
      submittedNext.click();
      return { step: "PASSWORD_SUBMITTED" };
    }
    lastInput = submittedInput;
    stablePolls = submittedInput ? 1 : 0;
  }
  return { step: injectionAttempts > 0 ? "PASSWORD_INPUT_UNSTABLE" : "PASSWORD_FORM_UNAVAILABLE" };
}

function clearPasswordInput() {
  const input = document.querySelector("input[name='Passwd'], input[type='password']");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, ""); else input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

async function callCredentialBroker(body, idToken = null) {
  const headers = { "Content-Type": "application/json" };
  if (typeof idToken === "string" && idToken.length > 0) {
    headers.Authorization = `Bearer ${idToken}`;
  }
  const response = await withTimeout(fetch(CREDENTIAL_BROKER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    redirect: "error"
  }), BROKER_TIMEOUT_MS, "CREDENTIAL_BROKER_TIMEOUT");
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error(payload?.error || "CREDENTIAL_BROKER_FAILED");
  }
  return payload;
}

async function fetchOneShotCredential(run) {
  if (typeof run.brokerIdToken !== "string" || run.brokerIdToken.length < 100) {
    throw new Error("POC_AUTH_REQUIRED");
  }
  const idToken = run.brokerIdToken;
  const payload = await callCredentialBroker({
    action: "getGoogleCredential",
    requestId: run.requestId,
    version: PROTOCOL_VERSION
  }, idToken);
  run.brokerIdToken = null;
  if (payload?.ok !== true
      || typeof payload.email !== "string"
      || payload.email.toLowerCase() !== TARGET_EMAIL
      || typeof payload.password !== "string"
      || payload.password.length === 0) {
    throw new Error(payload?.error || "Credential broker returned an invalid target credential.");
  }
  return payload;
}

async function closeFailedWindow(run) {
  if (Number.isInteger(run.windowId)) {
    await chrome.windows.remove(run.windowId).catch(() => {});
  }
}

async function failRun(run, stage, note) {
  updateRun(run, { stage, note, identityCheckComplete: true, closed: true, brokerIdToken: null });
  await chrome.alarms.clear(authAlarmName(run.requestId)).catch(() => {});
  if (Number.isInteger(run.authTabId) && typeof run.currentDocumentId === "string") {
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId: run.authTabId, documentIds: [run.currentDocumentId] },
      func: clearPasswordInput
    }), 2000, "PASSWORD_CLEAR_TIMEOUT").catch(() => {});
  }
  await closeFailedWindow(run);
  await persistState().catch(() => {});
}

async function openIsolatedGeminiTab(run) {
  if (Number.isInteger(run.geminiTabId)) return;
  updateRun(run, {
    stage: "OPENING_ISOLATED_GEMINI_TAB",
    note: "Opening Gemini in a new tab inside the same isolated window."
  });
  await persistState();
  const geminiTab = await chrome.tabs.create({
    windowId: run.windowId,
    url: "about:blank",
    active: true
  });
  if (!Number.isInteger(geminiTab?.id)) {
    throw new Error("GEMINI_TAB_OPEN_FAILED");
  }
  run.geminiTabId = geminiTab.id;
  tabToRequest.set(geminiTab.id, run.requestId);
  await persistState();
  await chrome.tabs.update(geminiTab.id, { url: GEMINI_URL, active: true });
  updateRun(run, {
    stage: "GEMINI_TAB_OPENED",
    note: "Gemini is loading in the active isolated tab while Google finishes in the background."
  });
  await persistState();
}

async function automateGoogle(run, tabId, documentId) {
  if (typeof documentId !== "string" || documentId.length === 0) {
    await failRun(run, "DOCUMENT_ID_UNAVAILABLE", "Google document ID was unavailable.");
    return;
  }
  const lockKey = `${tabId}:${documentId}`;
  const existing = automationLocks.get(lockKey);
  if (existing) return existing;
  const operation = (async () => {
    for (let attempt = 0; attempt < AUTOMATION_RETRY_LIMIT; attempt += 1) {
      if (run.closed || run.authTabId !== tabId || run.currentDocumentId !== documentId) return;
      let result;
      try {
        const results = await withTimeout(chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] }, func: inspectGooglePage, args: [TARGET_EMAIL]
        }), SCRIPT_TIMEOUT_MS, "GOOGLE_INSPECTION_TIMEOUT");
        if (results?.[0]?.documentId !== documentId) {
          throw new Error("STALE_GOOGLE_DOCUMENT");
        }
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
        await persistState();
        return;
      }

      if (run.credentialState !== "NOT_REQUESTED") {
        if (run.credentialState === "CONSUMED" && run.stage === "PASSWORD_SUBMITTED") {
          return;
        }
        await failRun(run, "CREDENTIAL_ALREADY_CLAIMED", "The one-shot credential was already requested for this run.");
        return;
      }

      updateRun(run, {
        stage: "FETCHING_ONE_SHOT_CREDENTIAL",
        credentialState: "REQUESTING",
        note: "Requesting the target credential from the HTTPS one-shot broker."
      });
      await persistState();
      let credential;
      try {
        credential = await fetchOneShotCredential(run);
        updateRun(run, {
          stage: "INJECTING_PASSWORD",
          credentialDelivered: true,
          credentialSubmitted: false,
          credentialState: "CONSUMED",
          note: "The credential was received; waiting two seconds for the password field to settle before submission."
        });
        await persistState();
        const latestFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
        let latestUrl;
        try { latestUrl = new URL(latestFrame?.url); } catch { latestUrl = null; }
        if (!latestFrame
            || typeof latestFrame.documentId !== "string"
            || latestUrl?.origin !== "https://accounts.google.com"
            || !/\/challenge\/pwd(?:\/|$)/.test(latestUrl.pathname)) {
          throw new Error("STALE_PASSWORD_DOCUMENT");
        }
        const targetDocumentId = latestFrame.documentId;
        updateRun(run, {
          currentDocumentId: targetDocumentId,
          currentUrl: latestFrame.url,
          observedOrigin: latestUrl.origin
        });
        await persistState();
        const results = await withTimeout(chrome.scripting.executeScript({
          target: { tabId, documentIds: [targetDocumentId] },
          func: submitPassword,
          args: [TARGET_EMAIL, credential.password, latestUrl.pathname]
        }), SCRIPT_TIMEOUT_MS, "PASSWORD_SUBMIT_TIMEOUT");
        if (results?.[0]?.documentId !== targetDocumentId) {
          throw new Error("STALE_PASSWORD_DOCUMENT");
        }
        const passwordStep = results?.[0]?.result?.step || "PASSWORD_FORM_UNAVAILABLE";
        credential.password = "";
        credential = null;
        if (passwordStep === "PASSWORD_SUBMITTED") {
          updateRun(run, {
            stage: "PASSWORD_SUBMITTED",
            credentialSubmitted: true,
            note: "The one-shot credential was submitted and discarded from extension memory."
          });
          chrome.alarms.create(authAlarmName(run.requestId), { delayInMinutes: AUTH_TIMEOUT_MINUTES });
          await persistState();
          await openIsolatedGeminiTab(run);
          return;
        }
        await failRun(run, passwordStep, "The exact Google password form could not be submitted safely.");
        return;
      } catch (error) {
        if (credential) credential.password = "";
        credential = null;
        updateRun(run, { credentialState: "CONSUMED" });
        run.brokerIdToken = null;
        await failRun(run, "CREDENTIAL_BROKER_FAILED",
          error instanceof Error ? error.message : "The one-shot credential broker failed.");
        return;
      }
    }
    await failRun(run, "GOOGLE_PAGE_UNRECOGNIZED", "Google did not expose a supported login document in time.");
  })();
  automationLocks.set(lockKey, operation);
  try {
    await operation;
  } finally {
    if (automationLocks.get(lockKey) === operation) automationLocks.delete(lockKey);
  }
}

async function handleNavigation(details) {
  await ensureStateReady();
  if (details.frameId !== 0 || typeof details.documentId !== "string") return;
  const requestId = tabToRequest.get(details.tabId);
  const run = requestId ? getRun(requestId) : null;
  if (!run || run.closed) return;
  let url;
  try { url = new URL(details.url); } catch { return; }
  if (details.tabId === run.authTabId) {
    updateRun(run, {
      currentDocumentId: details.documentId,
      currentUrl: details.url,
      observedOrigin: url.origin
    });
    if (url.origin === "https://accounts.google.com") {
      if (run.credentialState === "CONSUMED") {
        updateRun(run, {
          stage: "GOOGLE_AUTH_CONTINUING",
          note: "Google is finishing authentication in the background tab."
        });
      } else {
        updateRun(run, { stage: "GOOGLE_LOGIN_PAGE", note: null });
        await persistState();
        await automateGoogle(run, details.tabId, details.documentId);
      }
    } else if (url.origin === "https://gemini.google.com" && !run.googleSessionEstablished) {
      updateRun(run, {
        googleSessionEstablished: true,
        geminiReloaded: Number.isInteger(run.geminiTabId),
        geminiReadyForIdentityFailure: false,
        stage: "RELOADING_GEMINI_AFTER_LOGIN",
        note: "Google login succeeded; reloading Gemini so it receives the authenticated session."
      });
      await persistState();
      if (Number.isInteger(run.geminiTabId)) {
        try {
          await chrome.tabs.reload(run.geminiTabId);
          await chrome.tabs.update(run.geminiTabId, { active: true });
        } catch {
          await failRun(run, "GEMINI_RELOAD_FAILED", "Gemini could not be reloaded after Google login succeeded.");
        }
      }
    }
  } else if (details.tabId === run.geminiTabId) {
    if (run.geminiDocumentId !== details.documentId) {
      updateRun(run, {
        geminiDocumentId: details.documentId,
        geminiCurrentUrl: details.url,
        observedOrigin: url.origin,
        confirmedDocumentId: null,
        targetAccountConfirmed: false,
        identityCheckComplete: false
      });
    } else {
      updateRun(run, { geminiCurrentUrl: details.url, observedOrigin: url.origin });
    }
    if (url.origin === "https://gemini.google.com") {
      if (run.googleSessionEstablished) {
        updateRun(run, { geminiReadyForIdentityFailure: true });
      }
      if (run.stage !== "RELOADING_GEMINI"
          && !(run.confirmedDocumentId === details.documentId && run.targetAccountConfirmed)) {
        updateRun(run, {
          stage: "GEMINI_DOCUMENT_LOADING",
          note: "The dedicated isolated Gemini tab loaded; waiting for exact account confirmation."
        });
      }
    } else if (url.origin === "https://accounts.google.com") {
      updateRun(run, {
        stage: "GEMINI_WAITING_FOR_GOOGLE_SESSION",
        note: "The Gemini tab is waiting while authentication finishes in the background tab."
      });
    }
  }
  await persistState();
}

async function reconcileRunFrame(run) {
  if (run.closed) return;
  const ownedTabIds = [...new Set([run.authTabId, run.geminiTabId].filter(Number.isInteger))];
  for (const tabId of ownedTabIds) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito !== true) {
      await failRun(run, "ISOLATION_LOST", "An owned tab is no longer InPrivate/Incognito.");
      return;
    }
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame || typeof frame.documentId !== "string" || typeof frame.url !== "string") {
      await failRun(run, "FRAME_UNAVAILABLE", "An owned top-level document could not be reconciled.");
      return;
    }
    await handleNavigation({ frameId: 0, tabId, documentId: frame.documentId, url: frame.url });
  }
}

function inspectGeminiActiveAccount(targetEmail) {
  const controls = Array.from(document.querySelectorAll([
    "a[href*='accounts.google.com/SignOutOptions'][aria-label]",
    "button[data-ogsr-up][aria-label]",
    "[role='button'][data-ogsr-up][aria-label]"
  ].join(",")));
  const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
  const emails = [...new Set(controls.flatMap((control) =>
    (control.getAttribute("aria-label") || "").match(pattern) || []
  ).map((email) => email.toLowerCase()))];
  return emails.length === 1 && emails[0] === targetEmail.toLowerCase();
}

function injectPrompt(targetEmail, prompt) {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function composerValue(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return normalizeText(element.value);
    }
    return normalizeText(element.textContent);
  }
  function exactVisiblePromptCount(root, excludedComposer, normalizedPrompt) {
    return Array.from(root.querySelectorAll("*")).filter((element) => {
      if (element === excludedComposer
          || element.contains(excludedComposer)
          || excludedComposer?.contains(element)
          || element.getClientRects().length === 0
          || normalizeText(element.innerText) !== normalizedPrompt) {
        return false;
      }
      return !Array.from(element.children).some(
        (child) => normalizeText(child.innerText) === normalizedPrompt
      );
    }).length;
  }
  const controls = Array.from(document.querySelectorAll([
    "a[href*='accounts.google.com/SignOutOptions'][aria-label]",
    "button[data-ogsr-up][aria-label]",
    "[role='button'][data-ogsr-up][aria-label]"
  ].join(",")));
  const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
  const emails = [...new Set(controls.flatMap((control) =>
    (control.getAttribute("aria-label") || "").match(pattern) || []
  ).map((email) => email.toLowerCase()))];
  if (emails.length !== 1 || emails[0] !== targetEmail.toLowerCase()) {
    return { ok: false, error: "TARGET_ACCOUNT_NOT_CONFIRMED" };
  }
  const candidate = document.querySelector("div[contenteditable='true'][role='textbox'], textarea[aria-label], textarea");
  if (!candidate) return { ok: false, error: "PROMPT_BOX_NOT_FOUND" };
  const normalizedPrompt = normalizeText(prompt);
  const messageRoot = document.querySelector("main, [role='main']") || document.body;
  const beforeCount = exactVisiblePromptCount(messageRoot, candidate, normalizedPrompt);
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
  return new Promise((resolve) => {
    let attempts = 0;
    const verify = () => {
      const currentComposer = document.querySelector(
        "div[contenteditable='true'][role='textbox'], textarea[aria-label], textarea"
      );
      const composerCleared = !currentComposer || composerValue(currentComposer) !== normalizedPrompt;
      const afterCount = exactVisiblePromptCount(messageRoot, currentComposer, normalizedPrompt);
      if (composerCleared && afterCount > beforeCount) {
        resolve({ ok: true, postcondition: "EXACT_USER_TURN_OBSERVED" });
        return;
      }
      attempts += 1;
      if (attempts >= 40) {
        resolve({ ok: false, error: "PROMPT_POSTCONDITION_NOT_OBSERVED" });
        return;
      }
      setTimeout(verify, 250);
    };
    setTimeout(verify, 250);
  });
}

async function postPrompt(message) {
  try {
    await ensureStateReady();
  } catch {
    return { ok: false, error: "SESSION_STORAGE_UNAVAILABLE" };
  }
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
  const tab = await chrome.tabs.get(run.tabId).catch(() => null);
  const frame = await chrome.webNavigation.getFrame({ tabId: run.tabId, frameId: 0 }).catch(() => null);
  let frameOrigin = null;
  try { frameOrigin = new URL(frame?.url).origin; } catch { /* ignored */ }
  if (tab?.incognito !== true
      || frameOrigin !== "https://gemini.google.com"
      || typeof run.confirmedDocumentId !== "string"
      || frame?.documentId !== run.confirmedDocumentId
      || run.geminiDocumentId !== run.confirmedDocumentId) {
    await failRun(run, "GEMINI_CONTEXT_CHANGED", "Gemini navigated away from the confirmed account document.");
    return { ok: false, error: "GEMINI_CONTEXT_CHANGED", run: publicRun(run) };
  }
  const results = await withTimeout(chrome.scripting.executeScript({
    target: { tabId: run.tabId, documentIds: [run.confirmedDocumentId] },
    func: injectPrompt,
    args: [TARGET_EMAIL, message.prompt]
  }), PROMPT_CONFIRM_TIMEOUT_MS, "PROMPT_SUBMIT_TIMEOUT");
  if (results?.[0]?.documentId !== run.confirmedDocumentId) {
    await failRun(run, "GEMINI_CONTEXT_CHANGED", "Prompt targeting did not match the confirmed document.");
    return { ok: false, error: "GEMINI_CONTEXT_CHANGED", run: publicRun(run) };
  }
  const result = results?.[0]?.result || { ok: false, error: "PROMPT_SUBMIT_FAILED" };
  if (result.ok) {
    updateRun(run, {
      stage: "PROMPT_SUBMITTED_CONFIRMED",
      note: "Gemini rendered a new exact user turn after the composer cleared."
    });
    await persistState();
  }
  return { ...result, run: publicRun(run) };
}

async function cancelRun(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  await ensureStateReady();
  const run = getRun(message.requestId);
  if (!run) return { ok: true, cancelled: false };
  let pocUid;
  try {
    pocUid = await verifyPocIdToken(message.pocIdToken);
  } catch {
    return { ok: false, error: "POC_AUTH_REQUIRED" };
  }
  if (run.pocUid !== pocUid) return { ok: false, error: "POC_AUTH_REQUIRED" };
  if (!run.closed) await failRun(run, "CANCELLED", "The POC session cancelled its owned isolated window.");
  return { ok: true, cancelled: true, run: publicRun(run) };
}

async function getStatus(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  try {
    await ensureStateReady();
  } catch {
    return { ok: false, error: "SESSION_STORAGE_UNAVAILABLE" };
  }
  const run = getRun(message.requestId);
  if (run && !run.closed) {
    await reconcileRunFrame(run).catch(async () => {
      await failRun(run, "FRAME_RECONCILIATION_FAILED", "The current top-level document could not be reconciled.");
    });
  }
  return { ok: true, run: publicRun(run) };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isAllowedExternalSender(sender)) {
    sendResponse({ ok: false, error: "UNTRUSTED_SENDER" });
    return false;
  }
  const task = message?.type === "PING" ? pingExtension()
    : message?.type === "AUTHENTICATE_POC" ? authenticatePoc(message)
      : message?.type === "START_AGENT" ? startAgent(message)
        : message?.type === "GET_STATUS" ? getStatus(message)
          : message?.type === "POST_PROMPT" ? postPrompt(message)
            : message?.type === "CANCEL_RUN" ? cancelRun(message)
              : Promise.resolve({ ok: false, error: "UNKNOWN_MESSAGE" });
  task.then(sendResponse).catch((error) => sendResponse({
    ok: false, error: error instanceof Error ? error.message : "EXTENSION_ERROR"
  }));
  return true;
});

chrome.webNavigation.onCompleted.addListener((details) => { handleNavigation(details).catch(() => {}); });
async function handleCommitted(details) {
  await ensureStateReady();
  if (details.frameId !== 0 || typeof details.documentId !== "string") return;
  const requestId = tabToRequest.get(details.tabId);
  const run = requestId ? getRun(requestId) : null;
  if (!run || run.closed) return;
  try {
    const origin = new URL(details.url).origin;
    if (details.tabId === run.authTabId) {
      updateRun(run, {
        currentDocumentId: details.documentId,
        currentUrl: details.url,
        observedOrigin: origin,
        stage: origin === "https://accounts.google.com"
          ? run.credentialState === "CONSUMED" ? "GOOGLE_AUTH_CONTINUING" : "GOOGLE_DOCUMENT_COMMITTED"
          : origin === "https://gemini.google.com" ? "GOOGLE_SESSION_ESTABLISHING" : "NAVIGATION_COMMITTED"
      });
    } else if (details.tabId === run.geminiTabId) {
      updateRun(run, {
        geminiDocumentId: details.documentId,
        confirmedDocumentId: null,
        geminiCurrentUrl: details.url,
        observedOrigin: origin,
        targetAccountConfirmed: false,
        identityCheckComplete: false,
        geminiReadyForIdentityFailure: origin === "https://gemini.google.com"
          && run.googleSessionEstablished,
        stage: origin === "https://gemini.google.com"
          ? "GEMINI_DOCUMENT_LOADING"
          : origin === "https://accounts.google.com"
            ? "GEMINI_WAITING_FOR_GOOGLE_SESSION"
            : "GEMINI_NAVIGATION_COMMITTED"
      });
    }
    await persistState();
  } catch { /* ignored */ }
}
chrome.webNavigation.onCommitted.addListener((details) => { handleCommitted(details).catch(() => {}); });

async function handleInternalMessage(message, sender) {
  if (message?.type !== "GEMINI_DOCUMENT_SIGNAL"
      || message.version !== PROTOCOL_VERSION
      || typeof message.targetAccountObserved !== "boolean"
      || typeof message.identityCheckComplete !== "boolean"
      || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id)
      || typeof sender.documentId !== "string"
      || sender.tab.incognito !== true) {
    return { ok: false };
  }
  await ensureStateReady();
  const requestId = tabToRequest.get(sender.tab.id);
  const run = requestId ? getRun(requestId) : null;
  if (!run || run.closed || sender.tab.id !== run.geminiTabId) {
    return { ok: false };
  }
  let origin;
  try { origin = new URL(sender.url).origin; } catch { return { ok: false }; }
  if (origin !== "https://gemini.google.com") {
    return { ok: false };
  }
  const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 }).catch(() => null);
  if (!frame
      || frame.documentId !== sender.documentId
      || run.geminiDocumentId !== sender.documentId
      || new URL(frame.url).origin !== "https://gemini.google.com") {
    return { ok: false, error: "STALE_GEMINI_DOCUMENT" };
  }
  if (message.targetAccountObserved) {
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      func: inspectGeminiActiveAccount,
      args: [TARGET_EMAIL]
    }), SCRIPT_TIMEOUT_MS, "GEMINI_IDENTITY_TIMEOUT").catch(() => null);
    if (results?.[0]?.documentId !== sender.documentId || results[0].result !== true) {
      return { ok: false, confirmed: false, complete: false };
    }
    if (!run.geminiReloaded) {
      updateRun(run, {
        stage: "RELOADING_GEMINI",
        geminiReloaded: true,
        geminiReadyForIdentityFailure: false,
        targetAccountConfirmed: false,
        identityCheckComplete: false,
        confirmedDocumentId: null,
        note: "Reloading Gemini once before reveal."
      });
      await persistState();
      try {
        await chrome.tabs.reload(sender.tab.id);
      } catch {
        await failRun(run, "GEMINI_RELOAD_FAILED", "The final Gemini reload failed.");
        return { ok: false, error: "GEMINI_RELOAD_FAILED", confirmed: false, complete: true };
      }
      return { ok: true, confirmed: false, complete: false, reloading: true };
    }
    updateRun(run, {
      stage: "GEMINI_TARGET_ACCOUNT_CONFIRMED",
      targetAccountConfirmed: true,
      identityCheckComplete: true,
      confirmedDocumentId: sender.documentId,
      note: "Gemini rendered the exact target account."
    });
    const finalGeminiTabId = run.geminiTabId;
    if (Number.isInteger(run.authTabId) && run.authTabId !== finalGeminiTabId) {
      const authTabId = run.authTabId;
      tabToRequest.delete(authTabId);
      try {
        await chrome.tabs.remove(authTabId);
      } catch {
        tabToRequest.set(authTabId, run.requestId);
        await failRun(run, "AUTH_TAB_CLEANUP_FAILED", "The background Google tab could not be closed safely.");
        return { ok: false, error: "AUTH_TAB_CLEANUP_FAILED", confirmed: false, complete: true };
      }
      run.authTabId = null;
    }
    run.tabId = finalGeminiTabId;
    try {
      await chrome.tabs.update(finalGeminiTabId, { active: true });
    } catch {
      await failRun(run, "GEMINI_ACTIVATION_FAILED", "The confirmed Gemini tab could not be activated safely.");
      return { ok: false, error: "GEMINI_ACTIVATION_FAILED", confirmed: false, complete: true };
    }
    await chrome.alarms.clear(authAlarmName(run.requestId)).catch(() => {});
    await persistState();
    chrome.windows.update(run.windowId, { state: "normal", focused: true }).catch(() => {});
  } else if (message.identityCheckComplete && !run.targetAccountConfirmed) {
    updateRun(run, {
      stage: "GEMINI_WAITING_FOR_GOOGLE_SESSION",
      identityCheckComplete: false,
      note: run.googleSessionEstablished && run.geminiReadyForIdentityFailure
        ? "Gemini is still loading the target account; waiting until the authentication deadline."
        : "Gemini is waiting for the background Google session to finish."
    });
    await persistState();
    return { ok: true, confirmed: false, complete: false, waiting: true };
  }
  return { ok: true, confirmed: run.targetAccountConfirmed, complete: run.identityCheckComplete };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GEMINI_DOCUMENT_SIGNAL") return false;
  handleInternalMessage(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false }));
  return true;
});

async function handleTabRemoved(tabId) {
  await ensureStateReady();
  const requestId = tabToRequest.get(tabId);
  if (!requestId) return;
  const run = getRun(requestId);
  if (run && !run.closed) {
    updateRun(run, { closed: true, stage: "TAB_CLOSED" });
    await chrome.alarms.clear(authAlarmName(run.requestId)).catch(() => {});
  }
  tabToRequest.delete(tabId);
  await persistState();
}
chrome.tabs.onRemoved.addListener((tabId) => { handleTabRemoved(tabId).catch(() => {}); });

async function handleAlarm(alarm) {
  const prefix = "gemini-auth-timeout:";
  if (typeof alarm?.name !== "string" || !alarm.name.startsWith(prefix)) return;
  await ensureStateReady();
  const run = getRun(alarm.name.slice(prefix.length));
  if (!run || run.closed || run.targetAccountConfirmed) return;
  await failRun(run, "AUTH_TIMEOUT", "Google did not complete authentication before the one-shot deadline.");
}
chrome.alarms.onAlarm.addListener((alarm) => { handleAlarm(alarm).catch(() => {}); });
