"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runScenario({ readyState, initiallyVisible }) {
  let visible = initiallyVisible;
  let loadListener = null;
  const scheduled = [];
  const messages = [];
  const accountNode = {
    getAttribute(name) {
      if (name === "aria-label" && visible) {
        return "Google Account: codeassist.04@easybuy.co.th";
      }
      return null;
    }
  };
  const document = {
    readyState,
    querySelectorAll() { return [accountNode]; }
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
  assert.equal(messages[0].version, 3);
  assert.equal(messages[0].targetAccountObserved, initiallyVisible);

  if (!initiallyVisible) {
    assert.equal(scheduled.length, 1);
    visible = true;
    scheduled.shift().callback();
    await flush();
    assert.equal(messages[1].targetAccountObserved, true);
    assert.equal(messages[1].identityCheckComplete, true);
    assert.equal(scheduled.length, 0);
  } else {
    assert.equal(messages[0].identityCheckComplete, true);
    assert.equal(scheduled.length, 0);
  }
}

async function main() {
  await runScenario({ readyState: "complete", initiallyVisible: false });
  await runScenario({ readyState: "interactive", initiallyVisible: true });
  console.log("PASS target-account-observation-retries");
  console.log("PASS load-event-keeps-zero-attempt-index");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
