# 24/7 WhatsApp Gemini AI Bot (Railway Deployment)

A full-featured Node.js WhatsApp bot integrated with Google Gemini (`gemini-3.8-flash`) for 24/7 automated follow-ups, reminders, and chat analysis hosted on Railway.

## 📁 Repository File Structure

- `index.js` - Core bot application code
- `Dockerfile` - Linux + Chromium setup for headless WhatsApp Web running in Railway containers
- `package.json` - Node dependencies and start script
- `.env.example` - Template for Railway environment variables

## 🚀 How to Deploy to Railway

1. Create a new GitHub Repository and push these files into it.
2. Sign in to [Railway.app](https://railway.app).
3. Click **New Project** → **Deploy from GitHub repo** → select your repository.
4. Go to **Variables** tab in Railway and add:
   - `GEMINI_API_KEY`: Your key from Google AI Studio.
5. Go to **Settings** → **Volumes** → **Add Volume**:
   - Mount Path: `/app/session_data` (This saves your WhatsApp session so you don't need to re-scan on redeploys).
6. Open the **Deploy Logs** tab in Railway:
   - Scan the terminal QR code with your WhatsApp app (**Settings -> Linked Devices -> Link a Device**).
