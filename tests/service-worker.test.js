"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

const listeners = {};
const createdWindows = [];
const updatedWindows = [];
const removedWindows = [];
const nativeMessages = [];
const createdAlarms = [];
const clearedAlarms = [];
let googleStep = "PASSWORD_REQUIRED";
const pocIdToken = "test-id-token".padEnd(120, "x");
const sessionState = {};
let sessionStorageWrites = 0;

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
    getManifest() { return { version: "0.7.0" }; },
    async sendNativeMessage(host, message) {
      nativeMessages.push({ host, message });
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
    async create(options) {
      createdWindows.push(options);
      return { id: 71, tabs: [{ id: 81 }] };
    },
    async update(id, options) { updatedWindows.push({ id, options }); },
    async remove(id) { removedWindows.push(id); }
  },
  scripting: {
    async executeScript(options) {
      if (options.func.name === "inspectGooglePage") return [{ result: { step: googleStep } }];
      if (options.func.name === "submitPassword") {
        assert.equal(options.args[0], "codeassist.04@easybuy.co.th");
        assert.equal(options.args[1], "test-only-password");
        return [{ result: { step: "PASSWORD_SUBMITTED" } }];
      }
      if (options.func.name === "injectPrompt") return [{ result: { ok: true } }];
      throw new Error(`Unexpected script: ${options.func.name}`);
    }
  },
  webNavigation: {
    onCompleted: event("completed"),
    onCommitted: event("committed")
  },
  tabs: { onRemoved: event("removed") }
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
        return { users: [{ localId: "poc-user-1", email: "o1234567@poc.invalid" }] };
      }
    };
  },
  setTimeout(callback) { Promise.resolve().then(callback); return 1; }
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
  const ping = await external({ type: "PING", version: 7 });
  assert.equal(ping.version, "0.7.0");
  assert.equal(ping.protocolVersion, 7);
  assert.equal(ping.capability, "EXTENSION_AGENT_ONE_SHOT_BRIDGE");
  assert.equal(ping.incognitoAccessAllowed, true);

  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const denied = await external({ type: "START_AGENT", version: 7, requestId });
  assert.equal(denied.error, "POC_AUTH_REQUIRED");
  assert.equal(createdWindows.length, 0);

  const started = await external({ type: "START_AGENT", version: 7, requestId, pocIdToken });
  assert.equal(started.ok, true);
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].incognito, true);
  assert.equal(createdWindows[0].focused, false);
  assert.equal(createdWindows[0].state, "minimized");
  assert.equal(sessionStorageWrites > 0, true);

  loadWorker();

  listeners.completed({
    frameId: 0,
    tabId: 81,
    url: "https://accounts.google.com/v3/signin/challenge/pwd"
  });
  await flush();
  let status = await external({ type: "GET_STATUS", version: 7, requestId });
  assert.equal(status.run.stage, "PASSWORD_SUBMITTED");
  assert.equal(status.run.credentialDelivered, true);
  assert.equal(Object.prototype.hasOwnProperty.call(status.run, "password"), false);
  assert.equal(nativeMessages.length, 1);
  assert.equal(nativeMessages[0].host, "com.senkira.gemini_extension_agent");
  assert.equal(createdAlarms[0].name, `gemini-auth-timeout:${requestId}`);

  listeners.committed({ frameId: 0, tabId: 81, url: "https://gemini.google.com/app" });
  await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL", version: 7, targetAccountObserved: true, identityCheckComplete: true },
    { frameId: 0, url: "https://gemini.google.com/app", tab: { id: 81, incognito: true } }
  );
  status = await external({ type: "GET_STATUS", version: 7, requestId });
  assert.equal(status.run.stage, "GEMINI_TARGET_ACCOUNT_CONFIRMED");
  assert.equal(status.run.targetAccountConfirmed, true);
  assert.equal(updatedWindows[0].id, 71);
  assert.equal(updatedWindows[0].options.state, "normal");
  assert.equal(updatedWindows[0].options.focused, true);
  assert.equal(clearedAlarms.includes(`gemini-auth-timeout:${requestId}`), true);

  const posted = await external({
    type: "POST_PROMPT", version: 7, requestId, pocIdToken, prompt: "POC test"
  });
  assert.equal(posted.ok, true);
  assert.equal(posted.run.stage, "PROMPT_SUBMITTED");

  const rejected = await external(
    { type: "PING", version: 7 },
    { frameId: 0, url: "https://example.com/" }
  );
  assert.equal(rejected.error, "UNTRUSTED_SENDER");

  const source = fs.readFileSync("extension/service-worker.js", "utf8");
  assert.doesNotMatch(source, /@[s]{2}w0rd/i);
  assert.doesNotMatch(source, /chrome\.storage\.(local|sync)/);
  assert.match(source, /sendNativeMessage\(NATIVE_HOST/);

  googleStep = "USER_ACTION_REQUIRED";
  const challengeId = "123e4567-e89b-42d3-a456-426614174001";
  await external({ type: "START_AGENT", version: 7, requestId: challengeId, pocIdToken });
  listeners.completed({ frameId: 0, tabId: 81, url: "https://accounts.google.com/v3/signin/challenge/otp" });
  await flush();
  const challenged = await external({ type: "GET_STATUS", version: 7, requestId: challengeId });
  assert.equal(challenged.run.stage, "USER_ACTION_REQUIRED");
  assert.equal(removedWindows.includes(71), true);

  googleStep = "PASSWORD_REQUIRED";
  const timeoutId = "123e4567-e89b-42d3-a456-426614174002";
  await external({ type: "START_AGENT", version: 7, requestId: timeoutId, pocIdToken });
  listeners.completed({ frameId: 0, tabId: 81, url: "https://accounts.google.com/v3/signin/challenge/pwd" });
  await flush();
  listeners.alarm({ name: `gemini-auth-timeout:${timeoutId}` });
  await flush();
  const timedOut = await external({ type: "GET_STATUS", version: 7, requestId: timeoutId });
  assert.equal(timedOut.run.stage, "AUTH_TIMEOUT");
  assert.equal(timedOut.run.closed, true);

  console.log("PASS extension-agent-state-machine");
  console.log("PASS isolated-window-hidden-until-confirmed");
  console.log("PASS one-shot-native-credential-bridge");
  console.log("PASS prompt-post-after-account-confirmation");
  console.log("PASS interactive-challenge-fails-closed");
  console.log("PASS untrusted-origin-rejection");
  console.log("PASS firebase-auth-gates-agent-start-and-prompt");
  console.log("PASS mv3-worker-restart-restores-non-secret-run-state");
  console.log("PASS stalled-password-submit-fails-closed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
