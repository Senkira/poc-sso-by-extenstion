"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

const store = {};
const listeners = {};
let createCount = 0;
let preMappingNavigationEmitted = false;
let currentFrame = {
  url: "https://gemini.google.com/app",
  documentId: "doc-initial"
};
const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });

const chrome = {
  storage: {
    session: {
      async get(key) {
        return key === null ? { ...store } : { [key]: store[key] };
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(key) {
        delete store[key];
      }
    }
  },
  windows: {
    async create() {
      createCount += 1;
      listeners.committed({
        frameId: 0,
        tabId: 60,
        url: currentFrame.url,
        timeStamp: Date.now(),
        documentId: currentFrame.documentId
      });
      preMappingNavigationEmitted = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: 50, tabs: [{ id: 60 }] };
    }
  },
  runtime: {
    getManifest() {
      return { version: "0.1.1" };
    },
    onMessageExternal: event("external"),
    onMessage: event("internal")
  },
  webNavigation: {
    async getFrame() {
      return { ...currentFrame };
    },
    onCommitted: event("committed"),
    onCompleted: event("completed"),
    onErrorOccurred: event("navigationError")
  },
  tabs: {
    onRemoved: event("tabRemoved")
  }
};

vm.runInNewContext(
  fs.readFileSync("extension/service-worker.js", "utf8"),
  { chrome, URL, Map, Promise, Date, Number, Error, setTimeout, clearTimeout }
);

function external(message, sender = {
  frameId: 0,
  url: "https://poc-after-sso-login-gemini.web.app/"
}) {
  return new Promise((resolve) => listeners.external(message, sender, resolve));
}

function internal(message, sender = {
  frameId: 0,
  url: "https://gemini.google.com/app",
  documentId: "doc-initial",
  tab: { id: 60 }
}) {
  return new Promise((resolve) => listeners.internal(message, sender, resolve));
}

async function main() {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const [first, replay] = await Promise.all([
    external({ type: "OPEN_GEMINI", version: 1, requestId }),
    external({ type: "OPEN_GEMINI", version: 1, requestId })
  ]);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(createCount, 1, "same UUID must create exactly one window");
  assert.equal(preMappingNavigationEmitted, true);

  const reconciled = await external({ type: "GET_STATUS", version: 1, requestId });
  assert.equal(reconciled.run.stage, "GEMINI_NAVIGATED");
  assert.equal(reconciled.run.observedOrigin, "https://gemini.google.com");

  await internal({ type: "GEMINI_DOCUMENT_SIGNAL" });
  listeners.completed({
    frameId: 0,
    tabId: 60,
    url: "https://gemini.google.com/app",
    timeStamp: Date.now() + 1,
    documentId: "doc-initial"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const observed = await external({ type: "GET_STATUS", version: 1, requestId });
  assert.equal(observed.run.stage, "GEMINI_DOCUMENT_OBSERVED");
  assert.equal(observed.run.documentObserved, true);

  currentFrame = {
    url: "https://gemini.google.com/app/new",
    documentId: "doc-new"
  };
  listeners.committed({
    frameId: 0,
    tabId: 60,
    url: currentFrame.url,
    timeStamp: Date.now() + 2,
    documentId: currentFrame.documentId
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const staleSignal = await internal(
    { type: "GEMINI_DOCUMENT_SIGNAL" },
    {
      frameId: 0,
      url: "https://gemini.google.com/app",
      documentId: "doc-initial",
      tab: { id: 60 }
    }
  );
  assert.equal(staleSignal.ok, false);
  const afterStaleSignal = await external({ type: "GET_STATUS", version: 1, requestId });
  assert.equal(afterStaleSignal.run.stage, "GEMINI_NAVIGATED");
  assert.equal(afterStaleSignal.run.documentObserved, false);

  listeners.tabRemoved(60);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const closed = await external({ type: "GET_STATUS", version: 1, requestId });
  assert.equal(closed.run.stage, "TAB_CLOSED");

  const rejected = await external(
    { type: "PING", version: 1 },
    { frameId: 0, url: "https://example.com/" }
  );
  assert.equal(rejected.error, "UNTRUSTED_SENDER");

  console.log("PASS concurrent-idempotency");
  console.log("PASS monotonic-document-state");
  console.log("PASS mapping-reconciliation");
  console.log("PASS stale-document-signal-rejection");
  console.log("PASS exact-tab-close-state");
  console.log("PASS untrusted-origin-rejection");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
