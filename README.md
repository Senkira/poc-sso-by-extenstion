# Gemini Extension Agent POC

POC นี้แยกจากโปรเจกต์เดิมและไม่แก้ `sso-gemini-login-poc` โดยเครื่องผู้ใช้ติดตั้งเพียง Chromium Extension เท่านั้น ไม่มี PowerShell, Native Messaging host, Windows Credential Manager หรือ Node.js บนเครื่องปลายทาง

Production URL: <https://poc-after-sso-login-gemini.web.app/>

## Flow

1. ผู้ใช้เปิดหน้า POC และกด Login โดยไม่มีช่อง password
2. หน้า POC ติดต่อ Extension ID คงที่ผ่าน `externally_connectable`
3. Extension ขอ Firebase ID token จาก HTTPS credential broker; broker ใช้ POC credential ใน Secret Manager ยืนยัน Firebase Auth และ Extension ตรวจ token/UID ซ้ำกับ Firebase
4. Extension เปิด InPrivate/Incognito window ใหม่แบบ minimized แล้วเริ่ม Google-to-Gemini flow
5. เมื่อ exact Google document อยู่ที่ `/challenge/pwd` และ selected account เป็น `codeassist.04@easybuy.co.th` เพียงบัญชีเดียว Extension จึงส่ง bearer ID token ไปขอ credential แบบ one-shot
6. Backend อ่าน Google password จาก Firebase Secret Manager แล้วตอบตรงให้ Extension ผ่าน HTTPS โดยตั้ง `Cache-Control: no-store`
7. Extension ใช้ password ใน memory, focus และ set exact input, รอ Google DOM, ตรวจว่า input ถือค่าจริงก่อนกด Next หนึ่งครั้ง แล้วตั้งค่า object เป็นค่าว่าง/null และไม่ขอซ้ำ
8. Extension เปิด Gemini tab ใน isolated window เดิม รอ session, reload หนึ่งครั้ง, ยืนยัน exact target account, ปิด auth tab และแสดง Gemini เหลือหนึ่ง tab

ถ้า Google ขอ MFA, CAPTCHA, passkey, device approval หรือหน้า password ไม่ผูกกับ target account ระบบ fail closed และไม่พยายาม bypass challenge

## ติดตั้งบนเครื่องผู้ใช้

1. ดาวน์โหลด `gemini-extension-agent-poc-v0.13.1.zip` จากหน้า Production แล้วแตกไฟล์
2. เปิด `edge://extensions` หรือ `chrome://extensions`
3. เปิด Developer mode แล้วเลือก Load unpacked ที่โฟลเดอร์ `extension`
4. เปิด Details และเปิด Allow in InPrivate/Incognito หนึ่งครั้ง
5. กลับหน้า Production และตรวจว่าแสดง `Connected`

ไม่มีขั้นตอนรันสคริปต์, สร้าง Generic Credential, ลง runtime หรือ reboot เครื่องผู้ใช้

## Credential lifecycle

- POC และ Google passwords อยู่ที่ backend secrets `POC_FIREBASE_PASSWORD` และ `GEMINI_TARGET_PASSWORD` เท่านั้น ไม่อยู่ใน Git, ZIP, Hosted page หรือ Extension source
- Extension ขอ password เมื่อถึง exact password form เท่านั้น ไม่ prefetch
- หน้า POC แยกสถานะ `Received; submit pending` ออกจาก `Submitted once` จึงไม่รายงานว่าส่งสำเร็จก่อนกรอกและกด Next จริง
- คำขอผูกกับ Firebase ID token, exact UID, request UUID, protocol version และ fixed Extension origin
- run ใช้สถานะ atomic `NOT_REQUESTED → REQUESTING → CONSUMED`; worker restart หลังเริ่ม request จะไม่ claim credential ซ้ำ
- password ไม่ถูกใส่ใน run status หรือ `chrome.storage`; หลัง script call จะถูก overwrite และปล่อย reference
- Firebase broker token อาจอยู่ชั่วคราวใน `chrome.storage.session` เพื่อให้ MV3 worker restart ระหว่าง navigation แล้วทำต่อได้ และถูกลบเมื่อ claim credential หรือ run จบ
- JavaScript ไม่รับประกัน deterministic memory zeroization; “ทิ้ง” ในที่นี้หมายถึงไม่ persist, ไม่ log, ไม่ cache และจำกัด lifetime ไม่ได้ป้องกัน memory forensics

## POC security boundary

นี่เป็น POC ตาม requirement ที่ backend ส่ง reusable Google password ให้ client Extension ดังนั้นผู้ที่ควบคุม endpoint/Extension process สามารถ inspect หรือแก้ Extension เพื่อดึง password ได้ แม้โค้ดปกติจะไม่เก็บ password ก็ตาม การจำกัด CORS/Origin และ Firebase token ลด accidental access แต่ไม่ทำให้ client เป็น trusted secret boundary

Production ที่ต้องป้องกัน password จาก endpoint ควรเปลี่ยนเป็น federated SSO, delegated token หรือ broker ที่ทำงานแทนโดยไม่ส่ง reusable password ถึง client

## Verify/build

Node.js ใช้เฉพาะเครื่องพัฒนาและ managed backend ไม่อยู่ใน endpoint package

```powershell
npm install --prefix .\functions
npm test --prefix .\functions
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
node .\tests\static.test.js
node .\tests\service-worker.test.js
node .\tests\content-script.test.js
node .\tests\page-guards.test.js
node .\tests\app.test.js
node .\tests\prompt-postcondition.test.js
```

## Backend/deploy

ตั้ง secrets บน backend แบบ interactive โดยไม่ใส่ค่าใน command line หรือไฟล์:

```powershell
npx --yes firebase-tools functions:secrets:set GEMINI_TARGET_PASSWORD --project poc-after-sso-login-gemini
npx --yes firebase-tools functions:secrets:set POC_FIREBASE_PASSWORD --project poc-after-sso-login-gemini
npx --yes firebase-tools deploy --only functions,auth,hosting --project poc-after-sso-login-gemini
```

Cloud Function ใช้ Node.js 22, `minInstances: 0` และ scale to zero แต่ Firebase Functions ต้องใช้โปรเจกต์ Blaze ตามข้อกำหนดของ Firebase ห้ามเปิด billing อัตโนมัติ

## E2E acceptance

1. ปิด InPrivate/Incognito windows ทั้งหมดเพื่อล้าง isolated Google session
2. Reload Extension v0.13.1 และเปิด Allow in InPrivate/Incognito
3. เปิด Production URL แล้วกด Login ครั้งเดียว
4. ผู้ใช้ต้องไม่กรอกหรือคลิก Google login UI
5. หน้า POC ต้องแสดง credential delivered once และ `GEMINI_TARGET_ACCOUNT_CONFIRMED`
6. ตอนจบต้องเหลือ Gemini tab เดียวและ account control ต้องเป็น target account จริง
