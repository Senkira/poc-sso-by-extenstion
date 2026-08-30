"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

function element() {
  return {
    className: "",
    disabled: false,
    listeners: {},
    textContent: "",
    addEventListener(type, listener) { this.listeners[type] = listener; }
  };
}

const elements = new Map([
  ["#connection-badge", element()],
  ["#connection-detail", element()],
  ["#launch-button", element()],
  ["#retry-button", element()],
  ["#request-value", element()],
  ["#stage-value", element()],
  ["#origin-value", element()],
  ["#document-value", element()],
  ["#account-value", element()],
  ["#note-value", element()],
  ["#extension-id", element()]
]);
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002"
];
let uuidIndex = 0;
let pingVersion = "0.4.8";
let pingProtocol = 3;
let statusMode = "pending-first";
let pendingOldPoll = null;
let now = 1000;
let nextTimer = 1;
const timers = new Map();

const chrome = {
  runtime: {
    lastError: null,
    sendMessage(extensionId, message, callback) {
      assert.equal(extensionId, "jeenmgigpkffleijbmfciffiodlcdafh");
      assert.equal(message.version, 3);
      if (message.type === "PING") {
        callback({
          ok: true,
          version: pingVersion,
          protocolVersion: pingProtocol,
          capability: "SECRETLESS_GOOGLE_SESSION_LAUNCHER"
        });
        return;
      }
      if (message.type === "OPEN_GEMINI") {
        callback({
          ok: true,
          run: {
            requestId: message.requestId,
            stage: "ACCOUNT_SELECTED",
            updatedAt: 1,
            observedOrigin: "https://accounts.google.com",
            documentObserved: false,
            targetAccountConfirmed: false,
            identityCheckComplete: false,
            closed: false,
            note: "Account selected"
          }
        });
        return;
      }
      if (message.type === "GET_STATUS" && statusMode === "pending-first" && message.requestId === ids[0]) {
        pendingOldPoll = callback;
        return;
      }
      if (statusMode === "missing") {
        callback({ ok: false, error: "RUN_NOT_FOUND" });
        return;
      }
      if (statusMode === "action-required") {
        callback({
          ok: true,
          run: {
            requestId: message.requestId,
            stage: "USER_ACTION_REQUIRED",
            updatedAt: 4,
            observedOrigin: "https://accounts.google.com",
            documentObserved: false,
            targetAccountConfirmed: false,
            identityCheckComplete: false,
            closed: false,
            note: "No silent credential source"
          }
        });
        return;
      }
      callback({
        ok: true,
        run: {
          requestId: message.requestId,
          stage: "GEMINI_TARGET_ACCOUNT_CONFIRMED",
          updatedAt: 5,
          observedOrigin: "https://gemini.google.com",
          documentObserved: true,
          targetAccountConfirmed: true,
          identityCheckComplete: true,
          closed: false,
          note: "Target confirmed"
        }
      });
    }
  }
};

vm.runInNewContext(
  fs.readFileSync("public/app.js", "utf8"),
  {
    chrome,
    crypto: { randomUUID: () => ids[uuidIndex++] },
    Date: { now: () => now },
    Error,
    Promise,
    Set,
    document: { querySelector: (selector) => elements.get(selector) },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  }
);

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function fireOnlyTimer() {
  assert.equal(timers.size, 1);
  const [id, callback] = timers.entries().next().value;
  timers.delete(id);
  callback();
  await flush();
}

async function main() {
  await flush();
  assert.equal(elements.get("#connection-badge").textContent, "Connected");

  const launch = elements.get("#launch-button").listeners.click;
  await launch();
  await fireOnlyTimer();
  assert.ok(pendingOldPoll, "first run poll must remain pending");

  statusMode = "confirmed";
  await launch();
  assert.equal(timers.size, 1, "new run must have exactly one scheduled poll");
  await fireOnlyTimer();
  assert.equal(elements.get("#stage-value").textContent, "GEMINI_TARGET_ACCOUNT_CONFIRMED");
  assert.equal(elements.get("#account-value").textContent, "Confirmed");
  assert.equal(timers.size, 0, "terminal success must stop polling");

  pendingOldPoll({
    ok: true,
    run: {
      requestId: ids[0],
      stage: "USER_ACTION_REQUIRED",
      updatedAt: 99,
      observedOrigin: "https://accounts.google.com",
      documentObserved: false,
      targetAccountConfirmed: false,
      identityCheckComplete: false,
      closed: false,
      note: "stale"
    }
  });
  await flush();
  assert.equal(elements.get("#stage-value").textContent, "GEMINI_TARGET_ACCOUNT_CONFIRMED");

  statusMode = "missing";
  await launch();
  await fireOnlyTimer();
  assert.equal(elements.get("#stage-value").textContent, "RUN_NOT_FOUND");
  assert.equal(elements.get("#account-value").textContent, "Unavailable");

  pingVersion = "0.3.0";
  await elements.get("#retry-button").listeners.click();
  await flush();
  assert.equal(elements.get("#connection-badge").textContent, "Not detected");
  assert.match(elements.get("#connection-detail").textContent, /v0\.3\.0.*v0\.4\.8.*Reload/);

  pingProtocol = 2;
  await elements.get("#retry-button").listeners.click();
  await flush();
  assert.match(elements.get("#connection-detail").textContent, /protocol เก่า.*Reload.*v0\.4\.8/);

  console.log("PASS stale-run-poll-failure-isolation");
  console.log("PASS single-flight-recursive-polling");
  console.log("PASS terminal-success-stops-polling");
  console.log("PASS lost-run-clears-current-telemetry");
  console.log("PASS old-secretful-extension-rejection");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
