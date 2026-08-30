"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

function element() {
  return {
    disabled: false,
    hidden: false,
    listeners: {},
    textContent: "",
    value: "",
    addEventListener(type, listener) { this.listeners[type] = listener; },
    focus() {}
  };
}

const form = element();
const passwordInput = element();
const submitButton = element();
const status = element();
const elements = new Map([
  ["#login-form", form],
  ["#password", passwordInput],
  ["#submit-button", submitButton],
  ["#status", status]
]);
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const challengeId = "223e4567-e89b-42d3-a456-426614174000";
const sent = [];
const windowListeners = {};

vm.runInNewContext(
  fs.readFileSync("extension/login.js", "utf8"),
  {
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(structuredClone(message));
          return { ok: true };
        }
      }
    },
    document: { querySelector(selector) { return elements.get(selector); } },
    location: { href: `chrome-extension://example/login.html?requestId=${requestId}&challengeId=${challengeId}` },
    URL,
    window: { addEventListener(type, listener) { windowListeners[type] = listener; } }
  }
);

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const oneTimeValue = "one-time-sensitive-value";
  passwordInput.value = oneTimeValue;
  form.listeners.submit({ preventDefault() {} });
  assert.equal(passwordInput.value, "", "password field must clear before awaiting the worker");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "PASS_PASSWORD",
    version: 2,
    requestId,
    challengeId,
    password: oneTimeValue
  });
  await flush();
  assert.equal(passwordInput.value, "");
  assert.match(status.textContent, /ส่งผ่านและล้าง/);
  windowListeners.pagehide();
  assert.equal(passwordInput.value, "");
  assert.doesNotMatch(fs.readFileSync("extension/login.js", "utf8"), /chrome\.storage/);

  console.log("PASS password-sent-only-from-post-challenge-extension-page");
  console.log("PASS password-field-cleared-before-worker-response");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
