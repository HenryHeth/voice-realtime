# Voice Realtime Server

Real-time voice AI server for phone calls via Twilio + OpenAI.

## Restore Instructions

```bash
# 1. Clone
git clone https://github.com/HenryHeth/voice-realtime.git
cd voice-realtime

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Run
node index.js
```

## Required Credentials

- **Twilio:** Account SID, Auth Token, Phone Number
- **OpenAI:** API Key (for voice AI)
- **Telegram:** Bot Token + Chat ID (for notifications)

## Health Check

```bash
curl http://localhost:6060/
```
