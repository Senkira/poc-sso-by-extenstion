# Gemini Extension Agent POC

POC นี้แยกจากโปรเจกต์เดิมและไม่แก้ `sso-gemini-login-poc` โดยเครื่องผู้ใช้ติดตั้งเพียง Chromium Extension เท่านั้น ไม่มี PowerShell, Native Messaging host, Windows Credential Manager หรือ Node.js บนเครื่องปลายทาง

Production URL: <https://poc-after-sso-login-gemini.web.app/>

## Architecture และเส้นทางข้อมูล

โค้ดที่ใช้งานจริงทั้งระบบอยู่ใน repository เดียวกัน และแยกชื่อโฟลเดอร์ตามหน้าที่ชัดเจน:

| ส่วน | ตำแหน่ง | Runtime |
| --- | --- | --- |
| Frontend Web | `frontend-web/` | Firebase Hosting / browser tab ปกติ |
| Backend API | `backend-api/` | Firebase Functions v2 บน GCP |
| Edge/Chrome Extension | `browser-extension/` | Manifest V3 service worker และ content script |
| Automated tests | `tests/` และ `backend-api/test/` | Development/CI เท่านั้น |
| Legacy reference | `docs/legacy-reference-agent/` | เอกสารอ้างอิง ไม่ถูก build หรือ deploy |

```text
poc-sso-by-extenstion/
├── frontend-web/             # หน้าเว็บหลักที่ Firebase Hosting deploy
│   ├── index.html            # UI และ DOM หลัก
│   ├── app.js                # Login click, Extension messages, status polling
│   ├── styles.css            # รูปแบบหน้าเว็บ
│   └── downloads/            # ZIP Extension ที่หน้า Production แจก
├── backend-api/              # หลังบ้านจริงบน GCP
│   ├── index.js              # Cloud Function credentialBroker
│   ├── broker-core.js        # Request schema, origin/token helpers, constants
│   ├── package.json          # Cloud runtime/dependencies
│   └── test/                 # Backend unit tests
├── browser-extension/        # Agent ที่ติดตั้งใน Edge/Chrome
│   ├── manifest.json         # Permissions, fixed ID, allowed web origin
│   ├── service-worker.js     # Process หลัก: auth, broker, isolate, Google automation
│   └── content-script.js     # ตรวจ account บน Gemini document
├── scripts/                  # Package และ verify ทั้งระบบ
├── tests/                    # Frontend/Extension contract tests
├── firebase.json             # ชี้ Hosting -> frontend-web, Functions -> backend-api
└── docs/legacy-reference-agent/ # โค้ดเก่าเพื่ออ้างอิง ไม่ใช่ runtime ปัจจุบัน
```

Password ของ Google **ไม่ผ่าน `frontend-web/app.js` และไม่ถูกส่งให้หน้า Web UI** เส้นทางจริงคือ Cloud Function ส่ง HTTPS response ตรงไปที่ Extension service worker จากนั้น service worker ส่งค่าเป็น argument ชั่วคราวให้ script ที่รันใน exact Google document เท่านั้น

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Web as Firebase Hosting<br/>frontend-web/app.js
    participant Edge as Edge extension router<br/>chrome.runtime
    participant SW as Extension service worker<br/>browser-extension/service-worker.js
    participant API as credentialBroker<br/>backend-api/index.js
    participant Auth as Firebase Auth<br/>Identity Toolkit
    participant SM as GCP Secret Manager
    participant Google as Edge InPrivate<br/>accounts.google.com
    participant Gemini as Edge InPrivate<br/>gemini.google.com

    User->>Web: Click Login
    Web->>Edge: sendToExtension(AUTHENTICATE_POC)
    Edge->>SW: onMessageExternal
    SW->>API: callCredentialBroker(authenticatePoc)
    API->>SM: Read POC_FIREBASE_PASSWORD
    API->>Auth: signInPoc(password)
    Auth-->>API: Firebase ID token
    API-->>SW: idToken, expiresIn
    SW->>Auth: verifyPocIdToken(idToken)
    SW-->>Web: idToken (no Google password)

    Web->>Edge: sendToExtension(START_AGENT, idToken)
    Edge->>SW: onMessageExternal
    SW->>Auth: verifyPocIdToken(idToken)
    SW->>Google: startAgent -> windows.create(incognito)<br/>tabs.update(LOGIN_URL)
    Google-->>SW: webNavigation events + documentId
    SW->>Google: executeScript(inspectGooglePage)
    Google-->>SW: PASSWORD_REQUIRED + exact account confirmed

    SW->>API: fetchOneShotCredential -> callCredentialBroker<br/>getGoogleCredential + Bearer idToken
    API->>Auth: verifyIdToken(idToken)
    API->>SM: Read GEMINI_TARGET_PASSWORD
    API-->>SW: email + password<br/>HTTPS, Cache-Control: no-store
    Note over API,SW: Google password travels on this direct HTTPS hop only
    SW->>Google: executeScript(submitPassword,<br/>password, exact documentId)
    Google-->>SW: PASSWORD_SUBMITTED
    Note over SW: password = ""; credential = null;<br/>credentialState = CONSUMED

    SW->>Gemini: openIsolatedGeminiTab()
    Gemini->>SW: content-script reportGeminiDocument()
    SW->>Gemini: inspectGeminiActiveAccount()
    SW->>Gemini: reload once, confirm account, reveal window
    SW->>Google: close authentication tab
    Gemini-->>User: One ready Gemini tab
