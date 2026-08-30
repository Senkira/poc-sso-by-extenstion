"use strict";

const PROTOCOL_VERSION = 3;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const LOGIN_URL = "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
const RUN_TTL_MS = 10 * 60 * 1000;
const AUTOMATION_RETRY_LIMIT = 4;
const PASSWORD_MANAGER_SETTLE_MS = 750;
const BROWSER_AUTH_SETTLE_MS = 4000;
const AUTH_PENDING_RECHECK_MS = 4000;
const AUTH_PENDING_RECHECK_LIMIT = 2;
const PENDING_BROWSER_AUTH_STAGES = new Set([
  "BROWSER_CREDENTIAL_SUBMIT_REQUESTED",
  "AUTH_PENDING"
]);
const runUpdates = new Map();
const openOperations = new Map();
const automationOperations = new Map();

function runKey(requestId) {
  return `run:${requestId}`;
}

function tabKey(tabId) {
  return `tab:${tabId}`;
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

async function putRun(run) {
  run.updatedAt = Date.now();
  await chrome.storage.session.set({ [runKey(run.requestId)]: run });
  return run;
}

async function getRun(requestId) {
  const result = await chrome.storage.session.get(runKey(requestId));
  const run = result[runKey(requestId)];
  if (!run) {
    return null;
  }
  if (Date.now() - run.createdAt > RUN_TTL_MS) {
    await chrome.storage.session.remove(runKey(requestId));
    return null;
  }
  return run;
}

async function updateRun(requestId, mutate) {
  const previous = runUpdates.get(requestId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const run = await getRun(requestId);
    if (!run || mutate(run) === false) {
      return run;
    }
    return putRun(run);
  });
  runUpdates.set(requestId, task);
  try {
    return await task;
  } finally {
    if (runUpdates.get(requestId) === task) {
      runUpdates.delete(requestId);
    }
  }
}

function applyNavigation(run, details, completed, committed = false) {
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return false;
  }
  const navigationAt = Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now();
  if (run.closed || navigationAt < (run.lastNavigationAt || 0)) {
    return false;
  }
  if (!committed && details.documentId && run.currentDocumentId
      && details.documentId !== run.currentDocumentId) {
    return false;
  }
  if (committed && details.documentId && details.documentId !== run.currentDocumentId) {
    run.currentDocumentId = details.documentId;
    run.documentObserved = false;
    run.targetAccountConfirmed = false;
    run.identityCheckComplete = false;
    run.automatedDocumentId = null;
    run.automatedDocumentPath = null;
    run.authAttemptAt = null;
    run.authPendingChecks = 0;
    run.nextAuthCheckAt = null;
  }
  run.lastNavigationAt = navigationAt;
  run.observedOrigin = url.origin;
  run.observedPath = url.pathname;
  if (url.origin === "https://accounts.google.com") {
    const sameDocument = !details.documentId || details.documentId === run.currentDocumentId;
    const sameAutomatedStep = sameDocument
      && run.automatedDocumentId === run.currentDocumentId
      && run.automatedDocumentPath === url.pathname;
    const pendingBrowserAuthentication = sameDocument
      && run.automatedDocumentId === run.currentDocumentId
      && PENDING_BROWSER_AUTH_STAGES.has(run.stage);
    if (!sameAutomatedStep && !pendingBrowserAuthentication) {
      run.stage = completed ? "GOOGLE_ACCOUNTS_PAGE_LOADED" : "GOOGLE_ACCOUNTS_NAVIGATED";
    }
  } else if (url.origin === "https://gemini.google.com") {
    run.stage = run.targetAccountConfirmed
      ? "GEMINI_TARGET_ACCOUNT_CONFIRMED"
      : run.documentObserved
        ? "GEMINI_DOCUMENT_OBSERVED"
        : completed
          ? "GEMINI_DOCUMENT_LOADED"
          : "GEMINI_NAVIGATED";
  } else if (url.protocol === "https:" || url.protocol === "http:") {
    run.stage = completed ? "EXTERNAL_AUTH_PAGE_LOADED" : "EXTERNAL_AUTH_NAVIGATED";
  } else {
    run.stage = completed ? "OTHER_PAGE_LOADED" : "OTHER_PAGE_NAVIGATED";
  }
  return true;
}

