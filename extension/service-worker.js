"use strict";

const PROTOCOL_VERSION = 9;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&followup=https%3A%2F%2Fgemini.google.com%2Fapp";
const NATIVE_HOST = "com.senkira.gemini_extension_agent";
const FIREBASE_API_KEY = "AIzaSyBAmRwEIELh_AA7E1omzf8TrVV3Cp4HPFc";
const POC_AUTH_EMAIL = "o1234567@poc.invalid";
const POC_USERNAME = "O1234567";
const POC_FIREBASE_UID = "VHX1QkrsewSrrWB0g3BjyHepdWX2";
const SESSION_STATE_KEY = "geminiExtensionAgentV9";
const RUN_TTL_MS = 10 * 60 * 1000;
const AUTOMATION_RETRY_LIMIT = 60;
const AUTOMATION_RETRY_MS = 500;
const AUTH_TIMEOUT_MINUTES = 1;
const NATIVE_TIMEOUT_MS = 20000;
const SCRIPT_TIMEOUT_MS = 5000;
const runs = new Map();
const tabToRequest = new Map();
const automationLocks = new Map();
let stateReady = null;
let persistTail = Promise.resolve();

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
    incognito: run.incognito === true,
    observedOrigin: run.observedOrigin || null,
    targetAccountConfirmed: run.targetAccountConfirmed === true,
    identityCheckComplete: run.identityCheckComplete === true,
    credentialDelivered: run.credentialDelivered === true,
    credentialState: typeof run.credentialState === "string" ? run.credentialState : "NOT_REQUESTED",
    closed: run.closed === true,
    note: run.note || null
  };
}

function persistedRun(run) {
  return {
    ...publicRun(run),
    pocUid: typeof run.pocUid === "string" ? run.pocUid : null,
    currentDocumentId: typeof run.currentDocumentId === "string" ? run.currentDocumentId : null,
    confirmedDocumentId: typeof run.confirmedDocumentId === "string" ? run.confirmedDocumentId : null,
    currentUrl: typeof run.currentUrl === "string" ? run.currentUrl : null
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
      incognito: saved.incognito === true,
      observedOrigin: typeof saved.observedOrigin === "string" ? saved.observedOrigin : null,
      targetAccountConfirmed: saved.targetAccountConfirmed === true,
      identityCheckComplete: saved.identityCheckComplete === true,
      credentialDelivered: saved.credentialDelivered === true,
      credentialState: ["NOT_REQUESTED", "REQUESTING", "CONSUMED"].includes(saved.credentialState)
        ? saved.credentialState
        : saved.credentialDelivered === true ? "CONSUMED" : "NOT_REQUESTED",
      pocUid: saved.pocUid,
      currentDocumentId: typeof saved.currentDocumentId === "string" ? saved.currentDocumentId : null,
      confirmedDocumentId: typeof saved.confirmedDocumentId === "string" ? saved.confirmedDocumentId : null,
      currentUrl: typeof saved.currentUrl === "string" ? saved.currentUrl : null,
      closed: saved.closed === true,
      note: typeof saved.note === "string" ? saved.note : null
    };
    runs.set(run.requestId, run);
    if (!run.closed && Number.isInteger(run.tabId)) {
      tabToRequest.set(run.tabId, run.requestId);
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
    void persistState();
    return null;
  }
  return run;
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

  let credential;
  try {
    credential = await withTimeout(chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      action: "authenticatePoc",
      requestId: message.requestId,
      version: PROTOCOL_VERSION
    }), NATIVE_TIMEOUT_MS, "POC_CREDENTIAL_BRIDGE_TIMEOUT");
    if (credential?.ok !== true
        || typeof credential.username !== "string"
        || credential.username.toUpperCase() !== POC_USERNAME
        || typeof credential.idToken !== "string") {
      throw new Error("POC_CREDENTIAL_BRIDGE_FAILED");
    }
    await verifyPocIdToken(credential.idToken);
    const expiresIn = Number(credential.expiresIn);
    const idToken = credential.idToken;
    credential.idToken = "";
    credential = null;
    return {
      ok: true,
      idToken,
      expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600,
      username: POC_USERNAME
    };
  } catch (error) {
    if (credential?.idToken) credential.idToken = "";
    credential = null;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "POC_CREDENTIAL_BRIDGE_FAILED"
    };
  }
}

