"use strict";

const PROTOCOL_VERSION = 1;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const GEMINI_URL = "https://gemini.google.com/app";
const RUN_TTL_MS = 10 * 60 * 1000;

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

async function putRun(run) {
  run.updatedAt = Date.now();
  await chrome.storage.session.set({ [runKey(run.requestId)]: run });
  return run;
}

async function getRun(requestId) {
  const result = await chrome.storage.session.get(runKey(requestId));
  const run = result[runKey(requestId)];

  if (!run || Date.now() - run.createdAt > RUN_TTL_MS) {
    return null;
  }

  return run;
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

async function openGemini(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }

  const existing = await getRun(message.requestId);
  if (existing) {
    return { ok: true, run: publicRun(existing), replayed: true };
  }

  const run = await putRun({
    requestId: message.requestId,
    stage: "OPENING_WINDOW",
    createdAt: Date.now(),
    observedOrigin: null,
    documentObserved: false,
    closed: false,
    note: "Login identity is not asserted by this POC."
  });

  try {
    const createdWindow = await chrome.windows.create({
      url: GEMINI_URL,
      type: "normal",
      focused: true
    });
    const tab = createdWindow.tabs?.[0];

    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error("Edge did not return the created tab.");
    }

    run.windowId = createdWindow.id;
    run.tabId = tab.id;
    run.stage = "WINDOW_CREATED";
    await chrome.storage.session.set({ [tabKey(tab.id)]: message.requestId });
    await putRun(run);
    return { ok: true, run: publicRun(run), replayed: false };
  } catch (error) {
    run.stage = "OPEN_FAILED";
    run.note = error instanceof Error ? error.message : "Unknown launch error";
    await putRun(run);
    return { ok: false, error: "OPEN_FAILED", run: publicRun(run) };
  }
}

async function getStatus(message) {
  if (message.version !== PROTOCOL_VERSION || !isRequestId(message.requestId)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }

  const run = await getRun(message.requestId);
  return run
    ? { ok: true, run: publicRun(run) }
    : { ok: false, error: "RUN_NOT_FOUND" };
}

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
            capability: "OPEN_AND_OBSERVE_TAB_LIFECYCLE"
          })
        : Promise.resolve({ ok: false, error: "UNKNOWN_MESSAGE" });

  operation.then(sendResponse).catch((error) => {
    sendResponse({
      ok: false,
      error: "INTERNAL_ERROR",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
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

  const run = await getRun(requestId);
  if (!run || run.closed) {
    return;
  }

  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }

  run.observedOrigin = url.origin;
  if (url.origin === "https://accounts.google.com") {
    run.stage = completed ? "GOOGLE_SIGN_IN_PAGE_LOADED" : "GOOGLE_SIGN_IN_REQUIRED";
  } else if (url.origin === "https://gemini.google.com") {
    run.stage = completed ? "GEMINI_DOCUMENT_LOADED" : "GEMINI_NAVIGATED";
  } else {
    run.stage = completed ? "OTHER_PAGE_LOADED" : "OTHER_PAGE_NAVIGATED";
  }
  await putRun(run);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  updateNavigation(details, false).catch(() => {});
});

chrome.webNavigation.onCompleted.addListener((details) => {
  updateNavigation(details, true).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GEMINI_DOCUMENT_SIGNAL" || !Number.isInteger(sender.tab?.id)) {
    return false;
  }

  (async () => {
    const mapping = await chrome.storage.session.get(tabKey(sender.tab.id));
    const requestId = mapping[tabKey(sender.tab.id)];
    const run = requestId ? await getRun(requestId) : null;
    if (!run || run.closed) {
      sendResponse({ ok: false });
      return;
    }

    run.stage = "GEMINI_DOCUMENT_OBSERVED";
    run.observedOrigin = "https://gemini.google.com";
    run.documentObserved = true;
    await putRun(run);
    sendResponse({ ok: true });
  })().catch(() => sendResponse({ ok: false }));
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  (async () => {
    const all = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("run:") || value.windowId !== windowId || value.closed) {
        continue;
      }
      value.closed = true;
      value.stage = "WINDOW_CLOSED";
      await putRun(value);
    }
  })().catch(() => {});
});