async function reconcileCurrentFrame(requestId, tabId) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (!frame?.url) {
    return null;
  }
  await updateRun(requestId, (run) => {
    let url;
    try {
      url = new URL(frame.url);
    } catch {
      return false;
    }
    if (frame.documentId && frame.documentId === run.currentDocumentId
        && url.origin === run.observedOrigin && url.pathname === run.observedPath) {
      return false;
    }
    return applyNavigation(run, {
      url: frame.url,
      documentId: frame.documentId,
      timeStamp: Date.now()
    }, false, true);
  });
  return frame;
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
    observedOrigin: run.observedOrigin || null,
    documentObserved: run.documentObserved === true,
    targetAccountConfirmed: run.targetAccountConfirmed === true,
    identityCheckComplete: run.identityCheckComplete === true,
    closed: run.closed === true,
    note: run.note || null
  };
}

async function openGeminiOnce(message) {
  const existing = await getRun(message.requestId);
  if (existing) {
    return { ok: true, run: publicRun(existing), replayed: true };
  }
  const run = await putRun({
    requestId: message.requestId,
    stage: "OPENING_GOOGLE_WINDOW",
    createdAt: Date.now(),
    observedOrigin: null,
    documentObserved: false,
    targetAccountConfirmed: false,
    identityCheckComplete: false,
    closed: false,
    note: "Secretless flow: Google, the browser password manager, or an external IdP must supply authentication."
  });
  try {
    const createdWindow = await chrome.windows.create({ url: LOGIN_URL, type: "normal", focused: true });
    const tab = createdWindow.tabs?.[0];
    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error("Browser did not return the Google tab.");
    }
    await chrome.storage.session.set({ [tabKey(tab.id)]: message.requestId });
    const savedRun = await updateRun(message.requestId, (current) => {
      current.windowId = createdWindow.id;
      current.tabId = tab.id;
      if (current.stage === "OPENING_GOOGLE_WINDOW") {
        current.stage = "GOOGLE_WINDOW_CREATED";
      }
    });
    await reconcileCurrentFrame(message.requestId, tab.id).catch(() => {});
    const reconciledRun = await getRun(message.requestId);
    return { ok: true, run: publicRun(reconciledRun || savedRun), replayed: false };
  } catch (error) {
    run.stage = "OPEN_FAILED";
    run.note = error instanceof Error ? error.message : "Unknown launch error";
    await putRun(run);
    return { ok: false, error: "OPEN_FAILED", run: publicRun(run) };
  }
}

function openGemini(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return Promise.resolve({ ok: false, error: "INVALID_REQUEST" });
  }
  const pending = openOperations.get(message.requestId);
  if (pending) {
    return pending.then((result) => ({ ...result, replayed: true }));
  }
  const operation = openGeminiOnce(message);
  openOperations.set(message.requestId, operation);
  return operation.finally(() => {
    if (openOperations.get(message.requestId) === operation) {
      openOperations.delete(message.requestId);
    }
  });
}

