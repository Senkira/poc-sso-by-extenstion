# poc-sso-gemini-login-by-extension

Lean proof of concept สำหรับเริ่ม Google account selection แล้วเข้า Gemini จากหน้าเว็บ Firebase Hosting จริงผ่าน Google Chrome หรือ Microsoft Edge extension ที่ติดตั้งครั้งเดียว

Chrome และ Edge ใช้ **extension package เดียวกัน** ไม่ต้องแยก source หรือ build เพราะ POC ใช้เฉพาะ Chromium Manifest V3 APIs ที่รองรับร่วมกัน

## Runtime architecture

```text
https://poc-after-sso-login-gemini.web.app/
  -> chrome.runtime.sendMessage(fixed extension ID)
  -> MV3 service worker validates the exact hosted origin
  -> chrome.windows.create(Google AccountChooser -> Gemini)
  -> extension observes only the tab/window it created
  -> hosted page polls truthful lifecycle status
```

ไม่มี local server, Node.js, PowerShell, custom protocol หรือ Native Messaging ใน runtime flow เครื่องผู้ใช้ต้องมีเพียง Google Chrome หรือ Microsoft Edge และ extension ที่ติดตั้งครั้งเดียว

## What the POC proves

- หน้า launcher มาจาก Firebase Hosting URL จริง
- หน้าเว็บติดต่อ extension package/ID ที่กำหนดไว้จริง
- extension เป็นผู้สร้าง Chrome/Edge window และ tab ที่เริ่มจาก Google Account Chooser แล้ว redirect เข้า Gemini หลังผู้ใช้ยืนยันตัวตน
- extension ผูก navigation/document observations กับ request และ tab ที่สร้าง
- หาก Gemini redirect ไป Google sign-in จะรายงานว่า sign-in page ถูกเปิด ไม่ปลอมเป็น success

POC **ไม่อ้าง** ว่าพิสูจน์ Google identity, Gemini entitlement หรือ exact signed-in account เพราะ browser extension API ไม่มี trusted identity proof สำหรับ Gemini session

## Install once in Chrome or Edge

1. ดาวน์โหลด ZIP จาก <https://poc-after-sso-login-gemini.web.app/downloads/gemini-sso-launcher-extension-v0.2.0.zip> และแตกไฟล์
2. Chrome เปิด `chrome://extensions` หรือ Edge เปิด `edge://extensions`
3. เปิด Developer mode
4. เลือก **Load unpacked** แล้วเลือกโฟลเดอร์ที่แตกไฟล์
5. ตรวจว่า Extension ID คือ `jeenmgigpkffleijbmfciffiodlcdafh`

หลังติดตั้งแล้วให้ใช้งานจาก <https://poc-after-sso-login-gemini.web.app/> เท่านั้น Origin อื่นไม่สามารถส่งคำสั่งเข้า extension ได้

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
node .\tests\service-worker.test.js
node .\tests\content-script.test.js
node .\tests\app.test.js
```

สคริปต์เหล่านี้ใช้เฉพาะตอนพัฒนา ไม่อยู่ใน runtime flow ของผู้ใช้

สร้าง ZIP ใหม่หลังแก้ source ของ extension ด้วย:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

## Deploy

Firebase project/site ถูกกำหนดตายตัวเป็น `poc-after-sso-login-gemini` และใช้ static Hosting เท่านั้น ไม่มี Functions หรือ Cloud Run ดังนั้นไม่มี minimum replica หรือ idle compute ให้คิดค่าใช้จ่าย

```powershell
npx --yes firebase-tools deploy --only hosting --project poc-after-sso-login-gemini
```

## Manual acceptance test

1. เปิด hosted URL ใน Chrome/Edge profile ที่ติดตั้ง extension
2. สถานะต้องเปลี่ยนเป็น `Connected`
3. กด **เข้าสู่ระบบ Gemini** และยืนยันว่าเกิด browser window ใหม่ที่ Google Account Chooser
4. หน้า hosted ต้องแสดง request UUID และ local lifecycle telemetry เช่น `WINDOW_CREATED`
5. ระหว่างเลือกบัญชีหรือลงชื่อเข้าใช้ หน้า status ต้องรายงาน `GOOGLE_ACCOUNTS_NAVIGATED`/`GOOGLE_ACCOUNTS_PAGE_LOADED`
6. หลังถึง Gemini ต้องรายงาน `GEMINI_DOCUMENT_OBSERVED`
7. ปิด tab/window แล้ว status ต้องเป็น `TAB_CLOSED`
8. หาก reload/update extension ระหว่าง run หน้าเว็บต้องรายงาน `RUN_NOT_FOUND` ไม่ค้างหรือแสดง success เก่า

## Verified browser evidence

ทดสอบกับ Google Chrome `151.0.7922.175` เมื่อ 2026-08-30 โดยใช้ hosted URL จริงและ extension `0.1.0`:

- หน้า hosted รายงาน `Connected`
- การกด **เปิด Gemini** สร้างหน้าต่างไปที่ `https://gemini.google.com/app`
- request `e80659e0-f0d6-47d6-b8f0-6311674130ad` จบที่ `GEMINI_DOCUMENT_OBSERVED`
- observed origin คือ `https://gemini.google.com` และ Gemini document เป็น `Observed`