async function startAgent(message) {
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
    credentialState: "NOT_REQUESTED",
    pocUid,
    currentDocumentId: null,
    confirmedDocumentId: null,
    currentUrl: "about:blank",
    closed: false,
    note: "Starting the extension agent in a minimized InPrivate window."
  };
  runs.set(run.requestId, run);

  try {
    const createdWindow = await chrome.windows.create({
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
    tabToRequest.set(tab.id, run.requestId);
    updateRun(run, {
      stage: "ISOLATED_WINDOW_CREATED",
      note: "The isolated window is hidden while the extension agent authenticates."
    });
    await persistState();
    await chrome.tabs.update(tab.id, { url: LOGIN_URL });
    updateRun(run, {
      stage: "NAVIGATING_TO_GOOGLE",
      note: "The isolated tab is mapped before Google navigation begins."
    });
    await persistState();
    return { ok: true, run: publicRun(run), replayed: false };
  } catch (error) {
    updateRun(run, {
      stage: "OPEN_FAILED",
      note: error instanceof Error ? error.message : "Could not open the isolated window."
    });
    await persistState().catch(() => {});
    return { ok: false, error: "OPEN_FAILED", run: publicRun(run) };
  }
}

function inspectGooglePage(targetEmail) {
  function exactSelectedAccount(email) {
    const normalizedEmail = email.toLowerCase();
    const controls = Array.from(document.querySelectorAll(
      "[role='link'][jsname='af8ijd'][aria-label], [role='link'][data-profile-identifier]"
    ));
    if (controls.length !== 1) return false;
    const values = [
      controls[0].getAttribute("aria-label"),
      controls[0].getAttribute("data-profile-identifier"),
      controls[0].getAttribute("data-identifier")
    ].filter(Boolean);
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

function submitPassword(targetEmail, password, expectedPath) {
  function exactSelectedAccount(email) {
    const normalizedEmail = email.toLowerCase();
    const controls = Array.from(document.querySelectorAll(
      "[role='link'][jsname='af8ijd'][aria-label], [role='link'][data-profile-identifier]"
    ));
    if (controls.length !== 1) return false;
    const values = [
      controls[0].getAttribute("aria-label"),
      controls[0].getAttribute("data-profile-identifier"),
      controls[0].getAttribute("data-identifier")
    ].filter(Boolean);
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
  if (!exactSelectedAccount(targetEmail)) {
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

function clearPasswordInput() {
  const input = document.querySelector("input[name='Passwd'], input[type='password']");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, ""); else input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

async function fetchOneShotCredential(run) {
  const payload = await withTimeout(chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "getGoogleCredential",
    requestId: run.requestId,
    version: PROTOCOL_VERSION
  }), NATIVE_TIMEOUT_MS, "CREDENTIAL_BRIDGE_TIMEOUT");
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
  updateRun(run, { stage, note, identityCheckComplete: true, closed: true });
  await chrome.alarms.clear(authAlarmName(run.requestId)).catch(() => {});
  if (Number.isInteger(run.tabId) && typeof run.currentDocumentId === "string") {
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId: run.tabId, documentIds: [run.currentDocumentId] },
      func: clearPasswordInput
    }), 2000, "PASSWORD_CLEAR_TIMEOUT").catch(() => {});
  }
  await closeFailedWindow(run);
  await persistState().catch(() => {});
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
      if (run.closed || run.tabId !== tabId || run.currentDocumentId !== documentId) return;
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
        note: "Requesting the target credential from the local one-shot bridge."
      });
      await persistState();
      let credential;
      try {
        credential = await fetchOneShotCredential(run);
        updateRun(run, { credentialDelivered: true, credentialState: "CONSUMED" });
        await persistState();
        const expectedPath = new URL(run.currentUrl).pathname;
        const results = await withTimeout(chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          func: submitPassword,
          args: [TARGET_EMAIL, credential.password, expectedPath]
        }), SCRIPT_TIMEOUT_MS, "PASSWORD_SUBMIT_TIMEOUT");
        if (results?.[0]?.documentId !== documentId) {
          throw new Error("STALE_PASSWORD_DOCUMENT");
        }
        const passwordStep = results?.[0]?.result?.step || "PASSWORD_FORM_UNAVAILABLE";
        credential.password = "";
        credential = null;
        if (passwordStep === "PASSWORD_SUBMITTED") {
          updateRun(run, {
            stage: "PASSWORD_SUBMITTED",
            note: "The one-shot credential was submitted and discarded from extension memory."
          });
          chrome.alarms.create(authAlarmName(run.requestId), { delayInMinutes: AUTH_TIMEOUT_MINUTES });
          await persistState();
          return;
        }
        await failRun(run, passwordStep, "The exact Google password form could not be submitted safely.");
        return;
      } catch (error) {
        if (credential) credential.password = "";
        credential = null;
        updateRun(run, { credentialState: "CONSUMED" });
        await failRun(run, "CREDENTIAL_BRIDGE_FAILED",
          error instanceof Error ? error.message : "The one-shot credential bridge failed.");
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
  if (run.currentDocumentId !== details.documentId) {
    updateRun(run, {
      currentDocumentId: details.documentId,
      currentUrl: details.url,
      observedOrigin: url.origin,
      confirmedDocumentId: null,
      targetAccountConfirmed: false,
      identityCheckComplete: false
    });
  } else {
    updateRun(run, { currentUrl: details.url, observedOrigin: url.origin });
  }
  if (url.origin === "https://accounts.google.com") {
    if (!(run.credentialState === "CONSUMED" && run.stage === "PASSWORD_SUBMITTED")) {
      updateRun(run, { stage: "GOOGLE_LOGIN_PAGE", note: null });
    }
    await persistState();
    await automateGoogle(run, details.tabId, details.documentId);
  } else if (url.origin === "https://gemini.google.com") {
    if (!(run.confirmedDocumentId === details.documentId && run.targetAccountConfirmed)) {
      updateRun(run, {
        stage: "GEMINI_DOCUMENT_LOADING",
        note: "Gemini loaded; waiting for exact account confirmation."
      });
    }
  }
  await persistState();
}

