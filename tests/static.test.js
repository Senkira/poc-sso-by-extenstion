"use strict";

const assert = require("assert/strict");
const fs = require("fs");

const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const app = fs.readFileSync("public/app.js", "utf8");
const html = fs.readFileSync("public/index.html", "utf8");
const worker = fs.readFileSync("extension/service-worker.js", "utf8");
const host = fs.readFileSync("bootstrap/NativeHost.cs", "utf8");
const firebase = JSON.parse(fs.readFileSync("firebase.json", "utf8"));

assert.equal(manifest.version, "0.7.0");
assert.equal(manifest.incognito, "spanning");
assert.equal(manifest.permissions.includes("nativeMessaging"), true);
assert.equal(manifest.permissions.includes("storage"), false);
assert.equal(manifest.host_permissions.includes("http://127.0.0.1/*"), false);
assert.equal(manifest.host_permissions.includes("https://identitytoolkit.googleapis.com/*"), true);
assert.match(app, /PROTOCOL_VERSION = 7/);
assert.match(app, /type: "START_AGENT"/);
assert.match(app, /type: "POST_PROMPT"/);
assert.match(app, /accounts:signInWithPassword/);
assert.match(app, /pocIdToken/);
assert.doesNotMatch(app, /LOGIN_DIGEST|crypto\.subtle/);
assert.match(html, /POC login/);
assert.match(html, /isolated session/);
assert.match(worker, /incognito: true/);
assert.match(worker, /state: "minimized"/);
assert.match(worker, /accounts:lookup/);
assert.match(worker, /POC_AUTH_REQUIRED/);
assert.match(worker, /isAllowedIncognitoAccess/);
assert.match(host, /CredReadW/);
assert.equal(firebase.auth.providers.emailPassword, true);
assert.match(firebase.hosting.headers[0].headers[0].value, /identitytoolkit\.googleapis\.com/);
assert.doesNotMatch(`${app}\n${html}\n${worker}\n${host}`, /@[s]{2}w0rd/i);
assert.doesNotMatch(worker, /chrome\.cookies|chrome\.debugger/);

console.log("PASS manifest-v3-native-bridge");
console.log("PASS no-secret-in-source");
console.log("PASS static-hosted-agent-launcher");
console.log("PASS isolated-login-and-prompt-contract");
console.log("PASS firebase-auth-is-real-and-extension-gated");
