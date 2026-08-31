"use strict";

const EXTENSION_ID = "jeenmgigpkffleijbmfciffiodlcdafh";
const REQUIRED_EXTENSION_VERSION = "0.7.0";
const PROTOCOL_VERSION = 7;
const CAPABILITY = "EXTENSION_AGENT_ONE_SHOT_BRIDGE";
const FIREBASE_API_KEY = "AIzaSyBAmRwEIELh_AA7E1omzf8TrVV3Cp4HPFc";
const POC_USERNAME = "O1234567";
const POC_AUTH_EMAIL = "o1234567@poc.invalid";
const AUTH_TOKEN_KEY = "poc-firebase-id-token";
const AUTH_EXPIRY_KEY = "poc-firebase-id-token-expiry";
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;
const TERMINAL_STAGES = new Set([
  "GEMINI_TARGET_ACCOUNT_CONFIRMED",
  "GEMINI_TARGET_ACCOUNT_NOT_CONFIRMED",
  "USER_ACTION_REQUIRED",
  "TARGET_ACCOUNT_NOT_CONFIRMED",
  "CREDENTIAL_BRIDGE_FAILED",
  "PASSWORD_FORM_UNAVAILABLE",
  "STALE_PASSWORD_DOCUMENT",
  "GOOGLE_PAGE_UNRECOGNIZED",
  "OPEN_FAILED",
  "TAB_CLOSED"
]);

const elements = {
  loginPanel: document.querySelector("#login-panel"),
  launcherPanel: document.querySelector("#launcher-panel"),
  loginForm: document.querySelector("#login-form"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  loginButton: document.querySelector("#login-button"),
  logoutButton: document.querySelector("#logout-button"),
  loginError: document.querySelector("#login-error"),
  connectionBadge: document.querySelector("#connection-badge"),
  connectionDetail: document.querySelector("#connection-detail"),
  launchButton: document.querySelector("#launch-button"),
  retryButton: document.querySelector("#retry-button"),
  prompt: document.querySelector("#prompt"),
  promptButton: document.querySelector("#prompt-button"),
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

function showAuthenticatedState() {
  const loggedIn = authState !== null && authState.expiresAt > Date.now();
  elements.loginPanel.hidden = loggedIn;
  elements.launcherPanel.hidden = !loggedIn;
  if (loggedIn) {
    void checkExtension();
  } else {
    elements.password.value = "";
  }
}

async function handleLogin(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const username = elements.username.value.trim();
  let password = elements.password.value;
  if (username.toUpperCase() !== POC_USERNAME) {
    elements.password.value = "";
    elements.loginError.textContent = "ชื่อผู้ใช้หรือรหัสผ่าน POC ไม่ถูกต้อง";
    return;
  }
  elements.loginButton.disabled = true;
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: POC_AUTH_EMAIL, password, returnSecureToken: true })
      }
    );
    const result = await response.json();
    password = "";
    elements.password.value = "";
    if (!response.ok
        || typeof result.idToken !== "string"
        || result.email?.toLowerCase() !== POC_AUTH_EMAIL) {
      throw new Error("INVALID_POC_CREDENTIAL");
    }
    const expiresInSeconds = Number(result.expiresIn);
    const expiresAt = Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;
    authState = { idToken: result.idToken, expiresAt };
    sessionStorage.setItem(AUTH_TOKEN_KEY, authState.idToken);
    sessionStorage.setItem(AUTH_EXPIRY_KEY, String(authState.expiresAt));
    if (typeof result.refreshToken === "string") result.refreshToken = "";
    showAuthenticatedState();
  } catch {
    password = "";
    elements.password.value = "";
    clearPocSession();
    elements.loginError.textContent = "ชื่อผู้ใช้หรือรหัสผ่าน POC ไม่ถูกต้อง";
  } finally {
    elements.loginButton.disabled = false;
  }
}

function handleLogout() {
  if (activeRun && activeRun.timerId !== null) clearTimeout(activeRun.timerId);
  activeRun = null;
  clearPocSession();
  showAuthenticatedState();
}

function setConnection(connected, detail) {
  elements.connectionBadge.textContent = connected ? "Connected" : "Not detected";
  elements.connectionBadge.className = `badge ${connected ? "ok" : "error"}`;
  elements.connectionDetail.textContent = detail;
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
  const ready = run.stage === "GEMINI_TARGET_ACCOUNT_CONFIRMED" && run.targetAccountConfirmed;
  elements.prompt.disabled = !ready;
  elements.promptButton.disabled = !ready;
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
      setConnection(false, `ต้อง Reload Gemini Extension Agent v${REQUIRED_EXTENSION_VERSION}`);
      return;
    }
    if (response.incognitoAccessAllowed !== true) {
      setConnection(false, "พบ Extension แล้ว แต่ต้องเปิด Allow in InPrivate/Incognito ก่อนใช้งาน");
      return;
    }
    setConnection(true, `เชื่อมต่อ Gemini Extension Agent v${response.version} แล้ว`);
  } catch {
    setConnection(false, "ไม่พบ extension ที่ติดตั้งและอนุญาตสำหรับเว็บนี้");
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
  elements.noteValue.textContent = "Extension จะเรียก one-shot native credential bridge เมื่อ Google แสดง password step";
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

async function submitPrompt() {
  if (!activeRun || !elements.prompt.value.trim()) return;
  let pocIdToken;
  try {
    pocIdToken = getPocIdToken();
  } catch {
    return;
  }
  elements.promptButton.disabled = true;
  const response = await sendToExtension({
    type: "POST_PROMPT",
    version: PROTOCOL_VERSION,
    requestId: activeRun.requestId,
    pocIdToken,
    prompt: elements.prompt.value.trim()
  }).catch(() => ({ ok: false, error: "CHANNEL_UNAVAILABLE" }));
  if (response?.run) renderRun(response.run);
  if (response?.ok) elements.prompt.value = "";
  else elements.noteValue.textContent = response?.error || "PROMPT_SUBMIT_FAILED";
}

elements.loginForm.addEventListener("submit", (event) => { void handleLogin(event); });
elements.logoutButton.addEventListener("click", handleLogout);
elements.launchButton.addEventListener("click", () => { void launchGemini(); });
elements.retryButton.addEventListener("click", () => { void checkExtension(); });
elements.promptButton.addEventListener("click", () => { void submitPrompt(); });
showAuthenticatedState();