async function reconcileRunFrame(run) {
  if (run.closed || !Number.isInteger(run.tabId)) return;
  const tab = await chrome.tabs.get(run.tabId);
  if (tab.incognito !== true) {
    await failRun(run, "ISOLATION_LOST", "The owned tab is no longer InPrivate/Incognito.");
    return;
  }
  const frame = await chrome.webNavigation.getFrame({ tabId: run.tabId, frameId: 0 });
  if (!frame || typeof frame.documentId !== "string" || typeof frame.url !== "string") {
    await failRun(run, "FRAME_UNAVAILABLE", "The current top-level document could not be reconciled.");
    return;
  }
  await handleNavigation({
    frameId: 0,
    tabId: run.tabId,
    documentId: frame.documentId,
    url: frame.url
  });
}

function inspectGeminiActiveAccount(targetEmail) {
  const controls = Array.from(document.querySelectorAll([
    "a[href*='accounts.google.com/SignOutOptions'][aria-label]",
    "button[data-ogsr-up][aria-label]",
    "[role='button'][data-ogsr-up][aria-label]"
  ].join(",")));
  if (controls.length !== 1) return false;
  const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
  const emails = [...new Set(((controls[0].getAttribute("aria-label") || "").match(pattern) || [])
    .map((email) => email.toLowerCase()))];
  return emails.length === 1 && emails[0] === targetEmail.toLowerCase();
}

function injectPrompt(targetEmail, prompt) {
  const controls = Array.from(document.querySelectorAll([
    "a[href*='accounts.google.com/SignOutOptions'][aria-label]",
    "button[data-ogsr-up][aria-label]",
    "[role='button'][data-ogsr-up][aria-label]"
  ].join(",")));
  if (controls.length !== 1) return { ok: false, error: "TARGET_ACCOUNT_NOT_CONFIRMED" };
  const pattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
  const emails = [...new Set(((controls[0].getAttribute("aria-label") || "").match(pattern) || [])
    .map((email) => email.toLowerCase()))];
  if (emails.length !== 1 || emails[0] !== targetEmail.toLowerCase()) {
    return { ok: false, error: "TARGET_ACCOUNT_NOT_CONFIRMED" };
  }
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
      || run.currentDocumentId !== run.confirmedDocumentId) {
    await failRun(run, "GEMINI_CONTEXT_CHANGED", "Gemini navigated away from the confirmed account document.");
    return { ok: false, error: "GEMINI_CONTEXT_CHANGED", run: publicRun(run) };
  }
  const results = await withTimeout(chrome.scripting.executeScript({
    target: { tabId: run.tabId, documentIds: [run.confirmedDocumentId] },
    func: injectPrompt,
    args: [TARGET_EMAIL, message.prompt]
  }), SCRIPT_TIMEOUT_MS, "PROMPT_SUBMIT_TIMEOUT");
  if (results?.[0]?.documentId !== run.confirmedDocumentId) {
    await failRun(run, "GEMINI_CONTEXT_CHANGED", "Prompt targeting did not match the confirmed document.");
    return { ok: false, error: "GEMINI_CONTEXT_CHANGED", run: publicRun(run) };
  }
  const result = results?.[0]?.result || { ok: false, error: "PROMPT_SUBMIT_FAILED" };
  if (result.ok) {
    updateRun(run, { stage: "PROMPT_SUBMITTED", note: "The prompt was posted to the confirmed Gemini session." });
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
    updateRun(run, {
      currentDocumentId: details.documentId,
      confirmedDocumentId: null,
      currentUrl: details.url,
      observedOrigin: origin,
      targetAccountConfirmed: false,
      identityCheckComplete: false,
      stage: origin === "https://gemini.google.com"
        ? "GEMINI_DOCUMENT_LOADING"
        : origin === "https://accounts.google.com"
          ? run.credentialState === "CONSUMED" ? "GOOGLE_AUTH_CONTINUING" : "GOOGLE_DOCUMENT_COMMITTED"
          : "NAVIGATION_COMMITTED"
    });
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
  if (!run || run.closed) {
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
      || run.currentDocumentId !== sender.documentId
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
    updateRun(run, {
      stage: "GEMINI_TARGET_ACCOUNT_CONFIRMED",
      targetAccountConfirmed: true,
      identityCheckComplete: true,
      confirmedDocumentId: sender.documentId,
      note: "Gemini rendered the exact target account."
    });
    await chrome.alarms.clear(authAlarmName(run.requestId)).catch(() => {});
    await persistState();
    chrome.windows.update(run.windowId, { state: "normal", focused: true }).catch(() => {});
  } else if (message.identityCheckComplete && !run.targetAccountConfirmed) {
    await failRun(run, "GEMINI_TARGET_ACCOUNT_NOT_CONFIRMED", "Gemini loaded with an unconfirmed account.");
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
  if (run) {
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
