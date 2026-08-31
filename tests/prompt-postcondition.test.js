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

class FakeInput {
  constructor() { this._value = ""; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  focus() {}
  dispatchEvent() {}
  contains(node) { return node === this; }
}

function accountControl(email) {
  return {
    getAttribute(name) { return name === "aria-label" ? `Google Account: ${email}` : null; }
  };
}

function visibleExactBubble(text) {
  return {
    innerText: text,
    children: [],
    contains() { return false; },
    getClientRects() { return [{}]; }
  };
}

function promptDocument({ targetEmail, prompt, confirmAfterClick }) {
  const composer = new FakeInput();
  const bubbles = [];
  const root = {
    querySelectorAll() { return bubbles; }
  };
  const send = {
    disabled: false,
    click() {
      if (!confirmAfterClick) return;
      composer.value = "";
      bubbles.push(visibleExactBubble(prompt));
    }
  };
  return {
    body: root,
    querySelector(selector) {
      if (selector === "main, [role='main']") return root;
      if (selector.includes("contenteditable") || selector.includes("textarea")) return composer;
      if (selector.includes("button[aria-label")) return send;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("SignOutOptions") || selector.includes("data-ogsr-up")) {
        return [accountControl(targetEmail)];
      }
      return [];
    }
  };
}

const context = vm.createContext({
  chrome,
  URL,
  Map,
  Set,
  Promise,
  Date,
  Number,
  Error,
  HTMLTextAreaElement: FakeInput,
  HTMLInputElement: FakeInput,
  Event: class {},
  InputEvent: class {},
  setTimeout(callback) { Promise.resolve().then(callback); return 1; },
  clearTimeout() {},
  document: null
});
vm.runInContext(fs.readFileSync("extension/service-worker.js", "utf8"), context);

async function main() {
  const targetEmail = "codeassist.04@easybuy.co.th";
  const prompt = "unique POC postcondition prompt";

  context.document = promptDocument({ targetEmail, prompt, confirmAfterClick: true });
  const confirmed = await context.injectPrompt(targetEmail, prompt);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.postcondition, "EXACT_USER_TURN_OBSERVED");

  context.document = promptDocument({ targetEmail, prompt, confirmAfterClick: false });
  const unconfirmed = await context.injectPrompt(targetEmail, prompt);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error, "PROMPT_POSTCONDITION_NOT_OBSERVED");

  console.log("PASS prompt-click-alone-is-not-success");
  console.log("PASS prompt-success-requires-new-exact-visible-user-turn");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
