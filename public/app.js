"use strict";

const EXTENSION_ID = "jeenmgigpkffleijbmfciffiodlcdafh";
const REQUIRED_EXTENSION_VERSION = "0.12.3";
const PROTOCOL_VERSION = 9;
const CAPABILITY = "EXTENSION_AGENT_ONE_SHOT_BRIDGE";
const POC_USERNAME = "O1234567";
const AUTH_TOKEN_KEY = "poc-firebase-id-token";
const AUTH_EXPIRY_KEY = "poc-firebase-id-token-expiry";
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const TERMINAL_STAGES = new Set([
  "GEMINI_TARGET_ACCOUNT_CONFIRMED",
  "GEMINI_TARGET_ACCOUNT_NOT_CONFIRMED",
  "USER_ACTION_REQUIRED",
  "TARGET_ACCOUNT_NOT_CONFIRMED",
  "CREDENTIAL_BRIDGE_FAILED",
  "PASSWORD_FORM_UNAVAILABLE",
  "STALE_PASSWORD_DOCUMENT",
  "CREDENTIAL_ALREADY_CLAIMED",
  "DOCUMENT_ID_UNAVAILABLE",
  "GOOGLE_PAGE_UNRECOGNIZED",
  "AUTH_TIMEOUT",
  "ISOLATION_LOST",
  "FRAME_UNAVAILABLE",
  "FRAME_RECONCILIATION_FAILED",
  "GEMINI_CONTEXT_CHANGED",
  "OPEN_FAILED",
  "TAB_CLOSED",
  "CANCELLED"
]);

const elements = {
  loginPanel: document.querySelector("#login-panel"),
  launcherPanel: document.querySelector("#launcher-panel"),
  loginForm: document.querySelector("#login-form"),
  username: document.querySelector("#username"),
  loginButton: document.querySelector("#login-button"),
  preflightButton: document.querySelector("#preflight-button"),
  preflightBadge: document.querySelector("#preflight-badge"),
  preflightDetail: document.querySelector("#preflight-detail"),
  logoutButton: document.querySelector("#logout-button"),
  loginError: document.querySelector("#login-error"),
  connectionBadge: document.querySelector("#connection-badge"),
  connectionDetail: document.querySelector("#connection-detail"),
  launchButton: document.querySelector("#launch-button"),
  retryButton: document.querySelector("#retry-button"),
  requestValue: document.querySelector("#request-value"),
  stageValue: document.querySelector("#stage-value"),
  originValue: document.querySelector("#origin-value"),
  credentialValue: document.querySelector("#credential-value"),
  accountValue: document.querySelector("#account-value"),
  noteValue: document.querySelector("#note-value"),
  extensionId: document.querySelector("#extension-id")
};

let activeRun = null;
let authState = loadAuthState();

elements.extensionId.textContent = EXTENSION_ID;
elements.username.value = POC_USERNAME;

