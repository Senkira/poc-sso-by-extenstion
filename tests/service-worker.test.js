"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

const listeners = {};
const createdWindows = [];
const updatedWindows = [];
const removedWindows = [];
const updatedTabs = [];
const nativeMessages = [];
const createdAlarms = [];
const clearedAlarms = [];
let googleStep = "PASSWORD_REQUIRED";
const pocIdToken = "test-id-token".padEnd(120, "x");
const sessionState = {};
let sessionStorageWrites = 0;
let currentFrame = { documentId: "about-doc", url: "about:blank" };
let existingWindows = [];
let failNextTabUpdate = false;

const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
const chrome = {
  alarms: {
    create(name, options) { createdAlarms.push({ name, options }); },
    async clear(name) { clearedAlarms.push(name); return true; },
    onAlarm: event("alarm")
  },
  extension: {
    isAllowedIncognitoAccess(callback) { callback(true); }
  },
  runtime: {
    getManifest() { return { version: "0.9.2" }; },
    async sendNativeMessage(host, message) {
      nativeMessages.push({ host, message });
      assert.equal(message.version, 9);
      if (message.action === "authenticatePoc") {
        return { ok: true, username: "O1234567", idToken: pocIdToken, expiresIn: "3600" };
      }
      return { ok: true, email: "codeassist.04@easybuy.co.th", password: "test-only-password" };
    },
    onMessageExternal: event("external"),
    onMessage: event("internal")
  },
  storage: {
    session: {
      async get(key) { return { [key]: sessionState[key] }; },
      async set(values) { Object.assign(sessionState, values); sessionStorageWrites += 1; }
    }
  },
  windows: {
    async getAll() { return existingWindows; },
    async create(options) {
      createdWindows.push(options);
      return { id: 71, tabs: [{ id: 81 }] };
    },
    async update(id, options) { updatedWindows.push({ id, options }); },
    async remove(id) { removedWindows.push(id); }
  },
  scripting: {
    async executeScript(options) {
      const documentId = options.target.documentIds?.[0] || currentFrame.documentId;
      if (options.func.name === "inspectGooglePage") return [{ documentId, result: { step: googleStep } }];
      if (options.func.name === "submitPassword") {
        assert.equal(options.args[0], "codeassist.04@easybuy.co.th");
        assert.equal(options.args[1], "test-only-password");
        assert.match(options.args[2], /challenge\/pwd/);
        return [{ documentId, result: { step: "PASSWORD_SUBMITTED" } }];
      }
      if (options.func.name === "inspectGeminiActiveAccount") return [{ documentId, result: true }];
      if (options.func.name === "injectPrompt") {
        assert.equal(options.args[0], "codeassist.04@easybuy.co.th");
        return [{ documentId, result: { ok: true } }];
      }
      if (options.func.name === "clearPasswordInput") return [{ documentId, result: true }];
      throw new Error(`Unexpected script: ${options.func.name}`);
    }
  },
  webNavigation: {
    async getFrame() { return { ...currentFrame }; },
    onCompleted: event("completed"),
    onCommitted: event("committed")
  },
  tabs: {
    async update(id, options) {
      updatedTabs.push({ id, options });
      if (failNextTabUpdate) {
        failNextTabUpdate = false;
        throw new Error("simulated navigation failure");
      }
      return { id, incognito: true, ...options };
    },
    async get(id) { return { id, incognito: true, url: currentFrame.url }; },
    onRemoved: event("removed")
  }
};

const context = {
  chrome,
  URL,
  Map,
  Set,
  Promise,
  Date,
  Number,
  Error,
  encodeURIComponent,
  async fetch(url, options) {
    assert.match(url, /identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/);
    assert.equal(JSON.parse(options.body).idToken, pocIdToken);
    return {
      ok: true,
      async json() {
        return { users: [{ localId: "VHX1QkrsewSrrWB0g3BjyHepdWX2", email: "o1234567@poc.invalid" }] };
      }
    };
  },
  setTimeout(callback, delayMs) { if (delayMs <= 1000) Promise.resolve().then(callback); return 1; },
  clearTimeout() {}
};
const workerSource = fs.readFileSync("extension/service-worker.js", "utf8");
function loadWorker() {
  vm.runInNewContext(workerSource, { ...context });
}
loadWorker();

function external(message, sender = { frameId: 0, url: "https://poc-after-sso-login-gemini.web.app/" }) {
  return new Promise((resolve) => listeners.external(message, sender, resolve));
}

function internal(message, sender) {
  return new Promise((resolve) => listeners.internal(message, sender, resolve));
}

