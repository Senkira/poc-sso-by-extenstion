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
  ["#extension-id", element()]
]);
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001"
];
let uuidIndex = 0;
let pingVersion = "0.3.0";
let pingProtocol = 2;
let pendingOldPoll = null;
let statusMode = "observed";
let now = 1000;
let nextTimer = 1;
const timers = new Map();

const chrome = {
  runtime: {
    lastError: null,
    sendMessage(extensionId, message, callback) {
      assert.equal(extensionId, "jeenmgigpkffleijbmfciffiodlcdafh");
      assert.equal(message.version, 2);
      if (message.type === "PING") {
        callback({ ok: true, version: pingVersion, protocolVersion: pingProtocol });
        return;
      }
      if (message.type === "OPEN_GEMINI") {
        callback({
          ok: true,
          run: {
            requestId: message.requestId,
            stage: "CREDENTIAL_PAGE_CREATED",
            updatedAt: 1,
            observedOrigin: null,
            documentObserved: false,
            closed: false
          }
        });
        return;
      }
      if (message.type === "GET_STATUS" && message.requestId === ids[0] && !pendingOldPoll) {
        pendingOldPoll = callback;
        return;
      }
      if (statusMode === "missing") {
        callback({ ok: false, error: "RUN_NOT_FOUND" });
        return;
      }
      callback({
        ok: true,
        run: {
          requestId: message.requestId,
          stage: "GEMINI_DOCUMENT_OBSERVED",
          updatedAt: 5,
          observedOrigin: "https://gemini.google.com",
          documentObserved: true,
          closed: false
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
  const launch = elements.get("#launch-button").listeners.click;
  const requestA = launch();
  await flush();
  assert.ok(pendingOldPoll, "request A poll should remain pending");

  const requestB = launch();
  await requestB;
  assert.equal(elements.get("#request-value").textContent, ids[1]);
  assert.equal(elements.get("#stage-value").textContent, "GEMINI_DOCUMENT_OBSERVED");
  assert.equal(elements.get("#connection-badge").textContent, "Connected");
  assert.equal(timers.size, 1, "single-flight poll schedules only one timeout");

  chrome.runtime.lastError = { message: "stale channel closed" };
  pendingOldPoll(undefined);
  chrome.runtime.lastError = null;
  await requestA;
  await flush();
  assert.equal(elements.get("#request-value").textContent, ids[1]);
  assert.equal(elements.get("#stage-value").textContent, "GEMINI_DOCUMENT_OBSERVED");
  assert.equal(timers.size, 1);

  statusMode = "missing";
  await fireOnlyTimer();
  assert.equal(elements.get("#stage-value").textContent, "RUN_NOT_FOUND");
  assert.equal(elements.get("#origin-value").textContent, "Unavailable");
  assert.equal(elements.get("#document-value").textContent, "Unavailable");
  assert.equal(timers.size, 0);

  pingVersion = "0.2.0";
  await elements.get("#retry-button").listeners.click();
  await flush();
  assert.equal(elements.get("#connection-badge").textContent, "Not detected");
  assert.match(elements.get("#connection-detail").textContent, /v0\.2\.0.*v0\.3\.0.*Reload/);
  assert.equal(elements.get("#launch-button").disabled, true);

  pingProtocol = 1;
  await elements.get("#retry-button").listeners.click();
  await flush();
  assert.match(elements.get("#connection-detail").textContent, /protocol เก่า.*Reload.*v0\.3\.0/);

  console.log("PASS stale-run-poll-failure-isolation");
  console.log("PASS single-flight-recursive-polling");
  console.log("PASS lost-run-clears-current-telemetry");
  console.log("PASS old-extension-version-rejection");
  console.log("PASS old-protocol-reload-guidance");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
