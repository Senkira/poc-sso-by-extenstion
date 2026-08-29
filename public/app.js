"use strict";

const EXTENSION_ID = "jeenmgigpkffleijbmfciffiodlcdafh";
const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

const elements = {
  connectionBadge: document.querySelector("#connection-badge"),
  connectionDetail: document.querySelector("#connection-detail"),
  launchButton: document.querySelector("#launch-button"),
  retryButton: document.querySelector("#retry-button"),
  requestValue: document.querySelector("#request-value"),
  stageValue: document.querySelector("#stage-value"),
  originValue: document.querySelector("#origin-value"),
  documentValue: document.querySelector("#document-value"),
  extensionId: document.querySelector("#extension-id")
};

let activeRequestId = null;
let pollTimer = null;
let pollStartedAt = 0;

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

function setConnection(connected, detail) {
  elements.connectionBadge.textContent = connected ? "Connected" : "Not detected";
  elements.connectionBadge.className = `badge ${connected ? "ok" : "error"}`;
  elements.connectionDetail.textContent = detail;
  elements.launchButton.disabled = !connected;
}

function renderRun(run) {
  if (!run) {
    return;
  }
  elements.requestValue.textContent = run.requestId;
  elements.stageValue.textContent = run.stage;
  elements.originValue.textContent = run.observedOrigin || "—";
  elements.documentValue.textContent = run.documentObserved ? "Observed" : "Not observed";
}

async function checkExtension() {
  elements.connectionBadge.textContent = "Checking";
  elements.connectionBadge.className = "badge pending";
  elements.launchButton.disabled = true;

  try {
    const response = await sendToExtension({ type: "PING", version: PROTOCOL_VERSION });
    if (!response?.ok || response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("PROTOCOL_MISMATCH");
    }
    setConnection(true, `เชื่อมต่อ Gemini SSO Launcher v${response.version} แล้ว`);
  } catch {
    setConnection(false, "ไม่พบ extension ที่ติดตั้งและอนุญาตสำหรับเว็บนี้");
  }
}

async function pollStatus() {
  if (!activeRequestId) {
    return;
  }

  if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
    clearInterval(pollTimer);
    pollTimer = null;
    elements.stageValue.textContent = "STATUS_TIMEOUT";
    return;
  }

  try {
    const response = await sendToExtension({
      type: "GET_STATUS",
      version: PROTOCOL_VERSION,
      requestId: activeRequestId
    });
    if (response?.ok) {
      renderRun(response.run);
      if (response.run.closed || response.run.stage === "OPEN_FAILED") {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  } catch {
    clearInterval(pollTimer);
    pollTimer = null;
    setConnection(false, "การเชื่อมต่อ extension หยุดทำงานระหว่างตรวจสถานะ");
  }
}

async function launchGemini() {
  activeRequestId = crypto.randomUUID();
  pollStartedAt = Date.now();
  elements.launchButton.disabled = true;
  elements.requestValue.textContent = activeRequestId;
  elements.stageValue.textContent = "REQUESTING_EXTENSION";
  elements.originValue.textContent = "—";
  elements.documentValue.textContent = "—";

  try {
    const response = await sendToExtension({
      type: "OPEN_GEMINI",
      version: PROTOCOL_VERSION,
      requestId: activeRequestId
    });
    if (!response?.ok) {
      throw new Error(response?.error || "OPEN_FAILED");
    }
    renderRun(response.run);
    clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, POLL_INTERVAL_MS);
    await pollStatus();
  } catch (error) {
    elements.stageValue.textContent = error instanceof Error ? error.message : "OPEN_FAILED";
  } finally {
    elements.launchButton.disabled = false;
  }
}

elements.launchButton.addEventListener("click", launchGemini);
elements.retryButton.addEventListener("click", checkExtension);
checkExtension();

