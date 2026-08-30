"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runScenario(readyState) {
  let calls = 0;
  let loadListener = null;
  const scheduled = [];
  const chrome = {
    runtime: {
      async sendMessage(message) {
        assert.equal(message.version, 2);
        calls += 1;
        return { ok: calls >= 2 };
      }
    }
  };

  vm.runInNewContext(
    fs.readFileSync("extension/content-script.js", "utf8"),
    {
      chrome,
      document: { readyState },
      location: { origin: "https://gemini.google.com" },
      window: { addEventListener(type, listener) { if (type === "load") loadListener = listener; } },
      setTimeout(callback, delay) { scheduled.push({ callback, delay }); }
    }
  );

  if (readyState !== "complete") {
    assert.equal(calls, 0);
    assert.equal(typeof loadListener, "function");
    loadListener({ type: "load" });
  }
  await flush();
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 100);
  scheduled.shift().callback();
  await flush();
  assert.equal(calls, 2);
  assert.equal(scheduled.length, 0);
}

async function main() {
  await runScenario("complete");
  await runScenario("interactive");
  console.log("PASS content-signal-retry-after-mapping-race");
  console.log("PASS load-event-does-not-replace-retry-counter");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
