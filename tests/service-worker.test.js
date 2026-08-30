"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

const EXTENSION_ID = "jeenmgigpkffleijbmfciffiodlcdafh";
const store = {};
const listeners = {};
const createdOptions = [];
let scriptStep = "ACCOUNT_SELECTED";
let currentFrame = { url: "about:blank", documentId: "doc-blank" };
const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });

const chrome = {
  storage: {
    session: {
      async get(key) { return key === null ? { ...store } : { [key]: store[key] }; },
      async set(values) { Object.assign(store, values); },
      async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete store[item]; },
      async setAccessLevel() {}
    }
  },
  windows: {
    async create(options) {
      createdOptions.push(options);
      assert.equal(options.url.startsWith("https://accounts.google.com/AccountChooser?"), true);
      currentFrame = { url: options.url, documentId: "doc-account-chooser" };
      return { id: 51, tabs: [{ id: 61 }] };
    }
  },
  runtime: {
    id: EXTENSION_ID,
    getManifest() { return { version: "0.4.1" }; },
    onMessageExternal: event("external"),
    onMessage: event("internal")
  },
  webNavigation: {
    async getFrame() { return { ...currentFrame }; },
    onCommitted: event("committed"),
    onCompleted: event("completed"),
    onErrorOccurred: event("navigationError")
  },
  scripting: {
    async executeScript(options) {
      assert.deepEqual(Array.from(options.target.documentIds || []), [currentFrame.documentId]);
      assert.deepEqual(Array.from(options.args), ["codeassist.04@easybuy.co.th"]);
      if (options.func.name === "performGoogleStep") {
        return [{ result: { step: scriptStep } }];
      }
      if (options.func.name === "inspectPendingBrowserAuthentication") {
        return [{ result: scriptStep }];
      }
      throw new Error("Unexpected injected function");
    }
  },
  tabs: { onRemoved: event("tabRemoved") }
};

const workerContext = {
    chrome,
    URL,
    Map,
    Promise,
    Date,
    Number,
    Error,
    setTimeout(callback) { Promise.resolve().then(callback); return 1; },
    clearTimeout() {}
};
vm.runInNewContext(fs.readFileSync("extension/service-worker.js", "utf8"), workerContext);

function accountMarker(attributes = {}, textContent = "") {
  return {
    textContent,
    getAttribute(name) { return attributes[name] ?? null; }
  };
}

function runPasswordStep(markers, processing = false) {
  let clicked = false;
  workerContext.location = { pathname: "/v3/signin/challenge/pwd" };
  workerContext.document = {
    querySelectorAll() { return markers; },
    querySelector(selector) {
      if (selector.includes("recaptcha") || selector.includes("one-time-code")) return null;
      if (selector.includes("progressbar")) return processing ? {} : null;
      if (selector.includes("#passwordNext")) return { click() { clicked = true; } };
      return null;
    }
  };
  return { outcome: workerContext.performGoogleStep("codeassist.04@easybuy.co.th"), clicked };
}

function external(message, sender = { frameId: 0, url: "https://poc-after-sso-login-gemini.web.app/" }) {
  return new Promise((resolve) => listeners.external(message, sender, resolve));
}

function internal(message, sender) {
  return new Promise((resolve) => listeners.internal(message, sender, resolve));
}

