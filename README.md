# poc-sso-gemini-login-by-extension

Lean proof of concept สำหรับเปิด Gemini จากหน้าเว็บ Firebase Hosting จริงผ่าน Microsoft Edge extension ที่ติดตั้งครั้งเดียว

## Runtime architecture

```text
https://poc-after-sso-login-gemini.web.app/
  -> chrome.runtime.sendMessage(fixed extension ID)
  -> MV3 service worker validates the exact hosted origin
  -> chrome.windows.create(https://gemini.google.com/app)
  -> extension observes only the tab/window it created
  -> hosted page polls truthful lifecycle status
```

ไม่มี local server, Node.js, PowerShell, custom protocol หรือ Native Messaging ใน runtime flow เครื่องผู้ใช้ต้องมีเพียง Microsoft Edge และ extension ที่ติดตั้งครั้งเดียว

## What the POC proves

- หน้า launcher มาจาก Firebase Hosting URL จริง
- หน้าเว็บติดต่อ extension package/ID ที่กำหนดไว้จริง
- extension เป็นผู้สร้าง Edge window/tab ที่เปิด Gemini จริง
- extension ผูก navigation/document observations กับ request และ tab ที่สร้าง
- หาก Gemini redirect ไป Google sign-in จะรายงานว่า sign-in page ถูกเปิด ไม่ปลอมเป็น success

POC **ไม่อ้าง** ว่าพิสูจน์ Google identity, Gemini entitlement หรือ exact signed-in account เพราะ browser extension API ไม่มี trusted identity proof สำหรับ Gemini session

## Install once in Edge

1. เปิด `edge://extensions`
2. เปิด Developer mode
3. เลือก **Load unpacked**
4. เลือกโฟลเดอร์ `extension`
5. ตรวจว่า Extension ID คือ `jeenmgigpkffleijbmfciffiodlcdafh`

หลังติดตั้งแล้วให้ใช้งานจาก <https://poc-after-sso-login-gemini.web.app/> เท่านั้น Origin อื่นไม่สามารถส่งคำสั่งเข้า extension ได้

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

สคริปต์นี้ใช้เฉพาะตอนพัฒนา ไม่อยู่ใน runtime flow ของผู้ใช้

## Deploy

Firebase project/site ถูกกำหนดตายตัวเป็น `poc-after-sso-login-gemini` และใช้ static Hosting เท่านั้น ไม่มี Functions หรือ Cloud Run ดังนั้นไม่มี minimum replica หรือ idle compute ให้คิดค่าใช้จ่าย

```powershell
npx --yes firebase-tools deploy --only hosting --project poc-after-sso-login-gemini
```

## Manual acceptance test

1. เปิด hosted URL ใน Edge profile ที่ติดตั้ง extension
2. สถานะต้องเปลี่ยนเป็น `Connected`
3. กด **เปิด Gemini** และยืนยันว่าเกิด Edge window ใหม่
4. หน้า hosted ต้องแสดง request UUID และ `WINDOW_CREATED`
5. ถ้าต้อง login หน้า status ต้องรายงาน `GOOGLE_SIGN_IN_REQUIRED`/`GOOGLE_SIGN_IN_PAGE_LOADED`
6. หลังถึง Gemini ต้องรายงาน `GEMINI_DOCUMENT_OBSERVED`
7. ปิด window แล้ว status ต้องเป็น `WINDOW_CLOSED`

