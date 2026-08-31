# Architecture decision: zero-touch Google login

วันที่ตัดสินใจ: 2026-08-31

## Requirement ที่ใช้ตัดสิน

1. ผู้ใช้เข้า production Firebase POC และกด Login
2. ใช้ extension ที่ติดตั้งครั้งเดียวเปิด isolated Edge/Chrome context
3. ระบบ login `codeassist.04@easybuy.co.th` โดยผู้ใช้ไม่เห็นหรือกรอก Google password
4. ผู้ใช้ส่ง prompt และใช้ Gemini ของบัญชีเป้าหมายได้
5. ไม่ใช้ SSO, backend, Native Messaging, PowerShell หรือ Node.js บนเครื่องปลายทาง
6. Google password ต้องไม่อยู่ใน static Hosting, extension package, extension storage, message, status หรือ log

## Current verdict

**Static Firebase Hosting + extension-only ไม่สามารถทำข้อ 3 แบบ deterministic และปลอดภัยภายใต้ requirement ทั้งหมดพร้อมกันได้**

Extension สามารถควบคุมหน้าเว็บและกรอก DOM ชั่วคราวได้ในเชิงกลไก แต่ก่อนทำเช่นนั้นต้องได้รับ Google password หรือ authentication proof จากที่ใดที่หนึ่ง ขอบเขตปัจจุบันตัดแหล่งที่มาที่เชื่อถือได้ออกทั้งหมด:

| แหล่ง credential | ผล |
| --- | --- |
| ผู้ใช้กรอกตอน runtime | ผิด requirement ข้อ 3 |
| ฝัง password/ciphertext ใน Firebase static asset | ผู้โจมตีดาวน์โหลดไป brute-force/offline analysis ได้ |
| ฝัง password/key ใน extension | ผู้ใช้หรือผู้โจมตี inspect package ได้ และผิดข้อ 6 |
| Edge/Chrome password manager | live E2E ใน InPrivate ยังขอ password; ไม่ deterministic และอาจขอ device verification |
| reuse/copy Google cookies | cookie คือ bearer credential, ทำลาย isolation และไม่ใช่ supported login flow |
| backend vault/credential broker | เป็น solution boundary ที่เป็นไปได้ แต่ผิดข้อ 5 และยังรับประกันว่าจะไม่มี MFA/CAPTCHA/risk challenge ไม่ได้ |
| Google federation/SSO | เป็น supported direction แต่ถูกตัดออกโดย requirement |

การเข้ารหัส Google password ด้วย POC password ไม่แก้ปัญหา: static client ต้องมี ciphertext, salt, KDF และโค้ดถอดรหัสครบ ผู้โจมตีจึงทำ offline guessing ได้ และ plaintext ยังต้องปรากฏใน browser/extension memory หลังถอดรหัส

## Evidence จาก production E2E

- Firebase production origin ติดต่อ extension protocol 4 ได้
- Extension เปิด InPrivate window และส่ง target email ถึง `EMAIL_SUBMITTED` ได้
- Google ไปที่ password challenge และ POC จบ `USER_ACTION_REQUIRED`
- ไม่พบ Gemini document และไม่ยืนยัน target account
- หลัง provision normal Edge session ของ target account สำเร็จ การเปิด InPrivate ใหม่ยังจบ `USER_ACTION_REQUIRED`

ผลนี้พิสูจน์ orchestration และ fail-closed behavior เท่านั้น ไม่ใช่ successful login

## Solution boundaries ที่ทำได้จริง

### A. Supported production direction

ใช้ Google-supported federation/SSO หรือ API-based integration แทนการ script password หน้า Google นี่เป็นแนวทางที่ควบคุมสิทธิ์, revoke, audit และ MFA ได้ถูก boundary

### B. Credential broker experiment

ใช้ trusted backend vault ปล่อย secret เฉพาะเครื่อง/ผู้ใช้ที่ผ่านการอนุญาต แล้วให้ client ใช้ชั่วคราวโดยไม่ persist แนวทางนี้แก้เรื่อง static secret source แต่ยังเป็น scripted password login ที่ Google อาจหยุดด้วย MFA, CAPTCHA, passkey หรือ risk challenge จึงไม่รับประกัน zero-touch และไม่ใช่ solution ตามข้อจำกัดปัจจุบัน

### C. Dedicated pre-authenticated browser profile

Provision target Google session ใน dedicated persistent profile แล้วเปิด Gemini ใน profile เดิม ผู้ใช้ไม่ต้องกรอกรหัสทุกครั้ง แต่เป็น session reuse ไม่ใช่ fresh isolated login และ extension API เลือก profile โดยตรงไม่ได้ แนวทางนี้จึงต้องมี launcher/policy เพิ่มและอยู่นอก extension-only requirement

## Decision

เก็บ v0.5.0 เป็น honest negative POC สำหรับทดสอบ extension orchestration เท่านั้น ห้ามฝัง credential จริงหรือเปลี่ยนสถานะเป็น success โดยไม่มี `GEMINI_TARGET_ACCOUNT_CONFIRMED` จาก fresh isolated run

ถ้าต้องส่งมอบ flow 1-4 จริง ต้องผ่อนอย่างน้อยหนึ่ง boundary: อนุญาต supported federation/SSO, อนุญาต trusted credential broker พร้อมยอมรับ Google challenge risk, หรือยอมใช้ dedicated pre-authenticated profile/session reuse
