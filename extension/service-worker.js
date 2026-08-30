"use strict";

const PROTOCOL_VERSION = 2;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const TARGET_EMAIL = "codeassist.04@easybuy.co.th";
const LOGIN_URL = "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
const RUN_TTL_MS = 10 * 60 * 1000;
const AUTOMATION_RETRY_LIMIT = 4;
const runUpdates = new Map();
const openOperations = new Map();

function runKey(requestId) {
  return `run:${requestId}`;
}

function tabKey(tabId) {
  return `tab:${tabId}`;
}

function isRequestId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function isCredentialPageSender(sender, run, requestId, challengeId) {
  if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0
      || sender.tab?.id !== run.credentialTabId || typeof sender.url !== "string") {
    return false;
  }
  try {
    const senderUrl = new URL(sender.url);
    const loginUrl = new URL(chrome.runtime.getURL("login.html"));
    return senderUrl.origin === loginUrl.origin
      && senderUrl.pathname === loginUrl.pathname
      && senderUrl.searchParams.get("requestId") === requestId
      && senderUrl.searchParams.get("challengeId") === challengeId;
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

function clearChallenge(run) {
  run.credentialChallengeId = null;
  run.credentialDocumentId = null;
  run.credentialTabId = null;
  run.credentialWindowId = null;
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
    if (run.credentialDocumentId && run.credentialDocumentId !== details.documentId) {
      clearChallenge(run);
    }
    run.currentDocumentId = details.documentId;
    run.documentObserved = false;
    run.automatedDocumentId = null;
  }
  run.lastNavigationAt = navigationAt;
  run.observedOrigin = url.origin;
  if (url.origin === "https://accounts.google.com") {
    run.stage = completed ? "GOOGLE_ACCOUNTS_PAGE_LOADED" : "GOOGLE_ACCOUNTS_NAVIGATED";
  } else if (url.origin === "https://gemini.google.com") {
    clearChallenge(run);
    run.stage = run.documentObserved
      ? "GEMINI_DOCUMENT_OBSERVED"
      : completed
        ? "GEMINI_DOCUMENT_LOADED"
        : "GEMINI_NAVIGATED";
  } else {
    run.stage = completed ? "OTHER_PAGE_LOADED" : "OTHER_PAGE_NAVIGATED";
  }
  return true;
}

async function reconcileCurrentFrame(requestId, tabId) {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (!frame?.url) {
    return;
  }
  await updateRun(requestId, (run) => applyNavigation(run, {
    url: frame.url,
    documentId: frame.documentId,
    timeStamp: Date.now()
  }, false, true));
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
    closed: false,
    note: "The extension will select the target account before requesting a one-time password pass-through."
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

async function getStatus(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  const run = await getRun(message.requestId);
  return run ? { ok: true, run: publicRun(run) } : { ok: false, error: "RUN_NOT_FOUND" };
}

function performGoogleStep(targetEmail) {
  function clickElement(element) {
    if (!element) {
      return false;
    }
    element.click();
    return true;
  }
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (document.querySelector("input[type='password'], input[name='Passwd']")) {
    return { step: "PASSWORD_REQUIRED" };
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
    setInputValue(emailInput, targetEmail);
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
  if (document.querySelector("iframe[src*='recaptcha'], input[autocomplete='one-time-code'], input[type='tel']")) {
    return { step: "USER_ACTION_REQUIRED" };
  }
  if (/\/challenge\//.test(location.pathname) && !document.querySelector("[role='progressbar']")) {
    return { step: "USER_ACTION_REQUIRED" };
  }
  return { step: "WAITING_FOR_SUPPORTED_FORM" };
}

function submitGooglePassword(password) {
  const input = document.querySelector("input[type='password'], input[name='Passwd']");
  if (!input) {
    return { submitted: false };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, password);
  } else {
    input.value = password;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const next = document.querySelector("#passwordNext button, #passwordNext, button[type='submit']");
  if (!next) {
    input.value = "";
    return { submitted: false };
  }
  next.click();
  return { submitted: true };
}

async function openCredentialPassThrough(requestId, tabId, documentId) {
  const challengeId = crypto.randomUUID();
  let claimed = false;
  await updateRun(requestId, (run) => {
    if (run.closed || run.tabId !== tabId || run.currentDocumentId !== documentId
        || run.credentialChallengeId) {
      return false;
    }
    claimed = true;
    run.credentialChallengeId = challengeId;
    run.credentialDocumentId = documentId;
    run.stage = "OPENING_PASSWORD_PASS_THROUGH";
    run.automatedDocumentId = documentId;
    run.note = "Google password form detected; opening an extension-owned one-time pass-through page.";
  });
  if (!claimed) {
    return;
  }

  const credentialUrl = chrome.runtime.getURL(
    `login.html?requestId=${encodeURIComponent(requestId)}&challengeId=${encodeURIComponent(challengeId)}`
  );
  try {
    const createdWindow = await chrome.windows.create({
      url: credentialUrl,
      type: "popup",
      width: 520,
      height: 620,
      focused: true
    });
    const tab = createdWindow.tabs?.[0];
    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error("Browser did not return the credential tab.");
    }
    await updateRun(requestId, (run) => {
      if (run.credentialChallengeId !== challengeId || run.currentDocumentId !== documentId) {
        return false;
      }
      run.credentialWindowId = createdWindow.id;
      run.credentialTabId = tab.id;
      run.stage = "PASSWORD_PASS_THROUGH_READY";
    });
  } catch (error) {
    await updateRun(requestId, (run) => {
      if (run.credentialChallengeId !== challengeId) {
        return false;
      }
      clearChallenge(run);
      run.stage = "CREDENTIAL_PAGE_OPEN_FAILED";
      run.note = error instanceof Error ? error.message : "Unknown credential page error";
    });
  }
}

async function automateGoogleLogin(requestId, tabId, attempt = 0) {
  const run = await getRun(requestId);
  if (!run || run.closed || run.tabId !== tabId || run.automatedDocumentId === run.currentDocumentId) {
    return;
  }
  const documentId = run.currentDocumentId || null;
  let outcome;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performGoogleStep,
      args: [TARGET_EMAIL]
    });
    outcome = results?.[0]?.result?.step || "WAITING_FOR_SUPPORTED_FORM";
  } catch {
    await updateRun(requestId, (current) => {
      if (current.tabId !== tabId || current.currentDocumentId !== documentId) {
        return false;
      }
      current.stage = "AUTOMATION_ERROR";
      current.note = "The extension could not execute the approved Google page step.";
      current.automatedDocumentId = documentId;
    });
    return;
  }
  if (outcome === "WAITING_FOR_SUPPORTED_FORM" && attempt < AUTOMATION_RETRY_LIMIT) {
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    return automateGoogleLogin(requestId, tabId, attempt + 1);
  }
  if (outcome === "PASSWORD_REQUIRED") {
    await openCredentialPassThrough(requestId, tabId, documentId);
    return;
  }
  const stage = outcome === "WAITING_FOR_SUPPORTED_FORM" ? "GOOGLE_PAGE_UNRECOGNIZED" : outcome;
  await updateRun(requestId, (current) => {
    if (current.tabId !== tabId || current.currentDocumentId !== documentId) {
      return false;
    }
    current.stage = stage;
    current.automatedDocumentId = documentId;
    current.note = stage === "USER_ACTION_REQUIRED"
      ? "Google requires MFA, CAPTCHA, device confirmation, or another manual challenge."
      : null;
  });
}

