# Gemini Extension Agent POC

POC นี้อยู่ใน repository แยก `poc-sso-gemini-login-by-extension` และไม่แก้ไฟล์ใน `sso-gemini-login-poc` โค้ด Agent เดิมที่จำเป็นถูกคัดลอกมาไว้ใน `reference-agent/` เพื่ออ้างอิงเท่านั้น ไม่ได้ถูกโหลดใน runtime

Production URL: <https://poc-after-sso-login-gemini.web.app/>

## Flow ที่พิสูจน์

1. หน้า POC แสดง Employee ID `O1234567` ไว้แล้ว ผู้ใช้กด Login ครั้งเดียวโดยไม่มีช่องรหัสผ่าน
2. หน้าเว็บส่งคำขอยืนยัน POC ไปยัง Extension ที่มี ID คงที่
3. Extension เรียก one-shot Native Messaging host; host ตรวจ caller origin/schema, อ่าน `ESB.GeminiBroker.Poc.O1234567`, ยืนยัน Firebase และ pin immutable Firebase UID
4. Native host คืนเฉพาะ Firebase ID token ให้ Extension แล้ว Extension ส่งต่อให้หน้าเว็บ รหัส POC ไม่ออกจาก native process และไม่ผ่าน Extension/DOM/page JavaScript
5. หน้าเว็บส่ง Firebase ID token และ request ID กลับไปยัง Extension; Extension ตรวจ token กับ Firebase ก่อนเปิด InPrivate window แบบ minimized
6. Extension ตรวจว่าไม่มี InPrivate/Incognito window เดิม เปิด `about:blank` แบบ minimized, persist tab mapping แล้วจึง navigate ไป Google
7. Extension กรอกเฉพาะ target Google account และ bind ทุก script กับ exact `documentId`; เมื่อ Google แสดง password step ที่มี selected-account control เดียวจึงเรียก Native Host อีก process
8. Native host ยืนยัน POC/Firebase ซ้ำก่อนอ่าน `ESB.GeminiBroker.CodeAssist04` ส่งกลับหนึ่งครั้งและจบ process
9. Extension ใช้ atomic `NOT_REQUESTED → REQUESTING → CONSUMED`, ส่ง credential เข้า exact password document, ล้าง reference และไม่ retry credential read
10. หน้าต่าง Gemini ถูกแสดงเมื่อ service worker revalidate exact current document และ active-account control เดียวเป็น `codeassist.04@easybuy.co.th`

ถ้า Google ขอ MFA, CAPTCHA, passkey, device approval หรือหน้า password ไม่ผูกกับ target account ระบบปิด InPrivate window และรายงาน failure ไม่พยายาม bypass challenge

หลังส่ง password ระบบตั้ง MV3 alarm หนึ่งนาที หาก Google ไม่ไปถึง Gemini และยืนยันบัญชีเป้าหมายภายในเวลา ระบบปิด hidden window ด้วย `AUTH_TIMEOUT` แทนการค้างเงียบ

## Install once

Runtime บนเครื่องปลายทางใช้ Edge/Chrome, Extension, PowerShell/.NET ที่มากับ Windows และ Windows Credential Manager ไม่ต้องติดตั้ง Node.js

1. ดาวน์โหลด `gemini-extension-agent-poc-v0.10.0.zip` จากหน้า Production แล้วแตกไฟล์
2. เปิด `edge://extensions` หรือ `chrome://extensions`
3. เปิด Developer mode แล้ว Load unpacked จากโฟลเดอร์ `extension`
4. เปิด Details ของ Extension และเปิด Allow in InPrivate/Incognito หนึ่งครั้ง
5. รัน `powershell -ExecutionPolicy Bypass -File .\bootstrap\Install.ps1`
6. กลับหน้า Production และตรวจว่าแสดง `Connected`

Installer จะ compile host ขนาดเล็กด้วย Windows PowerShell `Add-Type`, ลงไว้ใน `%LOCALAPPDATA%\GeminiExtensionAgentPoc` และ register Native Messaging เฉพาะ HKCU สำหรับ Edge และ Chrome ตัว host จะไม่ทำงานค้างและไม่เปิด port