function performGoogleStep(targetEmail) {
  function clickElement(element) {
    if (!element) {
      return false;
    }
    element.click();
    return true;
  }

  function setEmailValue(input, email) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(input, email);
    } else {
      input.value = email;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function selectedAccountMatches(email) {
    const normalized = email.toLowerCase();
    const selectedControls = Array.from(document.querySelectorAll(
      "[role='link'][jsname='af8ijd'][aria-label]"
    ));
    if (selectedControls.length !== 1) {
      return false;
    }
    const label = selectedControls[0].getAttribute("aria-label") || "";
    const emailTokens = label.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi) || [];
    const uniqueEmails = [...new Set(emailTokens.map((candidate) => candidate.toLowerCase()))];
    return uniqueEmails.length === 1 && uniqueEmails[0] === normalized;
  }

  const path = location.pathname;
  const hasManualChallenge = Boolean(document.querySelector(
    "iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']"
  ));
  if (hasManualChallenge) {
    return { step: "USER_ACTION_REQUIRED" };
  }

  if (/\/challenge\/pwd(?:\/|$)/.test(path)) {
    if (!selectedAccountMatches(targetEmail)) {
      return { step: "TARGET_ACCOUNT_NOT_CONFIRMED" };
    }
    const next = document.querySelector("#passwordNext button, #passwordNext");
    return clickElement(next)
      ? { step: "BROWSER_CREDENTIAL_SUBMIT_REQUESTED" }
      : { step: "WAITING_FOR_SUPPORTED_FORM" };
  }

  const normalizedEmail = targetEmail.toLowerCase();
  const accountNode = Array.from(document.querySelectorAll("[data-identifier]")).find((node) =>
    (node.getAttribute("data-identifier") || "").toLowerCase() === normalizedEmail
  );
  if (accountNode) {
    const clickable = accountNode.closest("a,[role='link']")
      || accountNode.querySelector("a,[role='link']")
      || accountNode;
    clickElement(clickable);
    return { step: "ACCOUNT_SELECTED" };
  }

  const emailInput = document.querySelector("input[type='email'], input[name='identifier']");
  if (emailInput) {
    setEmailValue(emailInput, targetEmail);
    const next = document.querySelector("#identifierNext button, #identifierNext, button[type='submit']");
    if (clickElement(next)) {
      return { step: "EMAIL_SUBMITTED" };
    }
  }

  const useAnotherAccount = Array.from(document.querySelectorAll("a[href]")).find((link) =>
    /\/signin\/(?:v\d+\/)?identifier|AddSession/i.test(link.getAttribute("href") || "")
  );
  if (useAnotherAccount && clickElement(useAnotherAccount)) {
    return { step: "USE_ANOTHER_ACCOUNT_SELECTED" };
  }
  if (/\/challenge\//.test(path) && !document.querySelector("[role='progressbar']")) {
    return { step: "USER_ACTION_REQUIRED" };
  }
  return { step: "WAITING_FOR_SUPPORTED_FORM" };
}

function inspectPendingBrowserAuthentication(targetEmail) {
  const normalized = targetEmail.toLowerCase();
  const selectedControls = Array.from(document.querySelectorAll(
    "[role='link'][jsname='af8ijd'][aria-label]"
  ));
  const selectedLabel = selectedControls.length === 1
    ? selectedControls[0].getAttribute("aria-label") || ""
    : "";
  const selectedEmailTokens = selectedLabel.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi) || [];
  const uniqueSelectedEmails = [...new Set(
    selectedEmailTokens.map((candidate) => candidate.toLowerCase())
  )];
  const accountMatches = selectedControls.length === 1
    && uniqueSelectedEmails.length === 1
    && uniqueSelectedEmails[0] === normalized;
  if (/\/challenge\/pwd(?:\/|$)/.test(location.pathname)) {
    if (!accountMatches) {
      return "TARGET_ACCOUNT_NOT_CONFIRMED";
    }
    const processing = Boolean(document.querySelector(
      "[role='progressbar'],[aria-busy='true'],#passwordNext[aria-disabled='true'],#passwordNext button[disabled]"
    ));
    return processing ? "AUTH_PENDING" : "PASSWORD_CHALLENGE_REMAINS";
  }
  if (/\/challenge\//.test(location.pathname)
      || document.querySelector("iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']")) {
    return "USER_ACTION_REQUIRED";
  }
  return "AUTH_PAGE_CHANGED";
}

