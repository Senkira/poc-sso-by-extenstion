# ADR: one-shot HTTPS credential broker for isolated Gemini login

วันที่: 2026-08-31

## Decision

ใช้ Chromium MV3 Extension เป็น browser agent และ Firebase HTTPS Function เป็น one-shot credential broker เครื่องผู้ใช้ติดตั้ง Extension เพียงอย่างเดียว ส่วน Google password อยู่ใน Firebase Secret Manager และถูกส่งให้ Extension เฉพาะตอน exact Google password document พร้อมใช้งาน

เลิกใช้ Native Messaging, PowerShell bootstrap และ Windows Credential Manager ทั้งหมด Node.js 22 ทำงานเฉพาะ managed backend

## Authentication gates

หน้า POC รับเฉพาะ Employee ID `O1234567` แบบ read-only และส่งคำขอไป fixed Extension ID จาก production origin/main frame เท่านั้น Extension เรียก broker เพื่อ mint Firebase ID token สำหรับ exact UID จากนั้นตรวจ token กับ Identity Toolkit ก่อนเปิด run

เมื่อขอ Google credential broker ตรวจ bearer Firebase ID token, exact UID/email, request schema, UUID, protocol version และ exact Extension origin ก่อนอ่าน `GEMINI_TARGET_PASSWORD` Secret Manager

`authenticatePoc` ที่รับ Employee ID อย่างเดียวเป็น POC gate ไม่ใช่ strong user authentication ผู้ใช้ endpoint ที่ติดตั้ง Extension ที่อนุญาตสามารถเริ่ม flow ได้ตาม design นี้

## Credential lifecycle

1. Extension ไม่ขอ Google password ล่วงหน้า
2. Google automation ต้องพบ exact `/challenge/pwd` document และ selected-account evidence เพียงหนึ่งรายการที่ตรง target email
3. run เปลี่ยน atomic state `NOT_REQUESTED → REQUESTING → CONSUMED` และ persist state ก่อน network request
4. Extension ส่ง Firebase bearer token ไป HTTPS broker; response ตั้ง `no-store` และมี target email/password
5. Extension revalidate tab, origin, path และ current `documentId` ก่อนส่ง password เข้า isolated document
6. หลัง `executeScript` Extension overwrite password property, null object reference และไม่ retry broker request
7. password ไม่อยู่ใน source, package, page DOM, run status, logs หรือ browser storage

Firebase ID token ถูกเก็บชั่วคราวใน `chrome.storage.session` เพื่อรองรับ MV3 service-worker restart ก่อนถึง password step และถูกล้างทันทีหลัง credential claim หรือ terminal failure `chrome.storage.session` จบตาม browser session

JavaScript strings ไม่รับประกัน deterministic zeroization ดังนั้น lifecycle นี้จำกัด persistence และ exposure window แต่ไม่อ้างว่าป้องกัน memory forensics

## Isolation and visibility

Extension ขอ `incognito: spanning` และต้องเปิด Allow in InPrivate/Incognito หนึ่งครั้ง ก่อน run ตรวจว่าไม่มี isolated window เดิม จากนั้นสร้าง `about:blank` minimized, persist tab mapping แล้ว navigate ไป Google

หลัง password submission ระบบเปิด Gemini tab ใน isolated window เดิม ปล่อย Google auth tab ทำงานเบื้องหลัง รอ session/reload/yืนยัน exact target account แล้วปิด auth tab เหลือ Gemini tab เดียวจึง reveal window

นี่เป็น isolated cookie/site-data context ไม่ใช่ Windows security sandbox หรือ browser profile ใหม่

## Fail-closed cases

- MFA, OTP, CAPTCHA, passkey หรือ device approval
- password page ไม่มี exact target-account evidence
- broker/token/origin/schema verification ล้มเหลว
- document เปลี่ยนระหว่าง authorization กับ submission
- มี InPrivate/Incognito window เดิมหรือ concurrent run
- Gemini ไม่ยืนยัน target account ภายใน deadline

POC ไม่ bypass Google challenge และ Google DOM/risk policy อาจเปลี่ยนได้

## Trust boundary and accepted risk

Reusable Google password ต้องมาถึง Extension เพื่อให้ extension กรอก login form ดังนั้น endpoint ที่ถูก compromise หรือ Extension ที่ถูกแก้ไขสามารถอ่านข้อความตอบจาก broker ได้ ไม่มีวิธีส่ง password ให้ client แล้วรับประกันพร้อมกันว่า client อ่านไม่ได้

Exact origin, Firebase ID token, no-store และ one-shot state ช่วยลดการเรียกผิด flow แต่ไม่เปลี่ยน client ให้เป็น trusted secret boundary สถาปัตยกรรมนี้จึงเหมาะกับ POC ที่ยอมรับ risk นี้เท่านั้น

## Cost/runtime boundary

Function ตั้ง `minInstances: 0` จึง scale to zero เมื่อไม่มี traffic ไม่มี Node.js runtime หรือ resident process บน endpoint อย่างไรก็ตาม Cloud Functions deployment ต้องใช้ Firebase Blaze project และอาจมี usage cost; deployment ห้ามเปิด billing อัตโนมัติ

## Rejected alternatives

| ทางเลือก | เหตุผลที่ไม่เลือก |
| --- | --- |
| Native Messaging/Credential Manager | requirement ใหม่ห้ามติดตั้งหรือ provision อย่างอื่นบน endpoint |
| ฝัง password ในเว็บ/Extension | secret ถูกดาวน์โหลดถาวรและวิเคราะห์ offline ได้ |
| copy Google cookies/session | เป็น bearer credential, ทำลาย fresh isolation และไม่ใช่ supported sign-in |
| pre-authenticated profile | ต้องเตรียม session ให้ผู้ใช้ล่วงหน้า |
| custom protocol/localhost listener | ต้องมี endpoint bootstrap/process เพิ่ม |
| SSO/SAML | ถูกตัดออกจากขอบเขตโปรเจกต์นี้ |
