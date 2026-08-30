"use strict";

const EXTENSION_ID = "jeenmgigpkffleijbmfciffiodlcdafh";
const REQUIRED_EXTENSION_VERSION = "0.4.3";
const PROTOCOL_VERSION = 3;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;
const TERMINAL_STAGES = new Set([
  "GEMINI_TARGET_ACCOUNT_CONFIRMED",
  "GEMINI_TARGET_ACCOUNT_NOT_CONFIRMED",
  "USER_ACTION_REQUIRED",
  "AUTH_TIMEOUT",
  "TARGET_ACCOUNT_NOT_CONFIRMED",
  "GOOGLE_PAGE_UNRECOGNIZED",
  "AUTOMATION_ERROR",
  "NAVIGATION_ERROR",
  "OPEN_FAILED",
  "TAB_CLOSED"
]);

const elements = {
  connectionBadge: document.querySelector("#connection-badge"),
  connectionDetail: document.querySelector("#connection-detail"),
  launchButton: document.querySelector("#launch-button"),
  retryButton: document.querySelector("#retry-button"),
  requestValue: document.querySelector("#request-value"),
  stageValue: document.querySelector("#stage-value"),
  originValue: document.querySelector("#origin-value"),
  documentValue: document.querySelector("#document-value"),
  accountValue: document.querySelector("#account-value"),
  noteValue: document.querySelector("#note-value"),
  extensionId: document.querySelector("#extension-id")
};

let activeRun = null;
let generation = 0;

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
  elements.requestValue.textContent = run.requestId;
  elements.stageValue.textContent = run.stage;
  elements.originValue.textContent = run.observedOrigin || "—";
  elements.documentValue.textContent = run.documentObserved ? "Observed" : "Not observed";
  elements.accountValue.textContent = run.targetAccountConfirmed
    ? "Confirmed"
    : run.identityCheckComplete
      ? "Not confirmed"
      : "Pending";
  elements.noteValue.textContent = run.note || "—";
}

function renderUnavailable(stage) {
  elements.stageValue.textContent = stage;
  elements.originValue.textContent = "Unavailable";
  elements.documentValue.textContent = "Unavailable";
  elements.accountValue.textContent = "Unavailable";
  elements.noteValue.textContent = "—";
}

async function checkExtension() {
  elements.connectionBadge.textContent = "Checking";
  elements.connectionBadge.className = "badge pending";
  elements.launchButton.disabled = true;
  try {
    const response = await sendToExtension({ type: "PING", version: PROTOCOL_VERSION });
    if (!response?.ok) {
      throw new Error("PROTOCOL_MISMATCH");
    }
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      setConnection(
        false,
        `พบ Gemini extension v${response.version || "unknown"} ที่ใช้ protocol เก่า; กรุณา Reload extension เพื่อใช้ v${REQUIRED_EXTENSION_VERSION}`
      );
      return;
    }
    if (response.version !== REQUIRED_EXTENSION_VERSION) {
      setConnection(
        false,
        `พบ Gemini extension v${response.version || "unknown"} แต่เว็บต้องใช้ v${REQUIRED_EXTENSION_VERSION}; กรุณา Reload extension`
      );
      return;
    }
    if (response.capability !== "SECRETLESS_GOOGLE_SESSION_LAUNCHER") {
      setConnection(false, "Extension ที่พบไม่ใช่ secretless launcher รุ่นที่กำหนด");
      return;
    }
    setConnection(true, `เชื่อมต่อ Gemini Secretless Launcher v${response.version} แล้ว`);
  } catch {
    setConnection(false, "ไม่พบ extension ที่ติดตั้งและอนุญาตสำหรับเว็บนี้");
  }
}

function isActive(run) {
  return activeRun === run;
}

function stopPolling(run) {
  if (run && run.timerId !== null) {
    clearTimeout(run.timerId);
    run.timerId = null;
  }
}

function schedulePoll(run) {
  if (!isActive(run) || run.timerId !== null) {
    return;
  }
  run.timerId = setTimeout(() => {
    run.timerId = null;
    void pollStatus(run);
  }, POLL_INTERVAL_MS);
}

async function pollStatus(run) {
  if (!run || !isActive(run) || run.pollInFlight) {
    return;
  }
  if (Date.now() - run.startedAt > POLL_TIMEOUT_MS) {
    stopPolling(run);
    renderUnavailable("STATUS_TIMEOUT");
    return;
  }

  run.pollInFlight = true;
  try {
    const response = await sendToExtension({
      type: "GET_STATUS",
      version: PROTOCOL_VERSION,
      requestId: run.requestId
    });
    if (!isActive(run)) {
      return;
    }
    if (!response?.ok || response.run?.requestId !== run.requestId) {
      stopPolling(run);
      renderUnavailable(response?.error || "STATUS_UNAVAILABLE");
      return;
    }

    const updatedAt = Number(response.run.updatedAt) || 0;
    if (updatedAt >= run.lastRenderedUpdatedAt) {
      run.lastRenderedUpdatedAt = updatedAt;
      renderRun(response.run);
    }
    if (response.run.closed || TERMINAL_STAGES.has(response.run.stage)) {
      stopPolling(run);
      return;
    }
  } catch {
    if (!isActive(run)) {
      return;
    }
    stopPolling(run);
    renderUnavailable("CHANNEL_UNAVAILABLE");
    setConnection(false, "การเชื่อมต่อ extension หยุดทำงานระหว่างตรวจสถานะ");
    return;
  } finally {
    run.pollInFlight = false;
  }
  schedulePoll(run);
}

async function launchGemini() {
  stopPolling(activeRun);
  const run = {
    requestId: crypto.randomUUID(),
    generation: ++generation,
    timerId: null,
    startedAt: Date.now(),
    pollInFlight: false,
    lastRenderedUpdatedAt: 0
  };
  activeRun = run;
  elements.launchButton.disabled = true;
  elements.requestValue.textContent = run.requestId;
  elements.stageValue.textContent = "REQUESTING_EXTENSION";
  elements.originValue.textContent = "—";
  elements.documentValue.textContent = "—";
  elements.accountValue.textContent = "Pending";
  elements.noteValue.textContent = "—";

  try {
    const response = await sendToExtension({
      type: "OPEN_GEMINI",
      version: PROTOCOL_VERSION,
      requestId: run.requestId
    });
    if (!isActive(run)) {
      return;
    }
    if (!response?.ok || response.run?.requestId !== run.requestId) {
      renderUnavailable(response?.error || "OPEN_FAILED");
      return;
    }
    run.lastRenderedUpdatedAt = Number(response.run.updatedAt) || 0;
    renderRun(response.run);
    schedulePoll(run);
  } catch {
    if (isActive(run)) {
      renderUnavailable("CHANNEL_UNAVAILABLE");
      setConnection(false, "ส่งคำสั่งเข้า extension ไม่สำเร็จ");
    }
  } finally {
    if (isActive(run)) {
      elements.launchButton.disabled = false;
    }
  }
}

elements.launchButton.addEventListener("click", launchGemini);
elements.retryButton.addEventListener("click", checkExtension);
void checkExtension();
