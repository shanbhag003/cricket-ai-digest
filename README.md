# Cricket AI Digest

Polls live cricket match data from CricketData.org (formerly CricAPI) and uses
Claude to generate two audience-specific digests from the same raw match state —
one for a broadcast operations team, one for a broadcast partner's business
stakeholder — delivered to both Slack and a live web dashboard.

## Why two digests, not one score alert

Raw score notifications (Cricbuzz/Cricinfo-style) are the same alert to everyone.
This project instead demonstrates a **translation layer**: taking one raw data feed
and generating role-specific outputs, the same problem B2B broadcast data delivery
actually solves for partners who don't want raw feed data, they want it turned into
what matters to their business. The cricket data itself is incidental — the point is
the pattern: raw feed → reasoning layer → role-specific briefing.

## Why CricketData.org

Unlike some free sports-data tiers that only cover specific T20 leagues,
CricketData.org's free tier isn't restricted by match format — it covers
Tests, ODIs, T20s, and domestic cricket, with 100 requests/day and no expiry.
That matters here since Test matches run for days and a league-restricted
free tier would simply return nothing for them.

## Architecture

```
CricketData.org API (poll every N min)
        │
        ▼
  Change detection (skip if score/status unchanged since last poll)
        │
        ▼
     Claude ──▶ { ops_digest, partner_digest }
        │
        ├──▶ Slack (Incoming Webhook)
        └──▶ Web dashboard (WebSocket push + REST history)
```

## 1. Set up the project

```bash
npm install
cp .env.example .env
# fill in .env with your real values (see below)
```

### Getting your credentials

- **ANTHROPIC_API_KEY**: console.anthropic.com → API Keys → Create Key
- **CRICKETDATA_API_KEY**: cricketdata.org → sign up → your key appears in
  the Member Area immediately, no credit card, no expiry on the free tier.
- **SLACK_WEBHOOK_URL** (optional): api.slack.com/apps → Create App → Incoming
  Webhooks → Add New Webhook to Workspace. Leave blank to skip Slack delivery.

## 2. Run it locally

```bash
npm start
# server listening on port 3000
```

Open `http://localhost:3000` in a browser — that's your live dashboard. It
polls immediately on startup, then every `POLL_INTERVAL_MINUTES` (default 15
— kept conservative to stay well within the 100 req/day free quota).

## 3. Deploy it

Same as the RAID log project — Render or Railway free tier work well:
1. Push this to a GitHub repo
2. New Web Service on Render → connect repo → it auto-detects Node
3. Add the same environment variables from `.env` in the dashboard
4. Deploy — you get a public HTTPS URL for both the dashboard and Slack delivery

## 4. Tuning the digest

Both digest personas are defined in one system prompt in `src/digestGenerator.js`.
Adjust the persona descriptions there if you want a third audience (e.g. a
"fan-facing" digest) or different tone/length.

## Cost & rate limits

- CricketData.org free tier: 100 requests/day. At a 15-minute poll interval
  that's ~96 requests/day if running continuously — leaves little headroom,
  so during a multi-day Test match consider bumping `POLL_INTERVAL_MINUTES`
  to 20-30, or only running the poller during play hours.
- Claude calls only fire when the match state actually changes (via the
  fingerprint check in `server.js`), not on every poll — keeps Claude cost
  minimal even across a 5-day Test.

## For the portfolio / interview narrative

Suggested framing: *"I prototyped an AI layer that turns a raw sports data
feed into stakeholder-ready briefings for two different audiences from the
same event — similar to how B2B broadcast data has to be translated
differently for different partner needs."* This is honest: it doesn't compete
with Cricbuzz as a notification product, and doesn't claim to. It's a working
demonstration of the data-to-decision translation pattern, built against a
free public cricket data API.

Note: Sportmonks Cricket (a different provider, T20-only on its free tier)
is the one confirmed to be listed in the `public-apis/public-apis` GitHub
repo specifically — if you want to credit "found this on the public-apis
list" in a post, that claim applies to Sportmonks, not CricketData.org.
