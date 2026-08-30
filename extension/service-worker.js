"use strict";

const PROTOCOL_VERSION = 1;
const ALLOWED_ORIGIN = "https://poc-after-sso-login-gemini.web.app";
const LOGIN_URL = "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
const RUN_TTL_MS = 10 * 60 * 1000;
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
  }

  run.lastNavigationAt = navigationAt;
  run.observedOrigin = url.origin;
  if (url.origin === "https://accounts.google.com") {
    run.stage = completed ? "GOOGLE_ACCOUNTS_PAGE_LOADED" : "GOOGLE_ACCOUNTS_NAVIGATED";
  } else if (url.origin === "https://gemini.google.com") {
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
    stage: "OPENING_WINDOW",
    createdAt: Date.now(),
    observedOrigin: null,
    documentObserved: false,
    closed: false,
    note: "Select and authenticate the approved Google account. Login identity is not asserted by this POC."
  });

  try {
    const createdWindow = await chrome.windows.create({
      url: LOGIN_URL,
      type: "normal",
      focused: true
    });
    const tab = createdWindow.tabs?.[0];

    if (!tab || !Number.isInteger(tab.id)) {
      throw new Error("Browser did not return the created tab.");
    }

    await chrome.storage.session.set({ [tabKey(tab.id)]: message.requestId });
    const savedRun = await updateRun(message.requestId, (current) => {
      current.windowId = createdWindow.id;
      current.tabId = tab.id;
      if (current.stage === "OPENING_WINDOW") {
        current.stage = "WINDOW_CREATED";
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

  await updateRun(requestId, (run) => applyNavigation(run, details, completed, !completed));
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
        || !sender.documentId
        || !frame.documentId
        || sender.documentId !== frame.documentId) {
      sendResponse({ ok: false });
      return;
    }

    const run = await updateRun(requestId, (current) => {
      if (current.closed
          || current.tabId !== sender.tab.id
          || current.currentDocumentId !== frame.documentId) {
        return false;
      }
      current.stage = "GEMINI_DOCUMENT_OBSERVED";
      current.observedOrigin = "https://gemini.google.com";
      current.documentObserved = true;
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
      run.stage = "TAB_CLOSED";
    });
    await chrome.storage.session.remove(tabKey(tabId));
  })().catch(() => {});
});
