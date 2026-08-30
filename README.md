# poc-sso-gemini-login-by-extension

Lean online POC ที่ให้ Firebase Hosting สั่ง Chrome/Edge extension ซึ่งติดตั้งครั้งเดียวให้เปิด flow ไปยัง Gemini โดย extension ไม่อ่าน รับ เก็บ หรือ inject รหัสผ่าน

Chrome และ Edge ใช้ extension package เดียวกัน เพราะใช้ Chromium Manifest V3 APIs ชุดเดียวกัน

## Architecture ที่พิสูจน์ได้จริง

```text
Firebase static site
  -> fixed-ID MV3 extension
  -> Google AccountChooser
  -> extension เลือก codeassist.04@easybuy.co.th
  -> Google / browser password manager / Corporate IdP เป็นผู้ authenticate
  -> extension ไม่แตะค่า credential และสังเกต navigation เท่านั้น
  -> Gemini content script ตรวจ account controls ที่ render แล้ว
  -> hosted page แสดง lifecycle และ target-account evidence
```

ไม่มี local server, Node.js, PowerShell, custom protocol, Native Messaging, Functions หรือ Cloud Run ใน runtime ของเครื่องปลายทาง เครื่องปลายทางต้องมีเพียง Chrome หรือ Edge และ extension ที่ติดตั้งครั้งเดียว

## Credential boundary

Extension ทำได้:

- เปิด Google/Gemini ใน normal browser window
- เลือกบัญชีเป้าหมายหรือกรอกเฉพาะ email เป้าหมาย
- กด Google Next โดยไม่อ่านช่อง credential เพื่อให้ browser/IdP ดำเนินการ
- ผูก request, tab และ exact document สำหรับ non-secret automation
- รายงาน navigation, failure และ rendered target-account evidence

Extension ไม่ทำ:

- ไม่มีหน้า credential ของตัวเอง
- ไม่รับ credential ผ่าน message
- ไม่ query หรืออ่านช่อง credential
- ไม่เขียน secret ลง storage/status/log/source/package
- ไม่อ่านหรือสร้าง cookies
- ไม่แปลง OAuth token เป็น Gemini web session

ถ้า Google logout จริงและไม่มี saved browser credential, passkey หรือ IdP session อยู่เลย ระบบต้องรายงาน `USER_ACTION_REQUIRED` เพราะไม่มี authentication proof ให้ Google ใช้ นี่เป็น fail-closed behavior ไม่ใช่ success

## Live evidence ที่ตรวจแล้ว

บน Chrome profile ที่ใช้ตรวจ POC เมื่อวันที่ 2026-08-30 extension รุ่นก่อนเลือกบัญชีเป้าหมายสำเร็จ แต่ Google ไปที่หน้า `accounts.google.com/.../challenge/pwd` โดยตรง ไม่มี Corporate SSO redirect และไม่เดินต่อเอง หลักฐานนี้ทำให้ v0.4.0 เปลี่ยนเป็น secretless launcher และไม่อ้างว่า profile ดังกล่าวมี silent credential source

## Install once in Chrome or Edge

1. ดาวน์โหลด ZIP จาก <https://poc-after-sso-login-gemini.web.app/downloads/gemini-sso-launcher-extension-v0.4.0.zip> และแตกไฟล์
2. Chrome เปิด `chrome://extensions` หรือ Edge เปิด `edge://extensions`
3. เปิด Developer mode
4. เลือก **Load unpacked** แล้วเลือกโฟลเดอร์ที่แตกไฟล์
5. ตรวจว่า Extension ID คือ `jeenmgigpkffleijbmfciffiodlcdafh`

หลังติดตั้งแล้วให้ใช้งานจาก <https://poc-after-sso-login-gemini.web.app/> เท่านั้น Origin อื่นไม่สามารถส่งคำสั่งเข้า extension ได้

## One-time provisioning ที่ทำให้ zero-touch เป็นไปได้

เลือกอย่างใดอย่างหนึ่งนอก extension:

1. Google session ของบัญชีเป้าหมายยัง valid
2. Chrome/Edge password manager มี saved credential และ policy อนุญาต autofill/automatic sign-in โดยไม่ถาม device confirmation
3. Google Workspace federation redirect ไป Corporate IdP ซึ่งมี authenticated session อยู่แล้ว

ถ้าไม่มีทั้งสามอย่าง zero-touch login จากสถานะ logout ทำไม่ได้ภายใต้ข้อจำกัดนี้

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
node .\tests\service-worker.test.js
node .\tests\content-script.test.js
node .\tests\app.test.js
```

Node และ PowerShell ใช้เฉพาะ development verification ไม่ถูก package และไม่อยู่ใน runtime flow

สร้าง ZIP หลังแก้ source:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

## Deploy

Firebase site กำหนดเป็น `poc-after-sso-login-gemini` และมี static Hosting เพียงอย่างเดียว ไม่มี minimum replica หรือ idle compute

```powershell
npx --yes firebase-tools deploy --only hosting --project poc-after-sso-login-gemini
```

## Acceptance test

1. เตรียม Chrome/Edge profile ให้ Google logout แต่มี saved browser credential หรือ authenticated Corporate IdP session
2. ติดตั้ง extension v0.4.0 จาก hosted ZIP
3. เปิด production Firebase URL และต้องเห็น `Connected`
4. กดปุ่มหนึ่งครั้ง แล้วห้ามมี keyboard/mouse interaction หลังจากนั้น
5. Extension ต้องเลือกบัญชี `codeassist.04@easybuy.co.th` เอง
6. ห้ามมี extension-owned credential page และห้ามมี credential ใน extension messages/storage/logs
7. ถ้า silent credential source ทำงาน ต้องไปถึง `GEMINI_TARGET_ACCOUNT_CONFIRMED`
8. ถ้าไม่มี silent source, มี MFA/CAPTCHA/device confirmation หรือยืนยันบัญชีไม่ได้ ต้องจบด้วยสถานะ fail-closed ที่ตรงเหตุการณ์
9. รันแยก Chrome และ Edge เพราะ password-manager/policy behavior ต่างกัน

`GEMINI_DOCUMENT_OBSERVED` อย่างเดียวไม่ถือว่าผ่าน target-account acceptance