```

### Web ติดต่อ Extension ใน Edge อย่างไร

Edge ใช้ Chromium Extension API จึงเรียก namespace `chrome.*` เหมือน Chrome แม้ตัว browser จะเป็น Microsoft Edge การเชื่อมต่อไม่ได้ใช้ localhost, custom protocol, Native Messaging หรือ PowerShell แต่ใช้ extension routing ภายใน browser ดังนี้:

1. `browser-extension/manifest.json` มี `key` คงที่ ทำให้ build แบบ unpacked ได้ Extension ID คงที่ `jeenmgigpkffleijbmfciffiodlcdafh`
2. `externally_connectable.matches` อนุญาตเฉพาะ `https://poc-after-sso-login-gemini.web.app/*`
3. `frontend-web/app.js/sendToExtension(message)` เรียก `chrome.runtime.sendMessage(EXTENSION_ID, message, callback)`
4. Edge หา Extension จาก ID แล้วส่ง message เข้า `chrome.runtime.onMessageExternal` ใน `browser-extension/service-worker.js`
5. `isAllowedExternalSender(sender)` ตรวจ origin ของ sender ซ้ำก่อน dispatch ไปยัง `pingExtension`, `authenticatePoc`, `startAgent`, `getStatus`, `postPrompt` หรือ `cancelRun`

ดังนั้นเครื่องใหม่ต้องติดตั้ง Extension ที่ใช้ manifest key เดิมและเปิด Allow in InPrivate/Incognito ถ้าเปลี่ยน manifest key หรือ Extension ID ต้องแก้ทั้ง `EXTENSION_ID` ใน `frontend-web/app.js` และ `EXTENSION_ORIGIN`/CORS ใน backend ให้ตรงกัน

### Message และ API contract

| Hop | Message/action | ผู้ส่ง → ผู้รับ | Handler หลัก | มี Google password หรือไม่ |
| --- | --- | --- | --- | --- |
| Web → Extension | `PING` | `sendToExtension` → `onMessageExternal` | `pingExtension()` | ไม่มี |
| Web → Extension | `AUTHENTICATE_POC` | `handleLogin()` → `onMessageExternal` | `authenticatePoc()` | ไม่มี |
| Extension → API | `action: authenticatePoc` | `callCredentialBroker()` → `credentialBroker` | `validateAuthenticateRequest()` และ `signInPoc()` | ไม่มี Google password |
| Web → Extension | `START_AGENT` + `pocIdToken` | `launchGemini()` → `onMessageExternal` | `startAgent()` / `startAgentUnlocked()` | ไม่มี |
| Extension → API | `action: getGoogleCredential` + Bearer token | `fetchOneShotCredential()` → `credentialBroker` | `validateCredentialRequest()` และ `verifyIdToken()` | Response มี email/password |
| Extension → Google document | function arguments | `automateGoogle()` → `chrome.scripting.executeScript` | `submitPassword()` | มี password ชั่วคราว |
| Gemini content script → Extension | `GEMINI_DOCUMENT_SIGNAL` | `reportGeminiDocument()` → `onMessage` | `handleInternalMessage()` | ไม่มี |
| Web → Extension | `GET_STATUS` | `pollStatus()` → `onMessageExternal` | `getStatus()` | ไม่มีและ status ห้ามมี secret |

Payload สำคัญที่ Extension ใช้ขอ credential:

```http
POST /credentialBroker
Origin: chrome-extension://jeenmgigpkffleijbmfciffiodlcdafh
Authorization: Bearer <Firebase-ID-token>
Content-Type: application/json

{
  "action": "getGoogleCredential",
  "requestId": "<UUID-v4>",
  "version": 10
}
```

