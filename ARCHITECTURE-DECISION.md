# ADR: one-shot local credential bridge for isolated Gemini login

วันที่: 2026-08-30

## Decision

ใช้ Chromium MV3 Extension เป็น browser agent และใช้ Native Messaging host แบบ one-shot เป็นขอบเขตเดียวที่อ่าน Google credential จาก Windows Credential Manager

หน้า Firebase ติดต่อ Native Messaging host โดยตรงไม่ได้ หน้าเว็บติดต่อเฉพาะ Extension ผ่าน `externally_connectable`; Extension เป็นผู้ตรวจ Firebase ID token, สร้าง InPrivate window, เรียก host, ควบคุม Google login document, ยืนยัน target account และ post prompt

## เหตุผล

Extension อย่างเดียวอ่าน Windows Credential Manager ไม่ได้ และการฝัง Google password/ciphertext ใน static site หรือ extension package ทำให้ secret ถูกดาวน์โหลดและวิเคราะห์ได้ การใช้ custom protocol จะมี browser confirmation prompt และ response channel ที่ซับซ้อนกว่า Native Messaging

Native Messaging ให้คุณสมบัติที่ POC ต้องการ:

- จำกัด caller ด้วย fixed Extension ID ใน host manifest
- ใช้ length-prefixed stdin/stdout โดยไม่เปิด localhost port
- process ถูกสร้างต่อ request และจบหลัง response เดียว
- Google password ไม่อยู่ใน Firebase, Git, ZIP, browser storage หรือ command line
- register ได้ใน HKCU ทั้ง Edge และ Chrome โดยไม่ต้อง admin หรือ reboot

## Authentication gates

หน้า POC ใช้ Firebase Email/Password Authentication จริง `O1234567` ถูก map ไปยัง internal Firebase email หน้าเว็บเก็บเฉพาะ ID token แบบ session-scoped และล้าง password input หลัง request

Extension ไม่เชื่อ boolean จากหน้าเว็บ แต่ส่ง ID tokenไป `accounts:lookup` และยอมเริ่ม Agent เฉพาะ Firebase user ที่กำหนด จากนั้น request ถูกผูกกับ random UUID, InPrivate tab และ Firebase UID เดียวกัน Prompt submission ต้องยืนยัน ID token ซ้ำ

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
