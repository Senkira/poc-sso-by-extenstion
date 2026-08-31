# poc-sso-gemini-login-by-extension

Lean online POC ที่ให้ Firebase Hosting สั่ง Chrome/Edge extension ซึ่งติดตั้งครั้งเดียวให้เปิด Gemini ในหน้าต่าง InPrivate โดย extension ไม่อ่าน รับ เก็บ หรือ inject รหัสผ่าน

Chrome และ Edge ใช้ extension package เดียวกัน เพราะใช้ Chromium Manifest V3 APIs ชุดเดียวกัน

## Acceptance ที่ต้องพิสูจน์

```text
1. ผู้ใช้เข้า Firebase POC และกด Login
2. Extension เปิด isolated Edge/Chrome context
3. ระบบ authenticate Google account เป้าหมายโดยผู้ใช้ไม่เห็น/ไม่กรอก Google password
4. ผู้ใช้ส่ง prompt และใช้ Gemini ของบัญชีเป้าหมายได้
```

ผล v0.5.0 **ยังไม่ผ่าน acceptance ข้อ 3-4** จึงห้ามเรียกว่า zero-touch login สำเร็จ สิ่งที่พิสูจน์แล้วคือ Firebase Hosting ติดต่อ fixed-ID extension ได้จริง, extension เปิด InPrivate ได้จริง, เลือก/กรอก email เป้าหมายได้จริง และรายงาน failure แบบ fail-closed เมื่อ Google ขอ credential หรือ challenge

ข้อจำกัดที่ตั้งไว้คือไม่มี SSO, local server, Node.js, PowerShell, custom protocol, Native Messaging, Functions หรือ Cloud Run ใน runtime ของเครื่องปลายทาง และ extension ห้ามรับ/เก็บ/inject Google password ภายใต้ขอบเขตนี้ไม่มี credential authority ที่สามารถมอบหลักฐานยืนยันตัวตนให้ Google ได้ การกด Login บนเว็บ POC ไม่สามารถสร้าง Google session ได้เอง

Red-team เพิ่มพบ test-only loophole ผ่าน `chrome.debugger` + CDP virtual WebAuthn แต่ต้องเก็บ Google-registered private key และจำลอง user presence/verification จึงไม่ใช่ secretless หรือ supported production authentication Production extension นี้จงใจไม่ขอ `debugger` permission และ verifier ห้ามทั้ง virtual authenticator กับ reusable private key รายละเอียดอยู่ใน architecture decision

Isolation ใน POC นี้คือ **ephemeral InPrivate cookie/site-data store** ซึ่งถูกล้างเมื่อปิด InPrivate windows ทั้งหมด ไม่ใช่ persistent profile หรือ `--user-data-dir` เพราะ extension API ไม่มีความสามารถเลือกหรือสร้าง browser profile แบบนั้น

## Credential boundary

Extension ทำได้:

- เปิด Google/Gemini ใน InPrivate window
- เลือกบัญชีเป้าหมายหรือกรอกเฉพาะ email เป้าหมาย
- กด Google Next โดยไม่อ่านช่อง credential เพื่อให้ browser password manager ดำเนินการ
- ผูก request, tab และ exact document สำหรับ non-secret automation
- รายงาน navigation, failure และ rendered target-account evidence

Extension ไม่ทำ:

- ไม่มีหน้า credential ของตัวเอง
- ไม่รับ credential ผ่าน message
- ไม่ query หรืออ่านช่อง credential
- ไม่เขียน secret ลง storage/status/log/source/package
- ไม่อ่านหรือสร้าง cookies
- ไม่แปลง OAuth token เป็น Gemini web session

ถ้าไม่มี saved browser credential หรือ Edge/Google ขอ password-manager unlock, MFA, CAPTCHA หรือ device confirmation ระบบต้องรายงาน `USER_ACTION_REQUIRED` เพราะ extension ไม่มีสิทธิ์อ่านข้อความหรือแก้ challenge เหล่านั้น นี่เป็น fail-closed behavior ไม่ใช่ success

## Live evidence ที่ตรวจแล้ว

บน Chrome และ Edge profiles ที่ใช้ตรวจ v0.4.8 เมื่อวันที่ 2026-08-30 extension เลือกบัญชีเป้าหมายสำเร็จ แต่ Google ไปที่หน้า `accounts.google.com/.../challenge/pwd` และไม่เดินต่อเอง ทั้งสอง browser จึงยังไม่มี usable saved credential ในรอบทดสอบนั้น

ตรวจสมมติฐานเรื่อง autofill race เพิ่มแล้วโดยปล่อย password challenge ค้าง 8 วินาที กด Google Next ซ้ำจาก browser UI โดยไม่อ่านค่า credential และลองกระตุ้น Chrome control `Verify it's you` ก่อนกดซ้ำ ผลยังอยู่ document และ URL เดิม จึงไม่ใช่ปัญหาที่แก้ได้ด้วยการเพิ่ม delay ใน extension นอกจากนี้การ focus ช่อง password ไม่แสดง browser-managed credential suggestion สำหรับบัญชีเป้าหมาย

