# Legacy reference agent

โฟลเดอร์นี้เก็บโค้ด C# จากแนวทางเดิมไว้เพื่ออ้างอิงเท่านั้น ไม่ใช่ runtime ของ POC ปัจจุบัน ไม่ถูกเรียกจาก `firebase.json` และไม่ถูก build, package หรือ deploy

Runtime ปัจจุบันมีเพียง:

- `frontend-web/` — Firebase Hosting
- `backend-api/` — Firebase Functions v2
- `browser-extension/` — Edge/Chrome Manifest V3 Extension