async function refreshPendingAuthentication(run) {
  const initialSubmit = run.stage === "BROWSER_CREDENTIAL_SUBMIT_REQUESTED";
  const pendingRecheck = run.stage === "AUTH_PENDING";
  const readyAt = initialSubmit
    ? run.authAttemptAt + BROWSER_AUTH_SETTLE_MS
    : run.nextAuthCheckAt;
  if ((!initialSubmit && !pendingRecheck)
      || !Number.isFinite(readyAt)
      || Date.now() < readyAt
      || !Number.isInteger(run.tabId)
      || !run.currentDocumentId) {
    return run;
  }
  let outcome;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: run.tabId, documentIds: [run.currentDocumentId] },
      func: inspectPendingBrowserAuthentication,
      args: [TARGET_EMAIL]
    });
    outcome = results?.[0]?.result;
  } catch {
    return run;
  }
  return updateRun(run.requestId, (current) => {
    if (current.closed || current.tabId !== run.tabId
        || current.currentDocumentId !== run.currentDocumentId
        || (current.stage !== "BROWSER_CREDENTIAL_SUBMIT_REQUESTED" && current.stage !== "AUTH_PENDING")) {
      return false;
    }
    if (outcome === "TARGET_ACCOUNT_NOT_CONFIRMED") {
      current.stage = "TARGET_ACCOUNT_NOT_CONFIRMED";
      current.note = "The selected Google challenge could not be bound to the target account.";
    } else if (outcome === "PASSWORD_CHALLENGE_REMAINS") {
      current.stage = "USER_ACTION_REQUIRED";
      current.note = "No browser-managed credential or silent SSO completed the Google password challenge.";
    } else if (outcome === "USER_ACTION_REQUIRED") {
      current.stage = "USER_ACTION_REQUIRED";
      current.note = "Google requires MFA, CAPTCHA, device confirmation, or another interactive challenge.";
    } else if (outcome === "AUTH_PENDING") {
      current.authPendingChecks = (current.authPendingChecks || 0) + 1;
      if (current.authPendingChecks <= AUTH_PENDING_RECHECK_LIMIT) {
        current.stage = "AUTH_PENDING";
        current.nextAuthCheckAt = Date.now() + AUTH_PENDING_RECHECK_MS;
        current.note = "Google is still processing browser-managed authentication; no user action is requested yet.";
      } else {
        current.stage = "AUTH_TIMEOUT";
        current.note = "Google remained in a processing state beyond the bounded observation window; authentication outcome is indeterminate.";
      }
    } else if (outcome === "AUTH_PAGE_CHANGED") {
      current.stage = "AUTH_TRANSITION_OBSERVED";
      current.note = "Google changed the authentication page without a new document; waiting for navigation reconciliation.";
    }
  });
}

async function getStatus(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  let run = await getRun(message.requestId);
  if (!run) {
    return { ok: false, error: "RUN_NOT_FOUND" };
  }
  if (!run.closed && Number.isInteger(run.tabId)) {
    const frame = await reconcileCurrentFrame(message.requestId, run.tabId).catch(() => null);
    run = await getRun(message.requestId) || run;
    let frameOrigin;
    try {
      frameOrigin = new URL(frame?.url).origin;
    } catch {
      frameOrigin = null;
    }
    const currentGoogleStepAutomated = run.automatedDocumentId === run.currentDocumentId
      && run.automatedDocumentPath === run.observedPath;
    if (frameOrigin === "https://accounts.google.com"
        && run.currentDocumentId
        && !currentGoogleStepAutomated
        && !PENDING_BROWSER_AUTH_STAGES.has(run.stage)) {
      await automateGoogleLogin(message.requestId, run.tabId);
      run = await getRun(message.requestId) || run;
    }
  }
  run = await refreshPendingAuthentication(run) || run;
  return { ok: true, run: publicRun(run) };
}

