# Vercel Signals + Resend

This app receives bot signal snapshots, keeps runtime state in memory (no KV), displays live BUY/SELL calls, and emails active signals via Resend.

## 1. Local Setup

```bash
cd vercel-signals
npm install
npm run dev
```

Open http://localhost:3000

## 2. Deploy to Vercel

1. Import `vercel-signals` as a new Vercel project.
2. Set environment variables in Vercel project settings:
   - `SIGNALS_WEBHOOK_TOKEN`
   - `RESEND_API_KEY`
   - `SIGNAL_EMAIL_FROM`
   - `SIGNAL_EMAIL_TO`
3. Deploy.

Important: Resend requires a verified sender identity. If `SIGNAL_EMAIL_FROM=bebisday@gmail.com` is rejected, verify a domain/sender in Resend and use that verified address.

## 3. Connect Python Bot

In Python `.env` at project root:

```env
SIGNALS_WEBHOOK_ENABLED=true
SIGNALS_WEBHOOK_URL=https://your-project.vercel.app/api/ingest
SIGNALS_WEBHOOK_TOKEN=change_me_long_random_secret
```

Restart the bot. It will POST signal snapshots each cycle.

## 4. Endpoints

- `GET /api/signals` -> returns latest snapshot from runtime memory
- `POST /api/ingest` -> receives bot snapshot and triggers Resend email for new active calls

## No-KV Note
This version does not use KV. Snapshot/subscriber state is in-memory per active server runtime.