async function flush(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function main() {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const [first, replay] = await Promise.all([
    external({ type: "OPEN_GEMINI", version: 3, requestId }),
    external({ type: "OPEN_GEMINI", version: 3, requestId })
  ]);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(createdOptions.length, 1, "same UUID must create exactly one Google window");

  listeners.completed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 1,
    documentId: currentFrame.documentId
  });
  await flush();
  let status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "ACCOUNT_SELECTED");

  currentFrame = { url: "https://accounts.google.com/v3/signin/challenge/pwd", documentId: "doc-password" };
  listeners.committed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 2,
    documentId: currentFrame.documentId
  });
  await flush();
  scriptStep = "BROWSER_CREDENTIAL_SUBMIT_REQUESTED";
  listeners.completed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 3,
    documentId: currentFrame.documentId
  });
  await flush();
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "BROWSER_CREDENTIAL_SUBMIT_REQUESTED");
  assert.equal(createdOptions.length, 1, "extension must never open a credential page");

  const source = fs.readFileSync("extension/service-worker.js", "utf8");
  assert.doesNotMatch(source, /PASS_PASSWORD|submitGooglePassword|openCredentialPassThrough|login\.html/);
  assert.doesNotMatch(source, /input\[type=['"]password|input\[name=['"]Passwd/);
  assert.doesNotMatch(source, /chrome\.cookies|chrome\.identity/);

  const wrongAccount = runPasswordStep([
    accountMarker({ "data-email": "other-user@example.com" }),
    accountMarker({ role: "link" }, "codeassist.04@easybuy.co.th")
  ]);
  assert.equal(wrongAccount.outcome.step, "TARGET_ACCOUNT_NOT_CONFIRMED");
  assert.equal(wrongAccount.clicked, false, "unrelated link text must never authorize password submission");

  const exactAccount = runPasswordStep([
    accountMarker({ "data-profile-identifier": "codeassist.04@easybuy.co.th" })
  ]);
  assert.equal(exactAccount.outcome.step, "BROWSER_CREDENTIAL_SUBMIT_REQUESTED");
  assert.equal(exactAccount.clicked, true);

  workerContext.document = {
    querySelectorAll() { return [accountMarker({ "data-email": "codeassist.04@easybuy.co.th" })]; },
    querySelector() { return {}; }
  };
  workerContext.location = { pathname: "/v3/signin/challenge/pwd" };
  assert.equal(
    workerContext.inspectPendingBrowserAuthentication("codeassist.04@easybuy.co.th"),
    "AUTH_PENDING"
  );

  store[`run:${requestId}`].authAttemptAt = Date.now() - 5000;
  scriptStep = "AUTH_PENDING";
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "AUTH_PENDING");
  store[`run:${requestId}`].nextAuthCheckAt = Date.now() - 1;
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "AUTH_PENDING");
  store[`run:${requestId}`].nextAuthCheckAt = Date.now() - 1;
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "AUTH_TIMEOUT");
  assert.match(status.run.note, /indeterminate/);

  store[`run:${requestId}`].stage = "BROWSER_CREDENTIAL_SUBMIT_REQUESTED";
  store[`run:${requestId}`].authAttemptAt = Date.now() - 5000;
  store[`run:${requestId}`].authPendingChecks = 0;
  store[`run:${requestId}`].nextAuthCheckAt = null;
  scriptStep = "PASSWORD_CHALLENGE_REMAINS";
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "USER_ACTION_REQUIRED");
  assert.match(status.run.note, /No browser-managed credential/);

  currentFrame = { url: "https://gemini.google.com/app", documentId: "doc-gemini" };
  listeners.committed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 4,
    documentId: currentFrame.documentId
  });
  await flush();
  await internal(
    {
      type: "GEMINI_DOCUMENT_SIGNAL",
      version: 3,
      targetAccountObserved: true,
      identityCheckComplete: true
    },
    { frameId: 0, url: currentFrame.url, documentId: currentFrame.documentId, tab: { id: 61 } }
  );
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "GEMINI_TARGET_ACCOUNT_CONFIRMED");
  assert.equal(status.run.targetAccountConfirmed, true);

  await internal(
    {
      type: "GEMINI_DOCUMENT_SIGNAL",
      version: 3,
      targetAccountObserved: false,
      identityCheckComplete: true
    },
    { frameId: 0, url: currentFrame.url, documentId: currentFrame.documentId, tab: { id: 61 } }
  );
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "GEMINI_TARGET_ACCOUNT_CONFIRMED", "confirmed identity must not be downgraded");

  const wrongVersionResult = listeners.internal(
    {
      type: "GEMINI_DOCUMENT_SIGNAL",
      version: 2,
      targetAccountObserved: true,
      identityCheckComplete: true
    },
    { frameId: 0, url: currentFrame.url, documentId: currentFrame.documentId, tab: { id: 61 } },
    () => { throw new Error("wrong version must not respond"); }
  );
  assert.equal(wrongVersionResult, false);

  listeners.tabRemoved(61);
  await flush();
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(status.run.stage, "TAB_CLOSED");

  const rejected = await external(
    { type: "PING", version: 3 },
    { frameId: 0, url: "https://example.com/" }
  );
  assert.equal(rejected.error, "UNTRUSTED_SENDER");

  console.log("PASS concurrent-window-idempotency");
  console.log("PASS exact-document-non-secret-automation");
  console.log("PASS no-extension-credential-page-or-message");
  console.log("PASS strict-password-challenge-account-binding");
  console.log("PASS processing-state-bounded-reconciliation");
  console.log("PASS browser-credential-unavailable-fails-closed");
  console.log("PASS target-account-confirmation-is-monotonic");
  console.log("PASS exact-tab-close-state");
  console.log("PASS untrusted-origin-rejection");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
