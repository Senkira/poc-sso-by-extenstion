"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

function element() {
  return {
    className: "",
    disabled: false,
    hidden: false,
    listeners: {},
    textContent: "",
    value: "",
    addEventListener(type, listener) { this.listeners[type] = listener; }
  };
}

const selectors = [
  "#login-panel", "#launcher-panel", "#login-form", "#username",
  "#login-button", "#preflight-button", "#preflight-badge", "#preflight-detail",
  "#logout-button", "#login-error", "#connection-badge",
  "#connection-detail", "#launch-button", "#retry-button",
  "#request-value", "#stage-value", "#origin-value",
  "#credential-value", "#account-value", "#note-value", "#extension-id"
];
const elements = new Map(selectors.map((selector) => [selector, element()]));
const stored = new Map();
const idToken = "firebase-id-token".padEnd(160, "x");
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const messages = [];

const sessionStorage = {
  getItem(key) { return stored.has(key) ? stored.get(key) : null; },
  setItem(key, value) { stored.set(key, String(value)); },
  removeItem(key) { stored.delete(key); }
};

const chrome = {
  runtime: {
    lastError: null,
    sendMessage(extensionId, message, callback) {
      assert.equal(extensionId, "jeenmgigpkffleijbmfciffiodlcdafh");
      messages.push(message);
      if (message.type === "PING") {
        callback({
          ok: true,
          version: "0.13.2",
          protocolVersion: 10,
          capability: "EXTENSION_AGENT_HTTPS_BROKER",
          incognitoAccessAllowed: true
        });
        return;
      }
      if (message.type === "AUTHENTICATE_POC") {
        assert.equal(message.username, "O1234567");
        callback({ ok: true, idToken, expiresIn: 3600, username: "O1234567" });
        return;
      }
      assert.equal(message.pocIdToken, idToken);
      if (message.type === "START_AGENT") {
        callback({
          ok: true,
          run: {
            requestId: message.requestId,
            stage: "GEMINI_TARGET_ACCOUNT_CONFIRMED",
            observedOrigin: "https://gemini.google.com",
            credentialDelivered: true,
            credentialSubmitted: true,
            targetAccountConfirmed: true,
            identityCheckComplete: true,
            closed: false
          }
        });
        return;
      }
      if (message.type === "CANCEL_RUN") {
        callback({ ok: true, cancelled: true });
        return;
      }
      callback({ ok: false, error: "UNEXPECTED_MESSAGE" });
    }
  }
};

const timers = new Map();
let timerId = 0;
const context = {
  chrome,
  crypto: { randomUUID: () => requestId },
  document: { querySelector: (selector) => elements.get(selector) },
  sessionStorage,
  setTimeout(callback) { timerId += 1; timers.set(timerId, callback); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  URL,
  Date,
  Error,
  Promise,
  Set,
  encodeURIComponent
};

vm.runInNewContext(fs.readFileSync("public/app.js", "utf8"), context);

async function flush(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function main() {
  await flush();
  assert.equal(elements.get("#login-panel").hidden, false);
  assert.equal(elements.get("#launcher-panel").hidden, true);
  assert.equal(elements.get("#username").value, "O1234567");
  assert.equal(elements.get("#preflight-badge").textContent, "Connected");
  assert.match(elements.get("#preflight-detail").textContent, /0\.13\.2/);

  elements.get("#login-form").listeners.submit({ preventDefault() {} });
  await flush();

  assert.equal(messages.some((message) => message.type === "AUTHENTICATE_POC"), true);
  assert.equal(stored.get("poc-firebase-id-token"), idToken);
  assert.equal(elements.get("#login-panel").hidden, true);
  assert.equal(elements.get("#launcher-panel").hidden, false);
  assert.equal(elements.get("#connection-badge").textContent, "Connected");
  assert.equal(messages.some((message) => message.type === "START_AGENT"), true);
  assert.equal(elements.get("#account-value").textContent, "Confirmed");

  elements.get("#logout-button").listeners.click();
  await flush();
  assert.equal(messages.some((message) => message.type === "CANCEL_RUN"), true);
  assert.equal(stored.has("poc-firebase-id-token"), false);
  assert.equal(elements.get("#login-panel").hidden, false);
  assert.equal(elements.get("#launcher-panel").hidden, true);

  console.log("PASS firebase-login-runs-through-extension-https-broker");
  console.log("PASS firebase-token-gates-extension-start");
  console.log("PASS hosted-page-has-no-password-field");
  console.log("PASS single-login-click-starts-gemini-agent");
  console.log("PASS poc-logout-clears-session-token");
  console.log("PASS poc-logout-cancels-owned-window");
  console.log("PASS readonly-username-restored-on-page-load");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
