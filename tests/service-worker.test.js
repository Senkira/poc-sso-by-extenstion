"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

const EXTENSION_ID = "jeenmgigpkffleijbmfciffiodlcdafh";
const store = {};
const listeners = {};
const createdOptions = [];
let scriptStep = "ACCOUNT_SELECTED";
let submittedPassword = null;
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
      if (createdOptions.length === 1) {
        assert.equal(options.url.startsWith("https://accounts.google.com/AccountChooser?"), true);
        currentFrame = { url: options.url, documentId: "doc-account-chooser" };
        listeners.committed({
          frameId: 0,
          tabId: 61,
          url: currentFrame.url,
          timeStamp: Date.now(),
          documentId: currentFrame.documentId
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { id: 51, tabs: [{ id: 61 }] };
      }
      assert.match(options.url, /^chrome-extension:\/\/jeenmgigpkffleijbmfciffiodlcdafh\/login\.html\?requestId=.*&challengeId=/);
      return { id: 50, tabs: [{ id: 60 }] };
    }
  },
  runtime: {
    id: EXTENSION_ID,
    getURL(path) { return `chrome-extension://${EXTENSION_ID}/${path}`; },
    getManifest() { return { version: "0.3.0" }; },
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
      if (options.func.name === "performGoogleStep") {
        assert.deepEqual(Array.from(options.args), ["codeassist.04@easybuy.co.th"]);
        return [{ result: { step: scriptStep } }];
      }
      if (options.func.name === "submitGooglePassword") {
        submittedPassword = options.args[0];
        return [{ result: { submitted: true } }];
      }
      throw new Error("Unexpected injected function");
    }
  },
  tabs: { onRemoved: event("tabRemoved") }
};

vm.runInNewContext(
  fs.readFileSync("extension/service-worker.js", "utf8"),
  {
    chrome,
    URL,
    Map,
    Promise,
    Date,
    Number,
    Error,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "223e4567-e89b-42d3-a456-426614174000" },
    encodeURIComponent
  }
);

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
    external({ type: "OPEN_GEMINI", version: 2, requestId }),
    external({ type: "OPEN_GEMINI", version: 2, requestId })
  ]);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(createdOptions.length, 1, "same UUID must create exactly one Google window");

  scriptStep = "ACCOUNT_SELECTED";
  listeners.completed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 1,
    documentId: currentFrame.documentId
  });
  await flush();

  currentFrame = { url: "https://accounts.google.com/v3/signin/challenge/pwd", documentId: "doc-password" };
  listeners.committed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 2,
    documentId: currentFrame.documentId
  });
  await flush();
  scriptStep = "PASSWORD_REQUIRED";
  listeners.completed({
    frameId: 0,
    tabId: 61,
    url: currentFrame.url,
    timeStamp: Date.now() + 3,
    documentId: currentFrame.documentId
  });
  await flush();
  assert.equal(createdOptions.length, 2, "credential page must open only after Google password form detection");
  const credentialUrl = new URL(createdOptions[1].url);
  const challengeId = credentialUrl.searchParams.get("challengeId");

  const oneTimeValue = "one-time-sensitive-value";
  const passMessage = {
    type: "PASS_PASSWORD",
    version: 2,
    requestId,
    challengeId,
    password: oneTimeValue
  };
  const passResult = await internal(passMessage, {
    id: EXTENSION_ID,
    frameId: 0,
    tab: { id: 60 },
    url: createdOptions[1].url
  });
  assert.equal(passResult.ok, true);
  assert.equal(passMessage.password, "", "worker must clear the received message field");
  assert.equal(submittedPassword, oneTimeValue);
  assert.equal(JSON.stringify(store).includes(oneTimeValue), false, "password must never enter extension storage");
  const afterPassword = await external({ type: "GET_STATUS", version: 2, requestId });
  assert.equal(JSON.stringify(afterPassword).includes(oneTimeValue), false, "password must never enter public status");
  assert.equal(afterPassword.run.stage, "PASSWORD_SUBMITTED");

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
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 2 },
    { frameId: 0, url: currentFrame.url, documentId: currentFrame.documentId, tab: { id: 61 } }
  );
  const observed = await external({ type: "GET_STATUS", version: 2, requestId });
  assert.equal(observed.run.stage, "GEMINI_DOCUMENT_OBSERVED");
  assert.equal(observed.run.documentObserved, true);

  const wrongVersionResult = listeners.internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 1 },
    { frameId: 0, url: currentFrame.url, documentId: currentFrame.documentId, tab: { id: 61 } },
    () => { throw new Error("wrong version must not respond"); }
  );
  assert.equal(wrongVersionResult, false);

  listeners.tabRemoved(61);
  await flush();
  const closed = await external({ type: "GET_STATUS", version: 2, requestId });
  assert.equal(closed.run.stage, "TAB_CLOSED");

  const rejected = await external(
    { type: "PING", version: 2 },
    { frameId: 0, url: "https://example.com/" }
  );
  assert.equal(rejected.error, "UNTRUSTED_SENDER");

  console.log("PASS concurrent-google-window-idempotency");
  console.log("PASS google-window-mapping-reconciliation");
  console.log("PASS credential-page-opens-only-after-password-challenge");
  console.log("PASS password-one-time-pass-through-no-storage-or-status");
  console.log("PASS exact-document-observation");
  console.log("PASS exact-tab-close-state");
  console.log("PASS untrusted-origin-rejection");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
