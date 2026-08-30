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
let performGoogleStepCallCount = 0;
let scriptGate = null;
let scriptStarted = null;
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
    getManifest() { return { version: "0.4.6" }; },
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
        performGoogleStepCallCount += 1;
        scriptStarted?.();
        if (scriptGate) await scriptGate;
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

function runPasswordStep(markers, processing = false, selectedControl = null) {
  let clicked = false;
  workerContext.location = { pathname: "/v3/signin/challenge/pwd" };
  workerContext.document = {
    querySelectorAll(selector) {
      if (selector === "[role='link'][jsname='af8ijd'][aria-label]") {
        return selectedControl ? (Array.isArray(selectedControl) ? selectedControl : [selectedControl]) : [];
      }
      return markers;
    },
    querySelector(selector) {
      if (selector.includes("recaptcha") || selector.includes("one-time-code")) return null;
      if (selector === "[role='link'][jsname='af8ijd'][aria-label]") return selectedControl;
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

  currentFrame = { url: "https://accounts.google.com/v3/signin/challenge/pwd", documentId: "doc-account-chooser" };
  scriptStep = "BROWSER_CREDENTIAL_SUBMIT_REQUESTED";
  performGoogleStepCallCount = 0;
  const started = deferred();
  const gate = deferred();
  scriptStarted = started.resolve;
  scriptGate = gate.promise;
  const recoveredStatus = external({ type: "GET_STATUS", version: 3, requestId });
  await started.promise;
  listeners.completed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 2,
    documentId: currentFrame.documentId
  });
  await flush();
  gate.resolve();
  status = await recoveredStatus;
  scriptGate = null;
  scriptStarted = null;
  assert.equal(status.run.stage, "BROWSER_CREDENTIAL_SUBMIT_REQUESTED");
  assert.equal(status.run.documentObserved, false, "GET_STATUS must reconcile a missed navigation event");
  assert.equal(performGoogleStepCallCount, 1, "event and status recovery must share one automation operation");
  assert.equal(createdOptions.length, 1, "extension must never open a credential page");

  listeners.completed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 3
  });
  await flush();
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(
    status.run.stage,
    "BROWSER_CREDENTIAL_SUBMIT_REQUESTED",
    "late completion for the automated document must not clobber authentication progress"
  );

  store[`run:${requestId}`].stage = "BROWSER_CREDENTIAL_SUBMIT_REQUESTED";
  store[`run:${requestId}`].authAttemptAt = Date.now() - 5000;
  store[`run:${requestId}`].authPendingChecks = 0;
  store[`run:${requestId}`].nextAuthCheckAt = null;
  currentFrame = { url: "https://accounts.google.com/v3/signin/challenge/otp", documentId: "doc-account-chooser" };
  scriptStep = "AUTH_PAGE_CHANGED";
  status = await external({ type: "GET_STATUS", version: 3, requestId });
  assert.equal(
    status.run.stage,
    "AUTH_TRANSITION_OBSERVED",
    "same-document challenge-path reconciliation must preserve auth state until inspection"
  );

  currentFrame = { url: "https://accounts.google.com/v3/signin/challenge/pwd", documentId: "doc-account-chooser" };

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
  assert.equal(exactAccount.outcome.step, "TARGET_ACCOUNT_NOT_CONFIRMED");
  assert.equal(exactAccount.clicked, false, "a bare profile marker is not selected-account evidence");

  const selectedAriaControl = runPasswordStep(
    [accountMarker({ "data-profile-identifier": "" })],
    false,
    accountMarker({
      role: "link",
      jsname: "af8ijd",
      "aria-label": "เลือก codeassist.04@easybuy.co.th อยู่ สลับบัญชี"
    })
  );
  assert.equal(selectedAriaControl.outcome.step, "BROWSER_CREDENTIAL_SUBMIT_REQUESTED");
  assert.equal(selectedAriaControl.clicked, true, "the observed selected-account control must authorize the target only");

  const ambiguousSelectedControls = runPasswordStep([], false, [
    accountMarker({ "aria-label": "เลือก codeassist.04@easybuy.co.th อยู่ สลับบัญชี" }),
    accountMarker({ "aria-label": "เลือก other-user@example.com อยู่ สลับบัญชี" })
  ]);
  assert.equal(ambiguousSelectedControls.outcome.step, "TARGET_ACCOUNT_NOT_CONFIRMED");
  assert.equal(ambiguousSelectedControls.clicked, false, "multiple selected-account controls must fail closed");

  const ambiguousSelectedLabel = runPasswordStep([], false, accountMarker({
    "aria-label": "เลือก codeassist.04@easybuy.co.th และ other-user@example.com"
  }));
  assert.equal(ambiguousSelectedLabel.outcome.step, "TARGET_ACCOUNT_NOT_CONFIRMED");
  assert.equal(ambiguousSelectedLabel.clicked, false, "multiple account tokens must fail closed");

  workerContext.document = {
    querySelectorAll(selector) {
      return selector === "[role='link'][jsname='af8ijd'][aria-label]"
        ? [accountMarker({ "aria-label": "เลือก codeassist.04@easybuy.co.th อยู่ สลับบัญชี" })]
        : [];
    },
    querySelector(selector) {
      if (selector === "[role='link'][jsname='af8ijd'][aria-label]") return null;
      return {};
    }
  };
  workerContext.location = { pathname: "/v3/signin/challenge/pwd" };
  assert.equal(
    workerContext.inspectPendingBrowserAuthentication("codeassist.04@easybuy.co.th"),
    "AUTH_PENDING"
  );

  store[`run:${requestId}`].stage = "BROWSER_CREDENTIAL_SUBMIT_REQUESTED";
  store[`run:${requestId}`].authAttemptAt = Date.now() - 5000;
  store[`run:${requestId}`].authPendingChecks = 0;
  store[`run:${requestId}`].nextAuthCheckAt = null;
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
  console.log("PASS missed-navigation-status-reconciliation");
  console.log("PASS per-document-automation-single-flight");
  console.log("PASS late-completion-does-not-clobber-auth-state");
  console.log("PASS same-document-path-reconciliation-preserves-auth-state");
  console.log("PASS same-document-new-google-step-is-automated-once");
  console.log("PASS no-extension-credential-page-or-message");
  console.log("PASS strict-password-challenge-account-binding");
  console.log("PASS ambiguous-selected-account-evidence-fails-closed");
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