async function automateGoogleDocument(requestId, tabId, documentId, documentPath, attempt = 0) {
  const run = await getRun(requestId);
  if (!run || run.closed || run.tabId !== tabId
      || run.currentDocumentId !== documentId
      || run.observedPath !== documentPath
      || (run.automatedDocumentId === documentId && run.automatedDocumentPath === documentPath)
      || (run.automatedDocumentId === documentId && PENDING_BROWSER_AUTH_STAGES.has(run.stage))) {
    return;
  }
  if (attempt === 0 && /\/challenge\/pwd(?:\/|$)/.test(run.observedPath || "")) {
    await new Promise((resolve) => setTimeout(resolve, PASSWORD_MANAGER_SETTLE_MS));
    const current = await getRun(requestId);
    if (!current || current.closed || current.tabId !== tabId
        || current.currentDocumentId !== documentId
        || current.observedPath !== documentPath) {
      return;
    }
  }
  let outcome;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      func: performGoogleStep,
      args: [TARGET_EMAIL]
    });
    outcome = results?.[0]?.result?.step || "WAITING_FOR_SUPPORTED_FORM";
  } catch {
    await updateRun(requestId, (current) => {
      if (current.tabId !== tabId || current.currentDocumentId !== documentId
          || current.observedPath !== documentPath) {
        return false;
      }
      current.stage = "AUTOMATION_ERROR";
      current.note = "The extension could not execute the approved non-secret Google page step.";
      current.automatedDocumentId = documentId;
      current.automatedDocumentPath = documentPath;
    });
    return;
  }
  if (outcome === "WAITING_FOR_SUPPORTED_FORM" && attempt < AUTOMATION_RETRY_LIMIT) {
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    return automateGoogleDocument(requestId, tabId, documentId, documentPath, attempt + 1);
  }
  const stage = outcome === "WAITING_FOR_SUPPORTED_FORM" ? "GOOGLE_PAGE_UNRECOGNIZED" : outcome;
  await updateRun(requestId, (current) => {
    if (current.tabId !== tabId || current.currentDocumentId !== documentId
        || current.observedPath !== documentPath) {
      return false;
    }
    current.stage = stage;
    current.automatedDocumentId = documentId;
    current.automatedDocumentPath = documentPath;
    current.authAttemptAt = stage === "BROWSER_CREDENTIAL_SUBMIT_REQUESTED" ? Date.now() : null;
    current.authPendingChecks = 0;
    current.nextAuthCheckAt = null;
    if (stage === "BROWSER_CREDENTIAL_SUBMIT_REQUESTED") {
      current.note = "The extension clicked Google's Next control without reading the credential field; the browser or IdP must supply authentication.";
    } else if (stage === "USER_ACTION_REQUIRED") {
      current.note = "Google requires MFA, CAPTCHA, device confirmation, or another interactive challenge.";
    } else if (stage === "TARGET_ACCOUNT_NOT_CONFIRMED") {
      current.note = "The current Google challenge is not visibly bound to the target account.";
    } else {
      current.note = null;
    }
  });
}

async function automateGoogleLogin(requestId, tabId) {
  const run = await getRun(requestId);
  const currentStepAutomated = run?.automatedDocumentId === run?.currentDocumentId
    && run?.automatedDocumentPath === run?.observedPath;
  if (!run || run.closed || run.tabId !== tabId || currentStepAutomated
      || (run.automatedDocumentId === run.currentDocumentId && PENDING_BROWSER_AUTH_STAGES.has(run.stage))) {
    return;
  }
  const documentId = run.currentDocumentId || null;
  if (!documentId) {
    await updateRun(requestId, (current) => {
      current.stage = "AUTOMATION_ERROR";
      current.note = "The exact Google document could not be identified.";
      current.automatedDocumentId = null;
      current.automatedDocumentPath = null;
    });
    return;
  }
  const documentPath = run.observedPath || "/";
  const operationKey = `${requestId}:${documentId}`;
  const pending = automationOperations.get(operationKey);
  if (pending) {
    if (pending.documentPath === documentPath) {
      return pending.promise;
    }
    await pending.promise.catch(() => {});
    return automateGoogleLogin(requestId, tabId);
  }
  const operation = automateGoogleDocument(requestId, tabId, documentId, documentPath);
  const trackedOperation = operation.finally(() => {
    if (automationOperations.get(operationKey)?.promise === trackedOperation) {
      automationOperations.delete(operationKey);
    }
  });
  automationOperations.set(operationKey, { documentPath, promise: trackedOperation });
  return trackedOperation;
}

chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isAllowedExternalSender(sender)) {
    sendResponse({ ok: false, error: "UNTRUSTED_SENDER" });
    return false;
  }
  const operation = message?.type === "OPEN_GEMINI"
    ? openGemini(message)
    : message?.type === "GET_STATUS"
      ? getStatus(message)
      : message?.type === "PING"
        ? Promise.resolve({
            ok: true,
            version: chrome.runtime.getManifest().version,
            protocolVersion: PROTOCOL_VERSION,
            capability: "SECRETLESS_GOOGLE_SESSION_LAUNCHER"
          })
        : Promise.resolve({ ok: false, error: "UNKNOWN_MESSAGE" });
  operation.then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: "INTERNAL_ERROR", detail: error instanceof Error ? error.message : "Unknown error" });
  });
  return true;
});

