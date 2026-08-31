"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");

const noopEvent = { addListener() {} };
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
  setTimeout,
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
assert.equal(context.inspectGooglePage(target).step, "TARGET_ACCOUNT_NOT_CONFIRMED");

context.document = googleDocument([accountControl(other)]);
assert.equal(context.submitPassword(target, "test-only", "/other/document").step, "STALE_PASSWORD_DOCUMENT");
assert.equal(
  context.submitPassword(target, "test-only", "/v3/signin/challenge/pwd").step,
  "TARGET_ACCOUNT_NOT_CONFIRMED"
);

context.document = geminiDocument([accountControl(target)]);
assert.equal(context.inspectGeminiActiveAccount(target), true);

context.document = geminiDocument([accountControl(target), accountControl(other)]);
assert.equal(context.inspectGeminiActiveAccount(target), false);

context.document = geminiDocument([accountControl(other)]);
assert.equal(context.injectPrompt(target, "POC prompt").error, "TARGET_ACCOUNT_NOT_CONFIRMED");

console.log("PASS google-password-requires-one-selected-account-control");
console.log("PASS unrelated-or-multiple-account-evidence-fails-closed");
console.log("PASS stale-password-path-fails-before-dom-write");
console.log("PASS gemini-active-account-guard-is-strict");