Backend ทำงานตามลำดับ `validateCredentialRequest()` → `parseBearer()` → Firebase Admin `verifyIdToken()` → ตรวจ exact UID/email → อ่าน `GEMINI_TARGET_PASSWORD` → `sendJson()` พร้อม `Cache-Control: no-store` ข้อมูลนี้ตอบกลับไปยัง request ของ Extension โดยตรง ไม่ได้ตอบไปยัง POC page

### Edge automation และ exact-document gate

1. `startAgentUnlocked()` ตรวจ Firebase token, Allow in InPrivate และบังคับให้ไม่มี InPrivate session เดิม
2. `chrome.windows.create({ incognito: true, focused: false, state: "minimized" })` สร้าง isolated window
3. `chrome.tabs.update(...LOGIN_URL)` เปิด Google login และ `tabToRequest` ผูก `tabId` กับ `requestId` ก่อน navigation
4. `handleCommitted()` และ `handleNavigation()` จับ top-level `documentId` ของแต่ละ navigation
5. `automateGoogle()` เรียก `inspectGooglePage()` เฉพาะ `documentId` ปัจจุบันเพื่อกรอก email/เลือก target account
6. ระบบเรียก `fetchOneShotCredential()` หลัง `inspectGooglePage()` คืน `PASSWORD_REQUIRED` และ exact account ตรงเท่านั้น
7. ก่อนส่ง password เข้า page จะอ่าน frame ใหม่ด้วย `chrome.webNavigation.getFrame()` และตรวจ origin, path และ `documentId` ซ้ำ
8. `submitPassword()` รอ input node นิ่ง, ตรวจ exact account, set password ผ่าน native input setter, dispatch `input/change`, ตรวจว่าค่ายังอยู่ แล้วคลิก Next หนึ่งครั้ง
9. `credentialState` เปลี่ยน `NOT_REQUESTED → REQUESTING → CONSUMED`; password object ถูก overwrite หลัง executeScript คืนผล ไม่อนุญาตให้ claim ซ้ำ
10. `openIsolatedGeminiTab()` เปิด Gemini ใน window เดิม ส่วน `reportGeminiDocument()` และ `inspectGeminiActiveAccount()` ยืนยัน account หลัง reload ก่อนปิด auth tab และแสดง window

ถ้า Google ขอ MFA, CAPTCHA, passkey, device approval หรือหน้า password ไม่ผูกกับ target account ระบบ fail closed และไม่พยายาม bypass challenge

### จุดที่ต้องเปลี่ยนเมื่อนำไปใช้กับงานจริง

- เปลี่ยนค่าคงที่ URL, Firebase project, target account และ allowed hosted origin ให้เป็น environment-specific configuration
- ตรึง Extension ID ด้วย enterprise deployment policy หรือ signed store package; backend CORS ต้องอนุญาต exact production extension origin เท่านั้น
- เพิ่ม authorization ตามผู้ใช้จริงและผูก `requestId` กับ server-side one-time claim/expiry; state แบบ one-shot ใน POC ปัจจุบันอยู่ฝั่ง Extension เป็นหลัก
- ห้าม log request/response body ที่ credential endpoint และต้องเปิด secret rotation, audit log, rate limit และ alert บน GCP
- ทำ integration test กับ Edge/Chrome เวอร์ชันองค์กร เพราะ Google DOM selector และ interactive challenge เปลี่ยนได้
- ถ้าข้อกำหนด production ต้องไม่ให้ endpoint อ่าน reusable password สถาปัตยกรรมนี้ไม่เพียงพอ ควรเปลี่ยน credential hop เป็น federated/delegated token หรือ backend-mediated session ที่ไม่ส่ง reusable password ลง client

## ติดตั้งบนเครื่องผู้ใช้

1. ดาวน์โหลด `gemini-extension-agent-poc-v0.13.2.zip` จากหน้า Production แล้วแตกไฟล์
2. เปิด `edge://extensions` หรือ `chrome://extensions`
3. เปิด Developer mode แล้วเลือก Load unpacked ที่โฟลเดอร์ `browser-extension`
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
npm install --prefix .\backend-api
npm test --prefix .\backend-api
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
2. Reload Extension v0.13.2 และเปิด Allow in InPrivate/Incognito
3. เปิด Production URL แล้วกด Login ครั้งเดียว
4. ผู้ใช้ต้องไม่กรอกหรือคลิก Google login UI
5. หน้า POC ต้องแสดง credential delivered once และ `GEMINI_TARGET_ACCOUNT_CONFIRMED`
6. ตอนจบต้องเหลือ Gemini tab เดียวและ account control ต้องเป็น target account จริง