async function updateNavigation(details, completed) {
  if (details.frameId !== 0) {
    return;
  }
  const mapping = await chrome.storage.session.get(tabKey(details.tabId));
  const requestId = mapping[tabKey(details.tabId)];
  if (!requestId) {
    return;
  }
  await updateRun(requestId, (run) => applyNavigation(run, details, completed, !completed));
  let origin;
  try {
    origin = new URL(details.url).origin;
  } catch {
    return;
  }
  if (completed && origin === "https://accounts.google.com") {
    await automateGoogleLogin(requestId, details.tabId);
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  updateNavigation(details, false).catch(() => {});
});

chrome.webNavigation.onCompleted.addListener((details) => {
  updateNavigation(details, true).catch(() => {});
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }
  (async () => {
    const mapping = await chrome.storage.session.get(tabKey(details.tabId));
    const requestId = mapping[tabKey(details.tabId)];
    if (!requestId) {
      return;
    }
    const navigationAt = Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now();
    await updateRun(requestId, (run) => {
      if (run.closed || navigationAt < (run.lastNavigationAt || 0)) {
        return false;
      }
      run.lastNavigationAt = navigationAt;
      run.stage = "NAVIGATION_ERROR";
      run.note = details.error || "Navigation failed";
    });
  })().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GEMINI_DOCUMENT_SIGNAL"
      || message.version !== PROTOCOL_VERSION
      || typeof message.targetAccountObserved !== "boolean"
      || typeof message.identityCheckComplete !== "boolean"
      || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id)) {
    return false;
  }
  (async () => {
    let senderOrigin;
    try {
      senderOrigin = new URL(sender.url).origin;
    } catch {
      sendResponse({ ok: false });
      return;
    }
    if (senderOrigin !== "https://gemini.google.com") {
      sendResponse({ ok: false });
      return;
    }
    const mapping = await chrome.storage.session.get(tabKey(sender.tab.id));
    const requestId = mapping[tabKey(sender.tab.id)];
    if (!requestId) {
      sendResponse({ ok: false });
      return;
    }
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    let frameOrigin;
    try {
      frameOrigin = new URL(frame?.url).origin;
    } catch {
      sendResponse({ ok: false });
      return;
    }
    if (frameOrigin !== "https://gemini.google.com"
        || !sender.documentId || !frame.documentId || sender.documentId !== frame.documentId) {
      sendResponse({ ok: false });
      return;
    }
    const run = await updateRun(requestId, (current) => {
      if (current.closed || current.tabId !== sender.tab.id || current.currentDocumentId !== frame.documentId) {
        return false;
      }
      if (current.targetAccountConfirmed && !message.targetAccountObserved) {
        return false;
      }
      current.observedOrigin = "https://gemini.google.com";
      current.documentObserved = true;
      current.targetAccountConfirmed = message.targetAccountObserved;
      current.identityCheckComplete = message.targetAccountObserved || message.identityCheckComplete;
      current.stage = message.targetAccountObserved
        ? "GEMINI_TARGET_ACCOUNT_CONFIRMED"
        : message.identityCheckComplete
          ? "GEMINI_TARGET_ACCOUNT_NOT_CONFIRMED"
          : "GEMINI_DOCUMENT_OBSERVED";
      current.note = message.targetAccountObserved
        ? "Gemini exposed the exact target account in its rendered account controls."
        : message.identityCheckComplete
          ? "Gemini loaded, but the exact target account was not visible in the inspected account controls."
          : "Gemini loaded; target-account observation is still in progress.";
    });
    sendResponse({
      ok: Boolean(run && !run.closed),
      confirmed: run?.targetAccountConfirmed === true,
      complete: run?.identityCheckComplete === true
    });
  })().catch(() => sendResponse({ ok: false }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const mapping = await chrome.storage.session.get(tabKey(tabId));
    const requestId = mapping[tabKey(tabId)];
    if (!requestId) {
      return;
    }
    await updateRun(requestId, (run) => {
      run.closed = true;
      run.stage = "TAB_CLOSED";
    });
    await chrome.storage.session.remove(tabKey(tabId));
  })().catch(() => {});
});
