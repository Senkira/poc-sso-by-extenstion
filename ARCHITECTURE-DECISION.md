# ADR: one-shot local credential bridge for isolated Gemini login

วันที่: 2026-08-30

## Decision

ใช้ Chromium MV3 Extension เป็น browser agent และใช้ Native Messaging host แบบ one-shot เป็นขอบเขตเดียวที่อ่าน POC และ Google credentials จาก Windows Credential Manager

หน้า Firebase ติดต่อ Native Messaging host โดยตรงไม่ได้ หน้าเว็บติดต่อเฉพาะ Extension ผ่าน `externally_connectable`; Extension เป็นผู้ยืนยัน POC กับ Firebase, ตรวจ Firebase ID token, สร้าง InPrivate window, เรียก host, ควบคุม Google login document, ยืนยัน target account และ post prompt

## เหตุผล

Extension อย่างเดียวอ่าน Windows Credential Manager ไม่ได้ และการฝัง Google password/ciphertext ใน static site หรือ extension package ทำให้ secret ถูกดาวน์โหลดและวิเคราะห์ได้ การใช้ custom protocol จะมี browser confirmation prompt และ response channel ที่ซับซ้อนกว่า Native Messaging

Native Messaging ให้คุณสมบัติที่ POC ต้องการ:

- จำกัด caller ด้วย fixed Extension ID ใน host manifest
- ใช้ length-prefixed stdin/stdout โดยไม่เปิด localhost port
- process ถูกสร้างต่อ request และจบหลัง response เดียว
- POC และ Google passwords ไม่อยู่ใน Firebase Hosting, Git, ZIP, browser storage หรือ command line
- register ได้ใน HKCU ทั้ง Edge และ Chrome โดยไม่ต้อง admin หรือ reboot

## Authentication gates

หน้า POC แสดง Employee ID `O1234567` แบบ read-only และไม่มี password field เมื่อผู้ใช้กด Login ครั้งเดียว Extension เรียก host เพื่ออ่าน `ESB.GeminiBroker.Poc.O1234567`, ใช้ password กับ Firebase Email/Password Authentication ภายใน service worker คืนเฉพาะ ID token ให้หน้าเว็บแบบ session-scoped และเริ่ม Gemini agent อัตโนมัติ

Extension ไม่เชื่อ boolean จากหน้าเว็บ แต่ส่ง ID token ไป `accounts:lookup` และยอมเริ่ม Agent เฉพาะ Firebase user ที่กำหนด จากนั้น request ถูกผูกกับ random UUID, InPrivate tab และ Firebase UID เดียวกัน Prompt submission ต้องยืนยัน ID token ซ้ำ

MV3 service worker อาจถูก suspend/restart ระหว่าง navigation จึง persist เฉพาะ whitelisted non-secret run metadata (`requestId`, tab/window IDs, stages, Firebase UID และ timestamps) ใน `chrome.storage.session` ค่า Firebase ID token, POC credential และ Google credential ไม่ถูก persist และ session state ถูกล้างเมื่อ browser session จบ

## POC credential lifecycle

1. Production page ส่งเฉพาะ Employee ID และ random request ID ไปยัง fixed Extension ID
2. Extension รับเฉพาะ production origin/main frame และ exact Employee ID
3. Native host อ่าน Generic Credential target `ESB.GeminiBroker.Poc.O1234567`
4. Extension ส่ง password ไป Firebase Authentication โดยตรงและล้าง reference หลังสร้าง request
5. หน้าเว็บได้รับเฉพาะ Firebase ID token; password ไม่ถูกใส่ใน DOM, page JavaScript, web storage หรือไฟล์

## Google credential lifecycle

1. Google password ไม่ถูกเรียกจนกว่าจะพบ `/challenge/pwd` และ document แสดง exact target account เพียงบัญชีเดียว
2. Native host อ่าน Generic Credential target `ESB.GeminiBroker.CodeAssist04`
3. Host ส่ง credential หนึ่ง response แล้ว exit
4. Extension ใช้ค่ากับ password document เดิมและล้าง object reference ทันที
5. ค่าไม่ถูกใส่ใน run status, log, `chrome.storage`, web storage หรือไฟล์

JavaScript และ .NET ไม่รับประกัน deterministic zeroization ของ immutable strings ดังนั้นคำว่า one-shot หมายถึงไม่มี persistence, ไม่มี cache และจำกัด lifetime/process ไม่ใช่การอ้างว่า memory forensic เป็นไปไม่ได้

## Isolation and visibility

Extension ขอ `incognito: spanning` และผู้ดูแลเปิด Allow in InPrivate/Incognito หนึ่งครั้ง แต่ละ run สร้าง InPrivate window ใหม่แบบ minimized ผู้ใช้เห็นหน้าต่างต่อเมื่อ Gemini content script ยืนยัน target account สำเร็จ

นี่คือ isolated cookie/site-data context ไม่ใช่ Windows security sandbox และไม่ใช่ browser profile ใหม่ เมื่อปิด InPrivate windows ทั้งหมด cookie store ของ context นั้นต้องถูกล้าง

## Fail-closed cases

Extension ปิด run window และไม่ให้ผู้ใช้กรอก Google password เมื่อพบ:

- MFA/OTP/phone challenge
- CAPTCHA
- passkey หรือ device approval
- password page ที่ไม่มี exact target-account evidence
- credential target หายหรือไม่ตรง target email
- Gemini โหลดแต่ยืนยันบัญชีเป้าหมายไม่ได้

Google อาจเปลี่ยน DOM หรือใช้ risk-based challenge ได้เสมอ POC นี้ไม่ bypass Google security และ successful E2E ต้องพิสูจน์ใหม่กับ account/environment ที่ใช้งานจริง

## Cost boundary

Deploy เฉพาะ Firebase Authentication configuration และ static Hosting ไม่มี Functions, Cloud Run, App Hosting หรือ long-running process จึงไม่มี minimum replicas และไม่มี idle compute component ให้ตั้งมากกว่า zero

## Rejected alternatives

| ทางเลือก | เหตุผลที่ไม่เลือก |
| --- | --- |
| ฝัง password/hash-encrypted password ในเว็บหรือ Extension | client ได้ ciphertext/key path ครบและทำ offline analysis ได้ |
| copy Google cookies/session | bearer credential, ทำลาย fresh isolation และไม่ใช่ supported sign-in |
| pre-authenticated profile | ต้อง reuse session และ Extension API เลือก profile โดยตรงไม่ได้ |
| custom protocol | browser prompt, one-way launch และเพิ่ม attack surface |
| localhost listener | ต้องมี resident process/port และ lifecycle ซับซ้อนกว่า one-shot host |
| WebAuthn ผ่าน `debugger`/CDP | experimental test mechanism, ต้อง persist reusable private key และขยาย permission สูงเกิน POC |
| SSO/SAML | ถูกตัดออกจากขอบเขตงานนี้ |
