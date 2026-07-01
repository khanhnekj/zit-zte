# Bot-Hosting Claimer

Claim free coins trên bot-hosting.net · 3 lần mỗi session (lần 1 +4xu, lần 2 +5xu, lần 3 +1xu).

## Deploy lên Render.com (miễn phí)

### Bước 1: Push lên GitHub
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/<user>/bothosting-claimer.git
git push -u origin main
```

### Bước 2: Tạo Web Service trên Render
1. Vào https://render.com → **New** → **Web Service**
2. Kết nối repo GitHub vừa push
3. Cấu hình:
   - **Name**: `bothosting-claimer`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
4. Bấm **Create Web Service**

### Bước 3: Dùng app
1. Mở URL Render cấp (vd: `https://bothosting-claimer.onrender.com`)
2. Nhập **Token** từ bot-hosting.net (DevTools → Application → Local Storage → key `Token`)
3. Chọn Captcha Provider:
   - **Tự giải** (miễn phí): giải hCaptcha trực tiếp trên trang
   - **YesCaptcha / 2Captcha**: nhập API key, tự động giải
4. Bấm **Claim ngay** → 3 lần (lần 1 +4xu, lần 2 +5xu, lần 3 +1xu)

## API Endpoints

| Method | URL | Mô tả |
|--------|-----|-------|
| GET | `/api/info?token=XXX` | Lấy thông tin tài khoản |
| POST | `/api/claim` | Claim 1 lần |

### POST /api/claim body:
```json
{
  "token": "Bearer JWT...",
  "round": 1,
  "hcaptchaToken": "optional - tự giải",
  "captchaKey": "optional - API key YesCaptcha/2Captcha",
  "provider": "yescaptcha"
}
```

## Phát triển local
```bash
npm install
npm start
# Mở http://localhost:3000
```
