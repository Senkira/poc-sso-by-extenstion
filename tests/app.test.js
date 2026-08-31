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
  "#login-panel", "#launcher-panel", "#login-form", "#username", "#password",
  "#login-button", "#logout-button", "#login-error", "#connection-badge",
  "#connection-detail", "#launch-button", "#retry-button", "#prompt",
  "#prompt-button", "#request-value", "#stage-value", "#origin-value",
  "#credential-value", "#account-value", "#note-value", "#extension-id"
];
const elements = new Map(selectors.map((selector) => [selector, element()]));
const stored = new Map();
const idToken = "firebase-id-token".padEnd(160, "x");
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const messages = [];
let fetchCount = 0;

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
          version: "0.7.0",
          protocolVersion: 7,
          capability: "EXTENSION_AGENT_ONE_SHOT_BRIDGE",
          incognitoAccessAllowed: true
        });
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
            targetAccountConfirmed: true,
            identityCheckComplete: true,
            closed: false
          }
        });
        return;
      }
      if (message.type === "POST_PROMPT") {
        callback({
          ok: true,
          run: {
            requestId: message.requestId,
            stage: "PROMPT_SUBMITTED",
            observedOrigin: "https://gemini.google.com",
            credentialDelivered: true,
            targetAccountConfirmed: true,
            identityCheckComplete: true,
            closed: false
          }
        });
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
  fetch: async (url, options) => {
    fetchCount += 1;
    assert.match(url, /accounts:signInWithPassword/);
    const body = JSON.parse(options.body);
    assert.equal(body.email, "o1234567@poc.invalid");
    assert.equal(body.password, "test-password");
    return {
      ok: true,
      async json() {
        return {
          idToken,
          refreshToken: "discard-me",
          email: "o1234567@poc.invalid",
          expiresIn: "3600"
        };
      }
    };
  },
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
  assert.equal(elements.get("#login-panel").hidden, false);
  assert.equal(elements.get("#launcher-panel").hidden, true);

  elements.get("#username").value = "O1234567";
  elements.get("#password").value = "test-password";
  elements.get("#login-form").listeners.submit({ preventDefault() {} });
  await flush();

  assert.equal(fetchCount, 1);
  assert.equal(stored.get("poc-firebase-id-token"), idToken);
  assert.equal(elements.get("#password").value, "");
  assert.equal(elements.get("#login-panel").hidden, true);
  assert.equal(elements.get("#launcher-panel").hidden, false);
  assert.equal(elements.get("#connection-badge").textContent, "Connected");

  elements.get("#launch-button").listeners.click();
  await flush();
  assert.equal(messages.some((message) => message.type === "START_AGENT"), true);
  assert.equal(elements.get("#account-value").textContent, "Confirmed");
  assert.equal(elements.get("#prompt-button").disabled, false);

  elements.get("#prompt").value = "POC test prompt";
  elements.get("#prompt-button").listeners.click();
  await flush();
  assert.equal(messages.some((message) => message.type === "POST_PROMPT"), true);
  assert.equal(elements.get("#prompt").value, "");

  elements.get("#logout-button").listeners.click();
  assert.equal(stored.has("poc-firebase-id-token"), false);
  assert.equal(elements.get("#login-panel").hidden, false);
  assert.equal(elements.get("#launcher-panel").hidden, true);

  console.log("PASS firebase-login-replaces-client-digest");
  console.log("PASS firebase-token-gates-extension-start-and-prompt");
  console.log("PASS password-field-cleared-after-login");
  console.log("PASS poc-logout-clears-session-token");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
