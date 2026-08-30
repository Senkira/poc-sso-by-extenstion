"use strict";

const PROTOCOL_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const form = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const submitButton = document.querySelector("#submit-button");
const status = document.querySelector("#status");
const params = new URL(location.href).searchParams;
const requestId = params.get("requestId");
const challengeId = params.get("challengeId");

function clearPassword() {
  passwordInput.value = "";
}

if (!UUID_PATTERN.test(requestId || "") || !UUID_PATTERN.test(challengeId || "")) {
  form.hidden = true;
  status.textContent = "คำขอไม่ถูกต้อง กรุณาเริ่มใหม่จากเว็บไซต์ POC";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!UUID_PATTERN.test(requestId || "") || !UUID_PATTERN.test(challengeId || "")) {
    return;
  }
  const password = passwordInput.value;
  clearPassword();
  if (!password) {
    return;
  }

  submitButton.disabled = true;
  status.textContent = "กำลังส่งผ่านไปยัง Google tab ที่ตรวจไว้…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "PASS_PASSWORD",
      version: PROTOCOL_VERSION,
      requestId,
      challengeId,
      password
    });
    clearPassword();
    if (!response?.ok) {
      throw new Error(response?.error || "PASS_THROUGH_FAILED");
    }
    status.textContent = "ส่งผ่านและล้างรหัสผ่านแล้ว หน้าต่างนี้ปิดได้";
  } catch {
    clearPassword();
    submitButton.disabled = false;
    status.textContent = "ส่งผ่านไม่สำเร็จและล้างรหัสผ่านแล้ว กรุณาปิดหน้าต่างนี้แล้วเริ่มใหม่";
    passwordInput.focus();
  }
});

window.addEventListener("pagehide", clearPassword, { once: true });