Credential targets `ESB.GeminiBroker.Poc.O1234567` และ `ESB.GeminiBroker.CodeAssist04` ต้องถูก provision ใน Windows Credential Manager ของ Windows user ที่รัน browser อยู่ก่อน Installer การ deploy จริงสามารถ provision ผ่านเครื่องมือจัดการ endpoint เพื่อไม่ให้ผู้ใช้เห็นหรือกรอกรหัส Installer จงใจไม่รับหรือเก็บ password ใน package, command line, source หรือ web storage

## Security boundary

- Firebase Hosting เป็น static hosting เท่านั้น ไม่มี Functions, Cloud Run หรือ minimum replica
- Firebase API key ใน client เป็น public project configuration; Extension ยืนยัน ID token กับ Firebase ก่อนเริ่ม Agent
- POC/Firebase และ Google credentials อยู่ใน Windows Credential Manager คนละ target; POC password ไม่ออกจาก native process ส่วน Google password ปรากฏชั่วคราวใน native-host/Extension memory เฉพาะ exact-document submission
- หน้า Production และ Extension ไม่มี POC password; หน้า Production ไม่มี password field/Firebase password-auth request และได้รับเฉพาะ Firebase ID token
- Extension ไม่มี `cookies` หรือ `debugger` permission และไม่ copy Google cookies/session
- Extension ใช้ `chrome.storage.session` เฉพาะ non-secret run/tab metadata เพื่อให้ MV3 service worker restart แล้วทำงานต่อได้ โดยไม่เก็บ Firebase token หรือ Google credential
- External messages รับเฉพาะ production Firebase origin และ main frame
- InPrivate session ถูกใช้เพื่อไม่ reuse Google cookies จาก normal profile
- ถ้ามี InPrivate/Incognito window เดิม ระบบไม่เริ่ม run เพื่อไม่ reuse isolated cookie store
- Native Host ตรวจ exact extension origin, protocol/schema และ Firebase UID ก่อนอ่าน Google credential อย่างไรก็ตาม same-Windows-user arbitrary code ยังอยู่นอก assurance boundary เพราะ process เดียวกันสามารถเรียก Windows Credential API ได้โดยตรง

รายละเอียด threat boundary และข้อจำกัดอยู่ใน [ARCHITECTURE-DECISION.md](./ARCHITECTURE-DECISION.md)

## Verify

คำสั่งเหล่านี้ใช้ในเครื่องพัฒนาเท่านั้น Node.js ไม่อยู่ใน package หรือ runtime ของผู้ใช้

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
node .\tests\static.test.js
node .\tests\service-worker.test.js
node .\tests\content-script.test.js
node .\tests\page-guards.test.js
node .\tests\app.test.js
powershell -ExecutionPolicy Bypass -File .\tests\native-host.test.ps1
```

## Deploy

```powershell
npx --yes firebase-tools deploy --only auth,hosting --project poc-after-sso-login-gemini
```

`firebase.json` มี Email/Password provider และ static Hosting เท่านั้น จึงไม่มี replica setting ที่ต้องเปิดค้างหรือ idle compute charge

## Production E2E acceptance

1. ปิด InPrivate/Incognito windows ทั้งหมดเพื่อล้าง isolated Google session
2. logout POC แล้วกด Login ใหม่หนึ่งครั้ง (`O1234567` ถูกแสดงไว้แล้ว)
3. หลังคลิก Login ระบบต้องเริ่ม Gemini อัตโนมัติ และห้ามพิมพ์หรือคลิกใน Google login UI
4. Runtime evidence ต้องแสดง credential delivered once และ `GEMINI_TARGET_ACCOUNT_CONFIRMED`
5. Gemini account control ต้องยืนยัน target account จริง
6. ถ้ามี interactive Google challenge ต้องเป็น fail-closed ไม่ถือว่าผ่าน
