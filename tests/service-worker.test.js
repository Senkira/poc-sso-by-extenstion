"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

const listeners = {};
const createdWindows = [];
const updatedWindows = [];
const removedWindows = [];
const createdTabs = [];
const updatedTabs = [];
const reloadedTabs = [];
const removedTabs = [];
const brokerRequests = [];
const createdAlarms = [];
const clearedAlarms = [];
let googleStep = "PASSWORD_REQUIRED";
const pocIdToken = "test-id-token".padEnd(120, "x");
const sessionState = {};
let sessionStorageWrites = 0;
let currentFrame = { documentId: "about-doc", url: "about:blank" };
const tabFrames = new Map();
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
    getManifest() { return { version: "0.13.1" }; },
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
    async getFrame({ tabId }) {
      return { ...(tabId === 81 ? currentFrame : tabFrames.get(tabId) || currentFrame) };
    },
    onCompleted: event("completed"),
    onCommitted: event("committed")
  },
  tabs: {
    async create(options) {
      createdTabs.push(options);
      const id = 82 + createdTabs.length - 1;
      tabFrames.set(id, { documentId: `${id}-about-doc`, url: options.url });
      return { id, incognito: true, ...options };
    },
    async update(id, options) {
      updatedTabs.push({ id, options });
      if (failNextTabUpdate) {
        failNextTabUpdate = false;
        throw new Error("simulated navigation failure");
      }
      if (typeof options.url === "string" && id !== 81) {
        tabFrames.set(id, { documentId: `${id}-navigation-doc`, url: options.url });
      }
      return { id, incognito: true, ...options };
    },
    async reload(id) { reloadedTabs.push(id); },
    async remove(id) { removedTabs.push(id); },
    async get(id) {
      const frame = id === 81 ? currentFrame : tabFrames.get(id) || currentFrame;
      return { id, incognito: true, url: frame.url };
    },
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
    if (/identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/.test(url)) {
      assert.equal(JSON.parse(options.body).idToken, pocIdToken);
      return {
        ok: true,
        async json() {
          return { users: [{ localId: "VHX1QkrsewSrrWB0g3BjyHepdWX2", email: "o1234567@poc.invalid" }] };
        }
      };
    }
    assert.equal(url, "https://us-central1-poc-after-sso-login-gemini.cloudfunctions.net/credentialBroker");
    const body = JSON.parse(options.body);
    brokerRequests.push({ url, body, headers: { ...options.headers } });
    assert.equal(body.version, 10);
    if (body.action === "authenticatePoc") {
      return {
        ok: true,
        async json() {
          return { ok: true, username: "O1234567", idToken: pocIdToken, expiresIn: "3600" };
        }
      };
    }
    assert.equal(body.action, "getGoogleCredential");
    assert.equal(options.headers.Authorization, `Bearer ${pocIdToken}`);
    return {
      ok: true,
      async json() {
        return { ok: true, email: "codeassist.04@easybuy.co.th", password: "test-only-password" };
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
  const ping = await external({ type: "PING", version: 10 });
  assert.equal(ping.version, "0.13.1");
  assert.equal(ping.protocolVersion, 10);
  assert.equal(ping.capability, "EXTENSION_AGENT_HTTPS_BROKER");
  assert.equal(ping.incognitoAccessAllowed, true);

  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const pocLogin = await external({
    type: "AUTHENTICATE_POC", version: 10, requestId, username: "O1234567"
  });
  assert.equal(pocLogin.ok, true);
  assert.equal(pocLogin.idToken, pocIdToken);
  assert.equal(Object.prototype.hasOwnProperty.call(pocLogin, "password"), false);
  assert.equal(brokerRequests[0].body.action, "authenticatePoc");

  const denied = await external({ type: "START_AGENT", version: 10, requestId });
  assert.equal(denied.error, "POC_AUTH_REQUIRED");
  assert.equal(createdWindows.length, 0);

  const started = await external({ type: "START_AGENT", version: 10, requestId, pocIdToken });
  assert.equal(started.ok, true);
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].incognito, true);
  assert.equal(createdWindows[0].focused, false);
  assert.equal(createdWindows[0].state, "minimized");
  assert.equal(createdWindows[0].url, "about:blank");
  assert.equal(createdTabs.length, 0);
  assert.match(updatedTabs[0].options.url, /accounts\.google\.com/);
  assert.equal(updatedTabs[0].options.active, true);
  assert.equal(sessionStorageWrites > 0, true);

  const parallel = await external({
    type: "START_AGENT",
    version: 10,
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
  let status = await external({ type: "GET_STATUS", version: 10, requestId });
  assert.equal(status.run.credentialDelivered, true);
  assert.equal(status.run.credentialSubmitted, true);
  assert.equal(status.run.authTabId, 81);
  assert.equal(status.run.geminiTabId, 82);
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].windowId, 71);
  assert.equal(createdTabs[0].url, "about:blank");
  assert.equal(createdTabs[0].active, true);
  assert.equal(updatedTabs.some(({ id, options }) => id === 82
    && options.url === "https://gemini.google.com/app"
    && options.active === true), true);
  assert.equal(Object.prototype.hasOwnProperty.call(status.run, "password"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.run, "brokerIdToken"), false);
  const savedAfterDelivery = sessionState.geminiExtensionAgentV10.runs
    .find((run) => run.requestId === requestId);
  assert.equal(savedAfterDelivery.brokerIdToken, null);
  assert.equal(Object.prototype.hasOwnProperty.call(savedAfterDelivery, "password"), false);
  assert.equal(brokerRequests.length, 2);
  assert.equal(brokerRequests[1].body.action, "getGoogleCredential");
  assert.equal(brokerRequests[1].headers.Authorization, `Bearer ${pocIdToken}`);
  assert.equal(createdAlarms[0].name, `gemini-auth-timeout:${requestId}`);
  assert.equal(createdAlarms[0].options.delayInMinutes, 15);

  const preAuthGeminiFrame = { documentId: "gemini-pre-auth-doc", url: "https://gemini.google.com/app" };
  tabFrames.set(82, preAuthGeminiFrame);
  listeners.committed({ frameId: 0, tabId: 82, ...preAuthGeminiFrame });
  await flush();
  const waitingSignal = await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 10, targetAccountObserved: false, identityCheckComplete: true },
    {
      frameId: 0,
      documentId: preAuthGeminiFrame.documentId,
      url: preAuthGeminiFrame.url,
      tab: { id: 82, incognito: true }
    }
  );
  assert.equal(waitingSignal.waiting, true);
  status = await external({ type: "GET_STATUS", version: 10, requestId });
  assert.equal(status.run.closed, false);
  assert.equal(removedWindows.length, 0);

  currentFrame = { documentId: "auth-finished-doc", url: "https://gemini.google.com/app" };
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();

  const postAuthGeminiFrame = { documentId: "gemini-post-auth-miss-doc", url: "https://gemini.google.com/app" };
  tabFrames.set(82, postAuthGeminiFrame);
  listeners.committed({ frameId: 0, tabId: 82, ...postAuthGeminiFrame });
  await flush();
  const postAuthWaitingSignal = await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 10, targetAccountObserved: false, identityCheckComplete: true },
    {
      frameId: 0,
      documentId: postAuthGeminiFrame.documentId,
      url: postAuthGeminiFrame.url,
      tab: { id: 82, incognito: true }
    }
  );
  assert.equal(postAuthWaitingSignal.waiting, true);
  status = await external({ type: "GET_STATUS", version: 10, requestId });
  assert.equal(status.run.closed, false);

  currentFrame = { documentId: "gemini-doc-before-reload", url: "https://gemini.google.com/app" };
  tabFrames.set(82, currentFrame);
  listeners.committed({ frameId: 0, tabId: 82, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  const reloadSignal = await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 10, targetAccountObserved: true, identityCheckComplete: true },
    {
      frameId: 0,
      documentId: currentFrame.documentId,
      url: currentFrame.url,
      tab: { id: 82, incognito: true }
    }
  );
  assert.equal(reloadSignal.reloading, true);
  status = await external({ type: "GET_STATUS", version: 10, requestId });
  assert.equal(status.run.stage, "RELOADING_GEMINI");
  assert.equal(status.run.targetAccountConfirmed, false);
  assert.deepEqual(reloadedTabs, [82]);
  assert.equal(updatedWindows.length, 0);
  assert.equal(removedTabs.length, 0);

  currentFrame = { documentId: "gemini-doc-after-reload", url: "https://gemini.google.com/app" };
  tabFrames.set(82, currentFrame);
  listeners.committed({ frameId: 0, tabId: 82, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  const finalSignal = await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 10, targetAccountObserved: true, identityCheckComplete: true },
    {
      frameId: 0,
      documentId: currentFrame.documentId,
      url: currentFrame.url,
      tab: { id: 82, incognito: true }
    }
  );
  assert.equal(finalSignal.confirmed, true);
  status = await external({ type: "GET_STATUS", version: 10, requestId });
  assert.equal(status.run.stage, "GEMINI_TARGET_ACCOUNT_CONFIRMED");
  assert.equal(status.run.targetAccountConfirmed, true);
  assert.equal(status.run.authTabId, null);
  assert.equal(status.run.geminiTabId, 82);
  assert.equal(status.run.tabId, 82);
  assert.deepEqual(removedTabs, [81]);
  assert.equal(updatedTabs.at(-1).id, 82);
  assert.equal(updatedTabs.at(-1).options.active, true);
  assert.equal(updatedWindows[0].id, 71);
  assert.equal(updatedWindows[0].options.state, "normal");
  assert.equal(updatedWindows[0].options.focused, true);
  assert.equal(clearedAlarms.includes(`gemini-auth-timeout:${requestId}`), true);

  const posted = await external({
    type: "POST_PROMPT", version: 10, requestId, pocIdToken, prompt: "POC test"
  });
  assert.equal(posted.ok, true);
  assert.equal(posted.run.stage, "PROMPT_SUBMITTED_CONFIRMED");

  const cancelled = await external({
    type: "CANCEL_RUN", version: 10, requestId, pocIdToken
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.run.stage, "CANCELLED");

  const raceWindowCount = createdWindows.length;
  const raceRequests = [
    "123e4567-e89b-42d3-a456-426614174007",
    "123e4567-e89b-42d3-a456-426614174008"
  ];
  const raceResults = await Promise.all(raceRequests.map((raceRequestId) => external({
    type: "START_AGENT", version: 10, requestId: raceRequestId, pocIdToken
  })));
  assert.equal(raceResults.filter((result) => result.ok === true).length, 1);
  assert.equal(raceResults.filter((result) => result.error === "RUN_ALREADY_ACTIVE").length, 1);
  assert.equal(createdWindows.length, raceWindowCount + 1);
  const raceWinner = raceResults.find((result) => result.ok === true);
  await external({
    type: "CANCEL_RUN", version: 10, requestId: raceWinner.run.requestId, pocIdToken
  });

  failNextTabUpdate = true;
  const openFailureId = "123e4567-e89b-42d3-a456-426614174006";
  const openFailed = await external({
    type: "START_AGENT", version: 10, requestId: openFailureId, pocIdToken
  });
  assert.equal(openFailed.ok, false);
  assert.equal(openFailed.error, "OPEN_FAILED");
  assert.equal(openFailed.run.closed, true);
  assert.equal(removedWindows.includes(71), true);

  const rejected = await external(
    { type: "PING", version: 10 },
    { frameId: 0, url: "https://example.com/" }
  );
  assert.equal(rejected.error, "UNTRUSTED_SENDER");

  const source = fs.readFileSync("extension/service-worker.js", "utf8");
  assert.doesNotMatch(source, /@[s]{2}w0rd/i);
  assert.doesNotMatch(source, /chrome\.storage\.(local|sync)/);
  assert.doesNotMatch(source, /sendNativeMessage|nativeMessaging|NATIVE_HOST/);
  assert.match(source, /CREDENTIAL_BROKER_URL/);
  assert.match(source, /fetch\(CREDENTIAL_BROKER_URL/);

  googleStep = "USER_ACTION_REQUIRED";
  const challengeId = "123e4567-e89b-42d3-a456-426614174001";
  const challengeStarted = await external({ type: "START_AGENT", version: 10, requestId: challengeId, pocIdToken });
  assert.equal(challengeStarted.ok, true);
  currentFrame = { documentId: "google-otp-doc", url: "https://accounts.google.com/v3/signin/challenge/otp" };
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  const challenged = await external({ type: "GET_STATUS", version: 10, requestId: challengeId });
  assert.equal(challenged.run.stage, "USER_ACTION_REQUIRED");
  assert.equal(removedWindows.includes(71), true);

  googleStep = "PASSWORD_REQUIRED";
  const timeoutId = "123e4567-e89b-42d3-a456-426614174002";
  const timeoutStarted = await external({ type: "START_AGENT", version: 10, requestId: timeoutId, pocIdToken });
  assert.equal(timeoutStarted.ok, true);
  currentFrame = { documentId: "google-timeout-doc", url: "https://accounts.google.com/v3/signin/challenge/pwd" };
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  listeners.alarm({ name: `gemini-auth-timeout:${timeoutId}` });
  await flush();
  const timedOut = await external({ type: "GET_STATUS", version: 10, requestId: timeoutId });
  assert.equal(timedOut.run.stage, "AUTH_TIMEOUT");
  assert.equal(timedOut.run.closed, true);
  listeners.removed(81);
  await flush();
  const timedOutAfterTabClose = await external({ type: "GET_STATUS", version: 10, requestId: timeoutId });
  assert.equal(timedOutAfterTabClose.run.stage, "AUTH_TIMEOUT");

  const recoveryId = "123e4567-e89b-42d3-a456-426614174004";
  const recoveryStarted = await external({ type: "START_AGENT", version: 10, requestId: recoveryId, pocIdToken });
  assert.equal(recoveryStarted.ok, true);
  currentFrame = { documentId: "missed-google-doc", url: "https://accounts.google.com/v3/signin/challenge/pwd" };
  const recovered = await external({ type: "GET_STATUS", version: 10, requestId: recoveryId });
  assert.equal(recovered.run.stage, "GEMINI_TAB_OPENED");
  assert.equal(Number.isInteger(recovered.run.geminiTabId), true);
  await external({ type: "CANCEL_RUN", version: 10, requestId: recoveryId, pocIdToken });

  const atomicId = "123e4567-e89b-42d3-a456-426614174005";
  const atomicStarted = await external({ type: "START_AGENT", version: 10, requestId: atomicId, pocIdToken });
  assert.equal(atomicStarted.ok, true);
  const atomicSaved = sessionState.geminiExtensionAgentV10.runs.find((run) => run.requestId === atomicId);
  atomicSaved.credentialState = "REQUESTING";
  atomicSaved.stage = "FETCHING_ONE_SHOT_CREDENTIAL";
  atomicSaved.currentDocumentId = "atomic-google-doc";
  atomicSaved.currentUrl = "https://accounts.google.com/v3/signin/challenge/pwd";
  loadWorker();
  currentFrame = { documentId: "atomic-google-doc", url: "https://accounts.google.com/v3/signin/challenge/pwd" };
  const brokerCountBeforeAtomicRecovery = brokerRequests.length;
  listeners.completed({ frameId: 0, tabId: 81, documentId: currentFrame.documentId, url: currentFrame.url });
  await flush();
  const atomicStatus = await external({ type: "GET_STATUS", version: 10, requestId: atomicId });
  assert.equal(atomicStatus.run.stage, "CREDENTIAL_ALREADY_CLAIMED");
  assert.equal(brokerRequests.length, brokerCountBeforeAtomicRecovery);

  existingWindows = [{ id: 999, incognito: true }];
  const notFresh = await external({
    type: "START_AGENT",
    version: 10,
    requestId: "123e4567-e89b-42d3-a456-426614174003",
    pocIdToken
  });
  assert.equal(notFresh.error, "INCOGNITO_SESSION_NOT_FRESH");

  console.log("PASS extension-agent-state-machine");
  console.log("PASS isolated-window-hidden-until-confirmed");
  console.log("PASS one-shot-https-credential-broker");
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
  console.log("PASS concurrent-start-agent-is-serialized");
  console.log("PASS prompt-success-requires-rendered-user-turn-postcondition");
  console.log("PASS isolated-new-gemini-tab-reload-and-single-tab-handoff");
  console.log("PASS pre-auth-gemini-miss-waits-instead-of-closing-isolate");
  console.log("PASS post-auth-gemini-miss-waits-until-deadline");
  console.log("PASS terminal-failure-stage-survives-tab-close");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
