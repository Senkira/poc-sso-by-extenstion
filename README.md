# poc-sso-gemini-login-by-extension

Lean proof of concept สำหรับให้หน้าเว็บ Firebase Hosting จริงสั่ง Google Chrome หรือ Microsoft Edge extension ที่ติดตั้งครั้งเดียวทำ login automation ไปยัง Gemini โดยรหัสผ่านไม่ผ่านเว็บและไม่ถูกเก็บใน extension storage

Chrome และ Edge ใช้ **extension package เดียวกัน** ไม่ต้องแยก source หรือ build เพราะ POC ใช้เฉพาะ Chromium Manifest V3 APIs ที่รองรับร่วมกัน

## Runtime architecture

```text
https://poc-after-sso-login-gemini.web.app/
  -> chrome.runtime.sendMessage(fixed extension ID)
  -> MV3 service worker validates the exact hosted origin
  -> service worker opens Google AccountChooser in a normal window
  -> extension selects the fixed target account/email
  -> only when Google's password form exists, extension opens its one-run pass-through page
  -> user submits once; the service worker immediately forwards it to the exact Google tab/document
  -> service worker injects it directly into that exact tracked Google tab/document
  -> the extension page clears the field before awaiting the result; no password is written to storage
  -> hosted page polls truthful lifecycle status
```

ไม่มี local server, Node.js, PowerShell, custom protocol หรือ Native Messaging ใน runtime flow เครื่องผู้ใช้ต้องมีเพียง Google Chrome หรือ Microsoft Edge และ extension ที่ติดตั้งครั้งเดียว

## What the POC proves

- หน้า launcher มาจาก Firebase Hosting URL จริง
- หน้าเว็บติดต่อ extension package/ID ที่กำหนดไว้จริง
- extension เป็นผู้สร้าง Chrome/Edge window, เลือกบัญชีเป้าหมาย และส่งผ่านรหัสผ่านเฉพาะเมื่อพบ Google password form ใน exact tracked tab
- hosted Firebase page ไม่รับ อ่าน หรือส่งรหัสผ่าน
- service worker ไม่เขียนรหัสผ่านลง `chrome.storage`, run telemetry, log, source, package หรือ Git
- หาก service worker/Port ถูกตัดก่อนส่งผ่าน หน้า credential จะล้างค่าและ run จะ fail closed
- extension ผูก navigation/document observations กับ request และ tab ที่สร้าง
- หาก Google ขอ MFA, CAPTCHA หรือ device confirmation จะรายงาน `USER_ACTION_REQUIRED` และหยุด automation

นี่คือ **browser login automation POC ไม่ใช่ OAuth/enterprise SSO** และไม่ควรใช้เป็น production credential vault. POC ยังไม่อ้าง trusted attestation ของ Google identity หรือ Gemini entitlement; final browser acceptance ต้องตรวจ account ที่แสดงบน Gemini ด้วย

## Install once in Chrome or Edge

1. ดาวน์โหลด ZIP จาก <https://poc-after-sso-login-gemini.web.app/downloads/gemini-sso-launcher-extension-v0.3.0.zip> และแตกไฟล์
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
node .\tests\login.test.js
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
3. กด **เริ่ม login ผ่าน extension** และยืนยันว่า Google AccountChooser เปิดใน normal window
4. extension ต้องเลือก `codeassist.04@easybuy.co.th` เอง และเปิดหน้า credential origin `chrome-extension://...` เฉพาะเมื่อ Google password form พร้อม
5. กรอกรหัสผ่านในหน้า extension และกดส่งครั้งเดียว; ช่องต้องถูกล้างก่อนรอผลและไม่มีค่าใน `chrome.storage`
6. หน้า hosted ต้องแสดงลำดับอย่างน้อย `GOOGLE_ACCOUNTS_*` -> `OPENING_PASSWORD_PASS_THROUGH` -> `PASSWORD_PASS_THROUGH_READY` -> `PASSWORD_SUBMITTED`
7. หากมี MFA/CAPTCHA ต้องเป็น `USER_ACTION_REQUIRED`; หากไม่มีและถึง Gemini ต้องเป็น `GEMINI_DOCUMENT_OBSERVED`
8. ตรวจหน้า Gemini ด้วยสายตาว่าเป็นบัญชีเป้าหมาย เพราะ telemetry เพียงอย่างเดียวไม่ยืนยัน identity
9. ปิด exact tracked tab/window แล้ว status ต้องเป็น `TAB_CLOSED`
10. หาก reload/update extension ระหว่าง run หน้าเว็บต้องรายงาน `RUN_NOT_FOUND` และ origin/document ต้องเป็น `Unavailable`

## Browser evidence status

หลักฐานของ `0.1.0`/`0.2.0` เป็น launcher-only historical evidence และไม่นับเป็น acceptance ของ flow นี้ รุ่น `0.3.0` จะถือว่าผ่านเมื่อทดสอบ hosted URL + installed archive จริงครบตามรายการด้านบนทั้ง Chrome และ Edge ที่เป็น target