function sendToExtension(message) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("EXTENSION_API_UNAVAILABLE"));
      return;
    }
    chrome.runtime.sendMessage(EXTENSION_ID, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function loadAuthState() {
  const idToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const expiresAt = Number(sessionStorage.getItem(AUTH_EXPIRY_KEY));
  if (!idToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem(AUTH_EXPIRY_KEY);
    return null;
  }
  return { idToken, expiresAt };
}

function clearPocSession() {
  authState = null;
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem(AUTH_EXPIRY_KEY);
}

function getPocIdToken() {
  if (!authState || authState.expiresAt <= Date.now()) {
    clearPocSession();
    showAuthenticatedState();
    throw new Error("POC_AUTH_EXPIRED");
  }
  return authState.idToken;
}

function showAuthenticatedState(checkConnection = true) {
  const loggedIn = authState !== null && authState.expiresAt > Date.now();
  elements.loginPanel.hidden = loggedIn;
  elements.launcherPanel.hidden = !loggedIn;
  if (loggedIn && checkConnection) {
    void checkExtension();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const username = elements.username.value.trim();
  if (username.toUpperCase() !== POC_USERNAME) {
    elements.loginError.textContent = "Invalid employee ID";
    return;
  }
  elements.loginButton.disabled = true;
  try {
    const result = await sendToExtension({
      type: "AUTHENTICATE_POC",
      version: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      username
    });
    if (!result?.ok || typeof result.idToken !== "string") {
      throw new Error("INVALID_POC_CREDENTIAL");
    }
    const expiresInSeconds = Number(result.expiresIn);
    const expiresAt = Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;
    authState = { idToken: result.idToken, expiresAt };
    sessionStorage.setItem(AUTH_TOKEN_KEY, authState.idToken);
    sessionStorage.setItem(AUTH_EXPIRY_KEY, String(authState.expiresAt));
    result.idToken = "";
    showAuthenticatedState(false);
    if (await checkExtension()) {
      await launchGemini();
    }
  } catch {
    clearPocSession();
    elements.loginError.textContent = "POC authentication failed";
  } finally {
    elements.loginButton.disabled = false;
  }
}

async function handleLogout() {
  if (activeRun && activeRun.timerId !== null) clearTimeout(activeRun.timerId);
  const run = activeRun;
  const pocIdToken = authState?.idToken || null;
  activeRun = null;
  if (run && pocIdToken) {
    await sendToExtension({
      type: "CANCEL_RUN",
      version: PROTOCOL_VERSION,
      requestId: run.requestId,
      pocIdToken
    }).catch(() => null);
  }
  clearPocSession();
  showAuthenticatedState();
}

function setConnection(connected, detail) {
  elements.connectionBadge.textContent = connected ? "Connected" : "Not detected";
  elements.connectionBadge.className = `badge ${connected ? "ok" : "error"}`;
  elements.connectionDetail.textContent = detail;
  elements.preflightBadge.textContent = connected ? "Connected" : "Not detected";
  elements.preflightBadge.className = `badge ${connected ? "ok" : "error"}`;
  elements.preflightDetail.textContent = detail;
  elements.launchButton.disabled = !connected;
}

function renderRun(run) {
  elements.requestValue.textContent = run.requestId;
  elements.stageValue.textContent = run.stage;
  elements.originValue.textContent = run.observedOrigin || "—";
  elements.credentialValue.textContent = run.credentialDelivered ? "Delivered once" : "Pending";
  elements.accountValue.textContent = run.targetAccountConfirmed
    ? "Confirmed"
    : run.identityCheckComplete ? "Not confirmed" : "Pending";
  elements.noteValue.textContent = run.note || "—";
}

function renderUnavailable(stage) {
  elements.stageValue.textContent = stage;
  elements.originValue.textContent = "Unavailable";
  elements.credentialValue.textContent = "Unavailable";
  elements.accountValue.textContent = "Unavailable";
  elements.noteValue.textContent = "—";
}

async function checkExtension() {
  elements.connectionBadge.textContent = "Checking";
  elements.connectionBadge.className = "badge pending";
  elements.launchButton.disabled = true;
  try {
    const response = await sendToExtension({ type: "PING", version: PROTOCOL_VERSION });
    if (!response?.ok
        || response.protocolVersion !== PROTOCOL_VERSION
        || response.version !== REQUIRED_EXTENSION_VERSION
        || response.capability !== CAPABILITY) {
      setConnection(false, `Reload Extension v${REQUIRED_EXTENSION_VERSION}`);
      return false;
    }
    if (response.incognitoAccessAllowed !== true) {
      setConnection(false, "Enable Allow in InPrivate");
      return false;
    }
    setConnection(true, `Extension v${response.version} ready`);
    return true;
  } catch {
    setConnection(false, "Extension not found");
    return false;
  }
}

function schedulePoll(run) {
  if (activeRun !== run || run.timerId !== null) return;
  run.timerId = setTimeout(() => {
    run.timerId = null;
    void pollStatus(run);
  }, POLL_INTERVAL_MS);
}

async function pollStatus(run) {
  if (activeRun !== run || run.pollInFlight) return;
  if (Date.now() - run.startedAt > POLL_TIMEOUT_MS) {
    renderUnavailable("STATUS_TIMEOUT");
    return;
  }
  run.pollInFlight = true;
  try {
    const response = await sendToExtension({
      type: "GET_STATUS", version: PROTOCOL_VERSION, requestId: run.requestId
    });
    if (activeRun !== run) return;
    if (!response?.ok || response.run?.requestId !== run.requestId) {
      renderUnavailable(response?.error || "STATUS_UNAVAILABLE");
      return;
    }
    renderRun(response.run);
    if (!response.run.closed && !TERMINAL_STAGES.has(response.run.stage)) schedulePoll(run);
  } catch {
    renderUnavailable("CHANNEL_UNAVAILABLE");
  } finally {
    run.pollInFlight = false;
  }
}

async function launchGemini() {
  let pocIdToken;
  try {
    pocIdToken = getPocIdToken();
  } catch {
    return;
  }
  if (activeRun && activeRun.timerId !== null) clearTimeout(activeRun.timerId);
  const run = {
    requestId: crypto.randomUUID(),
    timerId: null,
    pollInFlight: false,
    startedAt: Date.now()
  };
  activeRun = run;
  elements.launchButton.disabled = true;
  elements.requestValue.textContent = run.requestId;
  elements.stageValue.textContent = "STARTING_LOCAL_CREDENTIAL_BRIDGE";
  elements.originValue.textContent = "—";
  elements.credentialValue.textContent = "Pending";
  elements.accountValue.textContent = "Pending";
  elements.noteValue.textContent = "Waiting for Google password step";
  try {
    const response = await sendToExtension({
      type: "START_AGENT",
      version: PROTOCOL_VERSION,
      requestId: run.requestId,
      pocIdToken
    });
    if (activeRun !== run) return;
    if (!response?.ok || response.run?.requestId !== run.requestId) {
      renderUnavailable(response?.error || "OPEN_FAILED");
      return;
    }
    renderRun(response.run);
    schedulePoll(run);
  } catch {
    renderUnavailable("CHANNEL_UNAVAILABLE");
  } finally {
    elements.launchButton.disabled = false;
  }
}

elements.loginForm.addEventListener("submit", (event) => { void handleLogin(event); });
elements.preflightButton.addEventListener("click", () => { void checkExtension(); });
elements.logoutButton.addEventListener("click", () => { void handleLogout(); });
elements.launchButton.addEventListener("click", () => { void launchGemini(); });
elements.retryButton.addEventListener("click", () => { void checkExtension(); });
showAuthenticatedState();
if (authState === null) void checkExtension();
