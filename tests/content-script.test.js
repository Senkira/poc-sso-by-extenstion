"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runScenario({ readyState, initiallyVisible, unrelated = false }) {
  let visible = initiallyVisible;
  let loadListener = null;
  const scheduled = [];
  const messages = [];
  const accountNode = {
    getAttribute(name) {
      if (name === "aria-label" && visible) {
        return "Google Account: codeassist.04@easybuy.co.th";
      }
      if (name === "href" && visible && !unrelated) {
        return "https://accounts.google.com/SignOutOptions";
      }
      return null;
    }
  };
  const document = {
    readyState,
    querySelectorAll(selector) {
      if (selector === "[data-email],[data-identifier]") return [];
      return visible && !unrelated ? [accountNode] : [];
    }
  };
  const chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push({ ...message });
        return { ok: true, confirmed: message.targetAccountObserved };
      }
    }
  };

  vm.runInNewContext(
    fs.readFileSync("extension/content-script.js", "utf8"),
    {
      chrome,
      document,
      location: { origin: "https://gemini.google.com" },
      window: { addEventListener(type, listener) { if (type === "load") loadListener = listener; } },
      setTimeout(callback, delay) { scheduled.push({ callback, delay }); }
    }
  );

  if (readyState !== "complete") {
    assert.equal(messages.length, 0);
    loadListener({ type: "load" });
  }
  await flush();
  assert.equal(messages[0].version, 7);
  const initiallyObserved = initiallyVisible && !unrelated;
  assert.equal(messages[0].targetAccountObserved, initiallyObserved);

  if (!initiallyObserved && !unrelated) {
    assert.equal(scheduled.length, 1);
    visible = true;
    scheduled.shift().callback();
    await flush();
    assert.equal(messages[1].targetAccountObserved, true);
    assert.equal(messages[1].identityCheckComplete, true);
    assert.equal(scheduled.length, 0);
  } else if (initiallyObserved) {
    assert.equal(messages[0].identityCheckComplete, true);
    assert.equal(scheduled.length, 0);
  } else {
    assert.equal(messages[0].identityCheckComplete, false);
    assert.equal(scheduled.length, 1);
  }
}

async function main() {
  await runScenario({ readyState: "complete", initiallyVisible: false });
  await runScenario({ readyState: "interactive", initiallyVisible: true });
  await runScenario({ readyState: "complete", initiallyVisible: true, unrelated: true });
  console.log("PASS target-account-observation-retries");
  console.log("PASS unrelated-email-label-is-not-account-confirmation");
  console.log("PASS load-event-keeps-zero-attempt-index");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
