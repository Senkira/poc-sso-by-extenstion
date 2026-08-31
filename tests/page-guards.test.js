"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

const noopEvent = { addListener() {} };
const observedDelays = [];
function fastSetTimeout(callback, delay) {
  observedDelays.push(delay);
  return setTimeout(callback, 0);
}
class FakeInput {
  constructor() { this._value = ""; this.events = []; this.focused = false; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
}
class FakeEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
}
const chrome = {
  alarms: { onAlarm: noopEvent },
  extension: {},
  runtime: { onMessageExternal: noopEvent, onMessage: noopEvent },
  storage: { session: {} },
  tabs: { onRemoved: noopEvent },
  webNavigation: { onCompleted: noopEvent, onCommitted: noopEvent }
};

const context = vm.createContext({
  chrome,
  URL,
  Map,
  Set,
  Promise,
  Date,
  Number,
  Error,
  Event: FakeEvent,
  InputEvent: FakeEvent,
  HTMLInputElement: FakeInput,
  setTimeout: fastSetTimeout,
  clearTimeout,
  location: { pathname: "/v3/signin/challenge/pwd" },
  document: null
});
vm.runInContext(fs.readFileSync("extension/service-worker.js", "utf8"), context);

function accountControl(email, extra = {}) {
  return {
    getAttribute(name) {
      if (name === "aria-label") return `Selected account ${email}`;
      return extra[name] || null;
    }
  };
}

function googleDocument(selectedControls, unrelatedTarget = false) {
  const passwordInput = {};
  return {
    querySelector(selector) {
      if (selector.includes("recaptcha") || selector.includes("one-time-code")) return null;
      if (selector.includes("input[name='Passwd']")) return passwordInput;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("jsname='af8ijd'")) return selectedControls;
      if (selector === "[data-identifier]") {
        return unrelatedTarget ? [accountControl("codeassist.04@easybuy.co.th")] : [];
      }
      return [];
    }
  };
}

function googlePasswordDocument(selectedControls) {
  const passwordInput = new FakeInput();
  const passwordButton = {
    disabled: false,
    clicks: 0,
    getAttribute() { return null; },
    click() { this.clicks += 1; }
  };
  return {
    passwordInput,
    passwordButton,
    querySelector(selector) {
      if (selector.includes("recaptcha") || selector.includes("one-time-code")) return null;
      if (selector.includes("input[name='Passwd']")) return passwordInput;
      if (selector.includes("#passwordNext")) return passwordButton;
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes("jsname='af8ijd'") ? selectedControls : [];
    }
  };
}

function geminiDocument(activeControls) {
  return {
    querySelectorAll(selector) {
      if (selector.includes("SignOutOptions") || selector.includes("data-ogsr-up")) return activeControls;
      return [];
    }
  };
}

const target = "codeassist.04@easybuy.co.th";
const other = "other-user@example.com";

context.document = googleDocument([accountControl(target)]);
assert.equal(context.inspectGooglePage(target).step, "PASSWORD_REQUIRED");

context.document = googleDocument([], true);
assert.equal(context.inspectGooglePage(target).step, "TARGET_ACCOUNT_NOT_CONFIRMED");

context.document = googleDocument([accountControl(target), accountControl(target)]);
assert.equal(context.inspectGooglePage(target).step, "PASSWORD_REQUIRED");

context.document = googleDocument([accountControl(target), accountControl(other)]);
assert.equal(context.inspectGooglePage(target).step, "TARGET_ACCOUNT_NOT_CONFIRMED");

async function main() {
  context.document = googleDocument([accountControl(other)]);
  assert.equal((await context.submitPassword(target, "test-only", "/other/document")).step, "STALE_PASSWORD_DOCUMENT");
  assert.equal(
    (await context.submitPassword(target, "test-only", "/v3/signin/challenge/pwd")).step,
    "TARGET_ACCOUNT_NOT_CONFIRMED"
  );

  const passwordDocument = googlePasswordDocument([accountControl(target)]);
  context.document = passwordDocument;
  const submitted = await context.submitPassword(target, "test-only", "/v3/signin/challenge/pwd");
  assert.equal(submitted.step, "PASSWORD_SUBMITTED");
  assert.equal(passwordDocument.passwordInput.value, "test-only");
  assert.equal(passwordDocument.passwordInput.focused, true);
  assert.equal(passwordDocument.passwordInput.events.includes("input"), true);
  assert.equal(passwordDocument.passwordButton.clicks, 1);
  assert.equal(observedDelays.includes(2000), true);
  assert.equal(observedDelays.includes(80), true);

  context.document = geminiDocument([accountControl(target)]);
  assert.equal(context.inspectGeminiActiveAccount(target), true);

  context.document = geminiDocument([accountControl(target), accountControl(target)]);
  assert.equal(context.inspectGeminiActiveAccount(target), true);

  context.document = geminiDocument([accountControl(target), accountControl(other)]);
  assert.equal(context.inspectGeminiActiveAccount(target), false);

  context.document = geminiDocument([accountControl(other)]);
  assert.equal(context.injectPrompt(target, "POC prompt").error, "TARGET_ACCOUNT_NOT_CONFIRMED");

  console.log("PASS duplicate-target-account-evidence-is-deduplicated");
  console.log("PASS unrelated-or-conflicting-account-evidence-fails-closed");
  console.log("PASS stale-password-path-fails-before-dom-write");
  console.log("PASS password-value-is-verified-before-single-submit-click");
  console.log("PASS password-fill-waits-two-seconds-then-submits-after-80ms");
  console.log("PASS gemini-active-account-guard-is-strict");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
