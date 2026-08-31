# Gemini Extension Agent POC

POC นี้อยู่ใน repository แยก `poc-sso-gemini-login-by-extension` และไม่แก้ไฟล์ใน `sso-gemini-login-poc` โค้ด Agent เดิมที่จำเป็นถูกคัดลอกมาไว้ใน `reference-agent/` เพื่ออ้างอิงเท่านั้น ไม่ได้ถูกโหลดใน runtime

Production URL: <https://poc-after-sso-login-gemini.web.app/>

## Flow ที่พิสูจน์

1. ผู้ใช้ login หน้า POC ด้วยบัญชี `O1234567`
2. Firebase Authentication ตรวจ username/password จริงผ่าน HTTPS หน้าเว็บไม่ได้เทียบ hash ภายใน JavaScript
3. หน้าเว็บส่ง Firebase ID token และ request ID ไปยัง Extension ที่มี ID คงที่
4. Extension ตรวจ ID token กับ Firebase ก่อนเปิด InPrivate window แบบ minimized
5. Extension กรอกเฉพาะ target Google account แล้วเรียก Native Messaging host เมื่อ Google แสดง password step
6. Native host อ่าน `ESB.GeminiBroker.CodeAssist04` จาก Windows Credential Manager ส่งกลับหนึ่งครั้งและจบ process
7. Extension ส่ง credential เข้า password document ที่ผูกกับ target account เดียว ล้าง reference จาก memory และไม่เขียนลง extension storage
8. หน้าต่าง Gemini ถูกแสดงต่อผู้ใช้เมื่อ content script ยืนยันบัญชี `codeassist.04@easybuy.co.th` จาก rendered account control เท่านั้น
9. ปุ่ม Post ส่ง prompt ได้หลังผ่าน account-confirmation gate

ถ้า Google ขอ MFA, CAPTCHA, passkey, device approval หรือหน้า password ไม่ผูกกับ target account ระบบปิด InPrivate window และรายงาน failure ไม่พยายาม bypass challenge

หลังส่ง password ระบบตั้ง MV3 alarm หนึ่งนาที หาก Google ไม่ไปถึง Gemini และยืนยันบัญชีเป้าหมายภายในเวลา ระบบปิด hidden window ด้วย `AUTH_TIMEOUT` แทนการค้างเงียบ

## Install once

Runtime บนเครื่องปลายทางใช้ Edge/Chrome, Extension, PowerShell/.NET ที่มากับ Windows และ Windows Credential Manager ไม่ต้องติดตั้ง Node.js

1. ดาวน์โหลด `gemini-extension-agent-poc-v0.7.0.zip` จากหน้า Production แล้วแตกไฟล์
2. เปิด `edge://extensions` หรือ `chrome://extensions`
3. เปิด Developer mode แล้ว Load unpacked จากโฟลเดอร์ `extension`
4. เปิด Details ของ Extension และเปิด Allow in InPrivate/Incognito หนึ่งครั้ง
5. รัน `powershell -ExecutionPolicy Bypass -File .\bootstrap\Install.ps1`
6. กลับหน้า Production และตรวจว่าแสดง `Connected`

Installer จะ compile host ขนาดเล็กด้วย Windows PowerShell `Add-Type`, ลงไว้ใน `%LOCALAPPDATA%\GeminiExtensionAgentPoc` และ register Native Messaging เฉพาะ HKCU สำหรับ Edge และ Chrome ตัว host จะไม่ทำงานค้างและไม่เปิด port

Credential target ต้องถูก provision ใน Windows Credential Manager ของ Windows user ที่รัน browser อยู่ก่อน Installer จงใจไม่รับหรือเก็บ Google password ใน package, command line, source หรือ web storage

## Security boundary

- Firebase Hosting เป็น static hosting เท่านั้น ไม่มี Functions, Cloud Run หรือ minimum replica
- Firebase API key ใน client เป็น public project configuration; Extension ยืนยัน ID token กับ Firebase ก่อนเริ่ม Agent
- POC Google credential อยู่ใน Windows Credential Manager และปรากฏชั่วคราวเฉพาะ native-host/extension memory ระหว่าง password submission
- Extension ไม่มี `cookies` หรือ `debugger` permission และไม่ copy Google cookies/session
- Extension ใช้ `chrome.storage.session` เฉพาะ non-secret run/tab metadata เพื่อให้ MV3 service worker restart แล้วทำงานต่อได้ โดยไม่เก็บ Firebase token หรือ Google credential
- External messages รับเฉพาะ production Firebase origin และ main frame
- InPrivate session ถูกใช้เพื่อไม่ reuse Google cookies จาก normal profile

รายละเอียด threat boundary และข้อจำกัดอยู่ใน [ARCHITECTURE-DECISION.md](./ARCHITECTURE-DECISION.md)

## Verify

คำสั่งเหล่านี้ใช้ในเครื่องพัฒนาเท่านั้น Node.js ไม่อยู่ใน package หรือ runtime ของผู้ใช้

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
node .\tests\static.test.js
node .\tests\service-worker.test.js
node .\tests\content-script.test.js
node .\tests\app.test.js
```

## Deploy

```powershell
npx --yes firebase-tools deploy --only auth,hosting --project poc-after-sso-login-gemini
```

`firebase.json` มี Email/Password provider และ static Hosting เท่านั้น จึงไม่มี replica setting ที่ต้องเปิดค้างหรือ idle compute charge

## Production E2E acceptance

1. ปิด InPrivate/Incognito windows ทั้งหมดเพื่อล้าง isolated Google session
2. logout POC แล้ว login ใหม่
3. กดเปิด Gemini ครั้งเดียวและห้ามพิมพ์หรือคลิกใน Google login UI
4. Runtime evidence ต้องแสดง credential delivered once และ `GEMINI_TARGET_ACCOUNT_CONFIRMED`
5. Gemini account control ต้องยืนยัน target account จริง
6. Post prompt แล้วตรวจว่า Gemini รับข้อความ
7. ถ้ามี interactive Google challenge ต้องเป็น fail-closed ไม่ถือว่าผ่าน
