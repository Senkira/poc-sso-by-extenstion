"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { defineSecret } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const {
  EXTENSION_ORIGIN,
  POC_AUTH_EMAIL,
  POC_FIREBASE_UID,
  POC_USERNAME,
  PROTOCOL_VERSION,
  TARGET_EMAIL,
  parseBearer,
  validateAuthenticateRequest,
  validateCredentialRequest
} = require("./broker-core");

const FIREBASE_API_KEY = "AIzaSyBAmRwEIELh_AA7E1omzf8TrVV3Cp4HPFc";
const GEMINI_TARGET_PASSWORD = defineSecret("GEMINI_TARGET_PASSWORD");

initializeApp();

function setResponseHeaders(res) {
  res.set("Access-Control-Allow-Origin", EXTENSION_ORIGIN);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "600");
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Origin");
  res.set("X-Content-Type-Options", "nosniff");
}

function sendJson(res, status, payload) {
  setResponseHeaders(res);
  res.status(status).json(payload);
}

async function exchangeCustomToken(customToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(15000)
    }
  );
  const payload = await response.json();
  if (!response.ok
      || typeof payload?.idToken !== "string"
      || typeof payload?.expiresIn !== "string") {
    throw new Error("POC_TOKEN_EXCHANGE_FAILED");
  }
  return payload;
}

exports.credentialBroker = onRequest({
  region: "us-central1",
  secrets: [GEMINI_TARGET_PASSWORD],
  minInstances: 0,
  maxInstances: 3,
  timeoutSeconds: 30,
  memory: "256MiB"
}, async (req, res) => {
  const origin = req.get("Origin");
  if (origin !== EXTENSION_ORIGIN) {
    res.status(403).json({ ok: false, error: "UNTRUSTED_ORIGIN" });
    return;
  }
  if (req.method === "OPTIONS") {
    setResponseHeaders(res);
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST" || !req.is("application/json")) {
    sendJson(res, 405, { ok: false, error: "INVALID_REQUEST" });
    return;
  }

  try {
    if (req.body?.action === "authenticatePoc") {
      if (!validateAuthenticateRequest(req.body)) {
        sendJson(res, 400, { ok: false, error: "INVALID_REQUEST" });
        return;
      }
      const user = await getAuth().getUser(POC_FIREBASE_UID);
      if (user.email?.toLowerCase() !== POC_AUTH_EMAIL) {
        throw new Error("POC_IDENTITY_MISMATCH");
      }
      let customToken = await getAuth().createCustomToken(POC_FIREBASE_UID, {
        pocUsername: POC_USERNAME
      });
      const tokenPayload = await exchangeCustomToken(customToken);
      customToken = "";
      sendJson(res, 200, {
        ok: true,
        username: POC_USERNAME,
        idToken: tokenPayload.idToken,
        expiresIn: tokenPayload.expiresIn
      });
      return;
    }

    if (req.body?.action === "getGoogleCredential") {
      if (!validateCredentialRequest(req.body)) {
        sendJson(res, 400, { ok: false, error: "INVALID_REQUEST" });
        return;
      }
      const idToken = parseBearer(req.get("Authorization"));
      if (!idToken) {
        sendJson(res, 401, { ok: false, error: "POC_AUTH_REQUIRED" });
        return;
      }
      const decoded = await getAuth().verifyIdToken(idToken);
      if (decoded.uid !== POC_FIREBASE_UID
          || decoded.email?.toLowerCase() !== POC_AUTH_EMAIL) {
        sendJson(res, 403, { ok: false, error: "POC_AUTH_REQUIRED" });
        return;
      }
      const password = GEMINI_TARGET_PASSWORD.value();
      if (typeof password !== "string" || password.length === 0) {
        throw new Error("GOOGLE_CREDENTIAL_UNAVAILABLE");
      }
      sendJson(res, 200, {
        ok: true,
        email: TARGET_EMAIL,
        password
      });
      return;
    }

    sendJson(res, 400, { ok: false, error: "UNKNOWN_ACTION" });
  } catch {
    sendJson(res, 503, { ok: false, error: "BROKER_UNAVAILABLE" });
  }
});

exports._test = { exchangeCustomToken, PROTOCOL_VERSION };