async function passPassword(message, sender) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)
      || !isRequestId(message.challengeId) || typeof message.password !== "string"
      || message.password.length < 1 || message.password.length > 1024) {
    return { ok: false, error: "INVALID_REQUEST" };
  }
  const password = message.password;
  message.password = "";
  let claimedTarget = null;
  await updateRun(message.requestId, (run) => {
    if (run.closed || run.credentialChallengeId !== message.challengeId
        || run.credentialDocumentId !== run.currentDocumentId
        || !isCredentialPageSender(sender, run, message.requestId, message.challengeId)) {
      return false;
    }
    claimedTarget = { tabId: run.tabId, documentId: run.currentDocumentId };
    clearChallenge(run);
    run.stage = "PASSWORD_PASS_THROUGH_IN_FLIGHT";
    run.note = "The one-time challenge was consumed before exact-document injection.";
  });
  if (!claimedTarget) {
    return { ok: false, error: "STALE_OR_UNTRUSTED_CHALLENGE" };
  }

  let submitted = false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: claimedTarget.tabId, documentIds: [claimedTarget.documentId] },
      func: submitGooglePassword,
      args: [password]
    });
    submitted = results?.[0]?.result?.submitted === true;
  } catch {
    submitted = false;
  }
  await updateRun(message.requestId, (current) => {
    if (current.tabId !== claimedTarget.tabId
        || current.currentDocumentId !== claimedTarget.documentId) {
      return false;
    }
    current.stage = submitted ? "PASSWORD_SUBMITTED" : "PASSWORD_SUBMISSION_FAILED";
    current.note = submitted
      ? "The credential passed directly to the exact Google password document and was not retained."
      : "The exact Google password document was unavailable; the credential was not retained.";
  });
  return { ok: submitted, error: submitted ? null : "PASSWORD_SUBMISSION_FAILED" };
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
            capability: "GOOGLE_LOGIN_AUTOMATION_WITH_ONE_TIME_PASSWORD_PASS_THROUGH"
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
      clearChallenge(run);
      run.stage = "NAVIGATION_ERROR";
      run.note = details.error || "Navigation failed";
    });
  })().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PASS_PASSWORD") {
    passPassword(message, sender).then(sendResponse).catch(() => {
      message.password = "";
      sendResponse({ ok: false, error: "INTERNAL_ERROR" });
    });
    return true;
  }
  if (message?.type !== "GEMINI_DOCUMENT_SIGNAL"
      || message.version !== PROTOCOL_VERSION
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
      current.stage = "GEMINI_DOCUMENT_OBSERVED";
      current.observedOrigin = "https://gemini.google.com";
      current.documentObserved = true;
      current.note = "Gemini loaded after the extension-mediated flow; account identity still requires visible verification.";
    });
    sendResponse({ ok: Boolean(run && !run.closed) });
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
      clearChallenge(run);
      run.stage = "TAB_CLOSED";
    });
    await chrome.storage.session.remove(tabKey(tabId));
  })().catch(() => {});
});
