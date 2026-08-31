"use strict";

const assert = require("assert/strict");
const {
  EXTENSION_ORIGIN,
  POC_USERNAME,
  PROTOCOL_VERSION,
  isRequestId,
  parseBearer,
  validateAuthenticateRequest,
  validateCredentialRequest
} = require("../broker-core");

const requestId = "123e4567-e89b-42d3-a456-426614174000";

assert.equal(PROTOCOL_VERSION, 10);
assert.equal(EXTENSION_ORIGIN, "chrome-extension://jeenmgigpkffleijbmfciffiodlcdafh");
assert.equal(POC_USERNAME, "O1234567");
assert.equal(isRequestId(requestId), true);
assert.equal(validateAuthenticateRequest({
  action: "authenticatePoc",
  requestId,
  username: "O1234567",
  version: 10
}), true);
assert.equal(validateAuthenticateRequest({
  action: "authenticatePoc",
  requestId,
  username: "O1234567",
  version: 10,
  unexpected: true
}), false);
assert.equal(validateCredentialRequest({
  action: "getGoogleCredential",
  requestId,
  version: 10
}), true);
assert.equal(parseBearer("Bearer header.payload.signature"), "header.payload.signature");
assert.equal(parseBearer("Basic abc"), null);

console.log("PASS broker-strict-schema");
console.log("PASS broker-extension-origin-contract");
console.log("PASS broker-bearer-token-contract");
