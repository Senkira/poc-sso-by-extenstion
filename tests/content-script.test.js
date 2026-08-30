"use strict";

const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");

let calls = 0;
const scheduled = [];

const chrome = {
  runtime: {
    async sendMessage() {
      calls += 1;
      return { ok: calls >= 2 };
    }
  }
};

vm.runInNewContext(
  fs.readFileSync("extension/content-script.js", "utf8"),
  {
    chrome,
    document: { readyState: "complete" },
    location: { origin: "https://gemini.google.com" },
    window: { addEventListener() {} },
    setTimeout(callback, delay) {
      scheduled.push({ callback, delay });
    }
  }
);

async function main() {
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 100);

  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(scheduled.length, 0);

  console.log("PASS content-signal-retry-after-mapping-race");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
