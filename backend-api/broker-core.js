"use strict";

const PROTOCOL_VERSION = 10;
const EXTENSION_ORIGIN = "chrome-extension://jeenmgigpkffleijbmfciffiodlcdafh";
const POC_USERNAME = "O1234567";
const POC_AUTH_EMAIL = "o1234567@poc.invalid";
const POC_FIREBASE_UID = "VHX1QkrsewSrrWB0g3BjyHepdWX2";
const TARGET_EMAIL = "codeassist.04@easybuy.co.th";

function isRequestId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateAuthenticateRequest(body) {
  return hasExactKeys(body, ["action", "requestId", "username", "version"])
    && body.action === "authenticatePoc"
    && body.version === PROTOCOL_VERSION
    && isRequestId(body.requestId)
    && typeof body.username === "string"
    && body.username.trim().toUpperCase() === POC_USERNAME;
}

function validateCredentialRequest(body) {
  return hasExactKeys(body, ["action", "requestId", "version"])
    && body.action === "getGoogleCredential"
    && body.version === PROTOCOL_VERSION
    && isRequestId(body.requestId);
}

function parseBearer(value) {
  if (typeof value !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match ? match[1] : null;
}

module.exports = {
  EXTENSION_ORIGIN,
  POC_AUTH_EMAIL,
  POC_FIREBASE_UID,
  POC_USERNAME,
  PROTOCOL_VERSION,
  TARGET_EMAIL,
  hasExactKeys,
  isRequestId,
  parseBearer,
  validateAuthenticateRequest,
  validateCredentialRequest
};