v0.5.0 เปลี่ยน launch context เป็น InPrivate เพื่อทดสอบ no-SSO architecture ที่ไม่ reuse Google cookies เดิม แต่ยังให้ Edge/Chrome Password Manager ใช้ saved credential จาก parent profile ได้ การมี saved credential เป็น prerequisite เท่านั้น ต้องผ่าน live E2E จึงจะเรียกว่า zero-touch success ได้

Live E2E บน Edge เมื่อวันที่ 2026-08-31 ยืนยันว่า production Firebase เชื่อมต่อ extension v0.5.0 ผ่าน protocol 4, สร้าง InPrivate และส่งบัญชีเป้าหมายจนถึง `EMAIL_SUBMITTED` ที่ `accounts.google.com` ได้จริง แต่จบที่ `USER_ACTION_REQUIRED` เพราะ profile ที่ทดสอบยังไม่มี browser-managed credential หรือ silent authentication ที่ใช้ได้ ไม่พบ Gemini document และ target account ยังเป็น `Pending` ดังนั้นผลรอบนี้พิสูจน์ launch/orchestration และ fail-closed เท่านั้น ยังไม่พิสูจน์ successful zero-touch authentication

ทดลอง provision เพิ่มใน Edge profile เดียวกันโดยล็อกอินบัญชีเป้าหมายในหน้าต่างปกติจนถึง Gemini สำเร็จ แล้วเปิด production และรัน InPrivate ใหม่โดยไม่ช่วยพิมพ์หรือคลิกหลัง launch ผลยังเป็น `EMAIL_SUBMITTED` → `USER_ACTION_REQUIRED` พร้อม `Gemini document: Not observed` และ `Target account: Pending` จึงพิสูจน์ว่า normal-profile login สำเร็จเพียงอย่างเดียวไม่เท่ากับมี usable browser-managed auto-sign-in credential และห้ามนับ session ในหน้าต่างปกติเป็นผลผ่านของ isolated flow

## Install once in Chrome or Edge

1. ดาวน์โหลด ZIP จาก <https://poc-after-sso-login-gemini.web.app/downloads/gemini-sso-launcher-extension-v0.5.0.zip> และแตกไฟล์
2. Chrome เปิด `chrome://extensions` หรือ Edge เปิด `edge://extensions`
3. เปิด Developer mode
4. เลือก **Load unpacked** แล้วเลือกโฟลเดอร์ที่แตกไฟล์
5. เปิด **Details** ของ extension แล้วเปิด **Allow in InPrivate/Incognito** หนึ่งครั้ง
6. ตรวจว่า Extension ID คือ `jeenmgigpkffleijbmfciffiodlcdafh`

หลังติดตั้งแล้วให้ใช้งานจาก <https://poc-after-sso-login-gemini.web.app/> เท่านั้น Origin อื่นไม่สามารถส่งคำสั่งเข้า extension ได้

## ผลการทดลอง one-time provisioning

ทดลองล็อกอินบัญชีเป้าหมายใน Edge profile ปกติสำเร็จแล้ว แต่ InPrivate ใหม่ยังหยุดที่ Google password challenge ดังนั้น normal-profile session หรือการมี saved credential อย่างเดียวไม่ใช่หลักฐานว่า isolated zero-touch flow ใช้งานได้

POC ไม่ copy/post Google cookies จาก normal profile เข้า InPrivate เพราะ cookie คือ bearer credential การทำเช่นนั้นทำลาย isolation และไม่ใช่ supported Google sign-in flow

รายละเอียดข้อสรุปและ solution boundary อยู่ที่ [ARCHITECTURE-DECISION.md](./ARCHITECTURE-DECISION.md)

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

## Production evidence test

1. ปิด InPrivate windows ทั้งหมดเพื่อล้าง Google session เก่า
2. ติดตั้ง extension v0.5.0 จาก hosted ZIP และเปิด Allow in InPrivate หนึ่งครั้ง
3. เปิด production Firebase URL และต้องเห็น `Connected`
4. กดปุ่มหนึ่งครั้ง แล้วห้ามมี keyboard/mouse interaction หลังจากนั้น
5. Browser ต้องเปิดหน้าต่าง InPrivate จริงและเริ่มโดยไม่มี Google web session จากรอบก่อน
6. Extension ต้องเลือกบัญชี `codeassist.04@easybuy.co.th` เอง แต่ห้ามนับ `EMAIL_SUBMITTED` ว่า login สำเร็จ
7. ห้ามมี extension-owned credential page และห้ามมี password/cookie/token ใน extension messages/storage/logs
8. ถ้า browser และ Google ยอม authenticate โดยไม่ขอ interaction ต้องไปถึง `GEMINI_TARGET_ACCOUNT_CONFIRMED`
9. ถ้าไม่มี usable saved credential, มี MFA/CAPTCHA/device confirmation หรือยืนยันบัญชีไม่ได้ ต้องจบด้วยสถานะ fail-closed ที่ตรงเหตุการณ์
10. ปิด InPrivate ทั้งหมดแล้วเปิดใหม่ ต้องไม่ reuse Google web session เก่าจาก InPrivate รอบก่อน
11. รันแยก Chrome และ Edge เพราะ password-manager/policy behavior ต่างกัน

`GEMINI_DOCUMENT_OBSERVED` อย่างเดียวไม่ถือว่าผ่าน target-account acceptance
