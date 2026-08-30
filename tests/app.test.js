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
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
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
const timers = new Set();
let nextTimer = 1;
let pendingOldPoll = null;

const chrome = {
  runtime: {
    lastError: null,
    sendMessage(extensionId, message, callback) {
      assert.equal(extensionId, "jeenmgigpkffleijbmfciffiodlcdafh");
      if (message.type === "PING") {
        callback({ ok: true, version: "0.2.0", protocolVersion: 1 });
        return;
      }
      if (message.type === "OPEN_GEMINI") {
        callback({
          ok: true,
          run: {
            requestId: message.requestId,
            stage: "WINDOW_CREATED",
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
      callback({
        ok: true,
        run: {
          requestId: message.requestId,
          stage: "GEMINI_DOCUMENT_OBSERVED",
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
    Date,
    Error,
    Promise,
    document: { querySelector: (selector) => elements.get(selector) },
    setInterval() {
      const id = nextTimer++;
      timers.add(id);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    }
  }
);

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  await flush();
  const launch = elements.get("#launch-button").listeners.click;
  const requestA = launch();
  await flush();
  assert.ok(pendingOldPoll, "request A poll should remain pending");

  const requestB = launch();
  await requestB;
  assert.equal(elements.get("#request-value").textContent, "123e4567-e89b-42d3-a456-426614174001");
  assert.equal(elements.get("#stage-value").textContent, "GEMINI_DOCUMENT_OBSERVED");
  assert.equal(elements.get("#connection-badge").textContent, "Connected");
  assert.equal(timers.size, 1);

  chrome.runtime.lastError = { message: "stale channel closed" };
  pendingOldPoll(undefined);
  chrome.runtime.lastError = null;
  await requestA;
  await flush();

  assert.equal(elements.get("#request-value").textContent, "123e4567-e89b-42d3-a456-426614174001");
  assert.equal(elements.get("#stage-value").textContent, "GEMINI_DOCUMENT_OBSERVED");
  assert.equal(elements.get("#connection-badge").textContent, "Connected");
  assert.equal(timers.size, 1);
  console.log("PASS stale-poll-failure-isolation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