async function flush(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function main() {
  const ping = await external({ type: "PING", version: 9 });
  assert.equal(ping.version, "0.9.2");
  assert.equal(ping.protocolVersion, 9);
  assert.equal(ping.capability, "EXTENSION_AGENT_ONE_SHOT_BRIDGE");
  assert.equal(ping.incognitoAccessAllowed, true);

  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const pocLogin = await external({
    type: "AUTHENTICATE_POC", version: 9, requestId, username: "O1234567"
  });
  assert.equal(pocLogin.ok, true);
  assert.equal(pocLogin.idToken, pocIdToken);
  assert.equal(Object.prototype.hasOwnProperty.call(pocLogin, "password"), false);
  assert.equal(nativeMessages[0].message.action, "authenticatePoc");

  const denied = await external({ type: "START_AGENT", version: 9, requestId });
  assert.equal(denied.error, "POC_AUTH_REQUIRED");
  assert.equal(createdWindows.length, 0);

  const started = await external({ type: "START_AGENT", version: 9, requestId, pocIdToken });
  assert.equal(started.ok, true);
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].incognito, true);
  assert.equal(createdWindows[0].focused, false);
  assert.equal(createdWindows[0].state, "minimized");
  assert.equal(createdWindows[0].url, "about:blank");
  assert.match(updatedTabs[0].options.url, /accounts\.google\.com/);
  assert.equal(sessionStorageWrites > 0, true);

  const parallel = await external({
    type: "START_AGENT",
    version: 9,
    requestId: "123e4567-e89b-42d3-a456-426614174099",
    pocIdToken
  });
  assert.equal(parallel.error, "RUN_ALREADY_ACTIVE");

  loadWorker();

  currentFrame = {
    documentId: "google-password-doc",
    url: "https://accounts.google.com/v3/signin/challenge/pwd"
  };
  listeners.completed({
    frameId: 0,
    tabId: 81,
    documentId: currentFrame.documentId,
    url: currentFrame.url
  });
  await flush();
  let status = await external({ type: "GET_STATUS", version: 9, requestId });
  assert.equal(status.run.stage, "PASSWORD_SUBMITTED");
  assert.equal(status.run.credentialDelivered, true);
  assert.equal(Object.prototype.hasOwnProperty.call(status.run, "password"), false);
  assert.equal(nativeMessages.length, 2);
  assert.equal(nativeMessages[1].host, "com.senkira.gemini_extension_agent");
  assert.equal(nativeMessages[1].message.action, "getGoogleCredential");
  assert.equal(createdAlarms[0].name, `gemini-auth-timeout:${requestId}`);

  currentFrame = { documentId: "gemini-doc", url: "https://gemini.google.com/app" };
  listeners.committed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 9, targetAccountObserved: true, identityCheckComplete: true },
    {
      frameId: 0,
      documentId: currentFrame.documentId,
      url: currentFrame.url,
      tab: { id: 81, incognito: true }
    }
  );
  status = await external({ type: "GET_STATUS", version: 9, requestId });
  assert.equal(status.run.stage, "GEMINI_TARGET_ACCOUNT_CONFIRMED");
  assert.equal(status.run.targetAccountConfirmed, true);
  assert.equal(updatedWindows[0].id, 71);
  assert.equal(updatedWindows[0].options.state, "normal");
  assert.equal(updatedWindows[0].options.focused, true);
  assert.equal(clearedAlarms.includes(`gemini-auth-timeout:${requestId}`), true);

  const posted = await external({
    type: "POST_PROMPT", version: 9, requestId, pocIdToken, prompt: "POC test"
  });
  assert.equal(posted.ok, true);
  assert.equal(posted.run.stage, "PROMPT_SUBMITTED");

  const cancelled = await external({
    type: "CANCEL_RUN", version: 9, requestId, pocIdToken
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.run.stage, "CANCELLED");

  failNextTabUpdate = true;
  const openFailureId = "123e4567-e89b-42d3-a456-426614174006";
  const openFailed = await external({
    type: "START_AGENT", version: 9, requestId: openFailureId, pocIdToken
  });
  assert.equal(openFailed.ok, false);
  assert.equal(openFailed.error, "OPEN_FAILED");
  assert.equal(openFailed.run.closed, true);
  assert.equal(removedWindows.includes(71), true);

  const rejected = await external(
    { type: "PING", version: 9 },
    { frameId: 0, url: "https://example.com/" }
  );
  assert.equal(rejected.error, "UNTRUSTED_SENDER");

  const source = fs.readFileSync("extension/service-worker.js", "utf8");
  assert.doesNotMatch(source, /@[s]{2}w0rd/i);
  assert.doesNotMatch(source, /chrome\.storage\.(local|sync)/);
  assert.match(source, /sendNativeMessage\(NATIVE_HOST/);

  googleStep = "USER_ACTION_REQUIRED";
  const challengeId = "123e4567-e89b-42d3-a456-426614174001";
  const challengeStarted = await external({ type: "START_AGENT", version: 9, requestId: challengeId, pocIdToken });
  assert.equal(challengeStarted.ok, true);
  currentFrame = { documentId: "google-otp-doc", url: "https://accounts.google.com/v3/signin/challenge/otp" };
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  const challenged = await external({ type: "GET_STATUS", version: 9, requestId: challengeId });
  assert.equal(challenged.run.stage, "USER_ACTION_REQUIRED");
  assert.equal(removedWindows.includes(71), true);

  googleStep = "PASSWORD_REQUIRED";
  const timeoutId = "123e4567-e89b-42d3-a456-426614174002";
  const timeoutStarted = await external({ type: "START_AGENT", version: 9, requestId: timeoutId, pocIdToken });
  assert.equal(timeoutStarted.ok, true);
  currentFrame = { documentId: "google-timeout-doc", url: "https://accounts.google.com/v3/signin/challenge/pwd" };
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  listeners.alarm({ name: `gemini-auth-timeout:${timeoutId}` });
  await flush();
  const timedOut = await external({ type: "GET_STATUS", version: 9, requestId: timeoutId });
  assert.equal(timedOut.run.stage, "AUTH_TIMEOUT");
  assert.equal(timedOut.run.closed, true);

  const recoveryId = "123e4567-e89b-42d3-a456-426614174004";
  const recoveryStarted = await external({ type: "START_AGENT", version: 9, requestId: recoveryId, pocIdToken });
  assert.equal(recoveryStarted.ok, true);
  currentFrame = { documentId: "missed-google-doc", url: "https://accounts.google.com/v3/signin/challenge/pwd" };
  const recovered = await external({ type: "GET_STATUS", version: 9, requestId: recoveryId });
  assert.equal(recovered.run.stage, "PASSWORD_SUBMITTED");
  await external({ type: "CANCEL_RUN", version: 9, requestId: recoveryId, pocIdToken });

  const atomicId = "123e4567-e89b-42d3-a456-426614174005";
  const atomicStarted = await external({ type: "START_AGENT", version: 9, requestId: atomicId, pocIdToken });
  assert.equal(atomicStarted.ok, true);
  const atomicSaved = sessionState.geminiExtensionAgentV9.runs.find((run) => run.requestId === atomicId);
  atomicSaved.credentialState = "REQUESTING";
  atomicSaved.stage = "FETCHING_ONE_SHOT_CREDENTIAL";
  atomicSaved.currentDocumentId = "atomic-google-doc";
  atomicSaved.currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd";
  loadWorker();
  currentFrame = { documentId: "atomic-google-doc", url: "https://accounts.google.com/v3/signin/challenge/pwd" };
  const nativeCountBeforeAtomicRecovery = nativeMessages.length;
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  const atomicStatus = await external({ type: "GET_STATUS", version: 9, requestId: atomicId });
  assert.equal(atomicStatus.run.stage, "CREDENTIAL_ALREADY_CLAIMED");
  assert.equal(nativeMessages.length, nativeCountBeforeAtomicRecovery);

  existingWindows = [{ id: 999, incognito: true }];
  const notFresh = await external({
    type: "START_AGENT",
    version: 9,
    requestId: "123e4567-e89b-42d3-a456-426614174003",
    pocIdToken
  });
  assert.equal(notFresh.error, "INCOGNITO_SESSION_NOT_FRESH");

  console.log("PASS extension-agent-state-machine");
  console.log("PASS isolated-window-hidden-until-confirmed");
  console.log("PASS one-shot-native-credential-bridge");
  console.log("PASS prompt-post-after-account-confirmation");
  console.log("PASS interactive-challenge-fails-closed");
  console.log("PASS untrusted-origin-rejection");
  console.log("PASS firebase-auth-gates-agent-start-and-prompt");
  console.log("PASS poc-password-never-enters-hosted-page");
  console.log("PASS mv3-worker-restart-restores-non-secret-run-state");
  console.log("PASS stalled-password-submit-fails-closed");
  console.log("PASS initial-navigation-is-mapped-before-google");
  console.log("PASS single-active-run-and-fresh-incognito-gates");
  console.log("PASS exact-document-targeting-and-prompt-revalidation");
  console.log("PASS missed-navigation-reconciles-from-current-frame");
  console.log("PASS worker-restart-never-reclaims-credential");
  console.log("PASS partial-window-open-failure-cleans-up-and-releases-run");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
