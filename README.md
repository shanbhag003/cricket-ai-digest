# Cricket AI Digest

Polls live cricket match data from ESPN's public cricket API (no key, no signup)
and uses Claude to generate two persona-specific digests from the same raw match
state — an **Analyst** view ("the facts behind the moment") and a **Fan** view
("why this moment matters") — delivered to Slack and a live web dashboard.

## Why two digests, not one score alert

A raw score notification is the same alert for everyone. This project is a
**translation layer**: one data feed in, two reader-specific briefings out. The
cricket is incidental — the pattern is `raw feed → reasoning layer → persona-specific
briefing`, which is the same shape as most B2B data delivery problems.

## Architecture

```
ESPN header endpoint          find the series/event matching TEAM_FILTER
        │                     (once, then cached)
        ▼
ESPN scoreboard endpoint      ~6 KB · polled every POLL_INTERVAL_SECONDS
        │                     cheap fingerprint only
        ▼
   changed?  ──no──▶ stop. no further calls.
        │yes
        ▼
ESPN summary endpoint         ~270 KB · fetched only on change
        │                     scorecard, batters, leaders, venue, status
        ▼
 isMaterialChange()  ──no──▶ stop. no Claude call.
        │yes
        ▼
 MIN_SECONDS_BETWEEN_DIGESTS floor  ──too soon──▶ hold, retry next tick
        │
        ▼
     Claude ──▶ { analyst_digest, fan_digest }
        │
        ├──▶ Slack (Incoming Webhook)
        └──▶ Web dashboard (WebSocket push + REST history)
```

Two independent gates. The first saves bandwidth, the second saves money.

## Why ESPN's public API

ESPN exposes undocumented-but-public cricket endpoints requiring no key and no
signup, covering Tests, ODIs and T20s alike. Free tiers of commercial cricket APIs
are often thin on Test coverage or capped at ~100 requests/day, which doesn't
survive a five-day match.

**Caveats — these are real, not boilerplate:**

- Unofficial and undocumented. Field names can change without notice, there's no
  SLA, and no support if it breaks.
- **ESPN 403s based on User-Agent from datacenter IPs.** Verified: `curl/8.5.0`
  returns 200, while a browser UA, a custom UA, and no UA all return 403 from the
  same IP. `espnClient.js` sets a curl UA for this reason. If ESPN tightens this,
  the app stops working and there is no fallback.
- Field paths in `normalizeMatch()` were verified against a live Test payload, not
  guessed. Two traps found there, both documented inline in the code:
  - `matchcards` is **not** an innings list — it's Batting/Bowling/Partnerships
    cards for a *single* innings. The correct source for runs/wickets/overs is
    `header.competitions[0].competitors[].linescores[]`.
  - ESPN mirrors the *bowling* overs into the non-batting side's linescore, so a
    team that hasn't batted appears as `0/0 (73 ov)`. These rows are dropped —
    otherwise the model confidently reports a scoreline that never happened.

## When Claude actually gets called

Polling frequently is cheap. Calling an LLM on every tick is not — and worse, it
produces a stream of digests that say nothing. `isMaterialChange()` in
`espnClient.js` gates it. A call fires only when one of these is true:

| Trigger | Example |
|---|---|
| First sighting of the match | server just restarted |
| Match status changed | Not Started → Live → Finished |
| Status detail changed | "Match delayed by a wet outfield" appears or clears |
| New innings started | a declaration, or the second innings beginning |
| A wicket fell | 288/2 → 288/3 |
| Team crossed a 50 | 299 → 301 fires; 292 → 296 does not |
| Crossed a 10-over mark | 79.4 ov → 80.1 ov |
| Batter milestone, or a new batter at the crease | 149 → 151 |
| Follow-on enforced | |
| Fourth-innings target set | |

Deliberately invisible: singles, twos, boundaries, dot balls, maidens, over-by-over
ticking.

On top of that, `MIN_SECONDS_BETWEEN_DIGESTS` is a hard floor per match, so a
collapse of three wickets in two overs doesn't become three API calls in ninety
seconds. Note the asymmetry: a *skipped* (non-material) change advances the
baseline, but a *held* (rate-limited) change does not — so a held wicket still
fires on the next tick rather than being swallowed.

Realistic volume for a full day's Test cricket: **~25–30 Claude calls**. Ungated at
60-second polling it would be ~480.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
```

Requires **Node 20+**. There is no `node-fetch` dependency — the app uses Node's
built-in `fetch`. (`node-fetch` v3 splits into several sub-packages and was a
recurring source of `ERR_MODULE_NOT_FOUND` on deploy.)

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | console.anthropic.com → API Keys |
| `CLAUDE_MODEL` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` is plenty here and cheaper |
| `TEAM_FILTER` | — | e.g. `India,Sri Lanka`. Matched against both series name and event name. Blank = first live match found |
| `POLL_INTERVAL_SECONDS` | `60` | seconds, not minutes |
| `MIN_SECONDS_BETWEEN_DIGESTS` | `120` | hard floor between Claude calls per match |
| `SLACK_WEBHOOK_URL` | — | optional; blank skips Slack |
| `PORT` | `3000` | |

`TEAM_FILTER` is matched against the series name **and** the event name together.
Series name alone is unreliable — "The Hundred Men's Competition" contains no team
names at all.

## Running it

```bash
npm start
```

Open `http://localhost:3000`. On the first poll the log should show:

```
Locked onto: India tour of Sri Lanka 2026 — Sri Lanka v India (league 24567, event 1544001)
```

## Is it actually working?

Three separate questions, three separate answers. The third is the one that matters.

**Is the process alive?** `GET /health` returns live counters:

```json
{"status":"ok","polls":847,"pollErrors":0,"changesSeen":26,
 "digestsGenerated":26,"digestErrors":0,
 "lastMatchSeen":"Sri Lanka v India — 288/2 (73 ov)","lastError":null}
```

Read them as a diagnostic, not decoration:

- `polls` climbing, `changesSeen` at 0 during live play → gate too tight, or ESPN stale
- `pollErrors` climbing → the ESPN 403 is back, or the endpoint moved
- `digestErrors` climbing → Claude returning malformed JSON

Three failure modes, three numbers. The point is that they don't look alike.

**Did it find the right match?** Check the `Locked onto:` line in the logs.

**Is the data any good?** `GET /api/debug/raw` returns the exact object handed to
Claude. This is the check people skip and the one that catches real problems — a
digest generated from all-null fields still *looks* like a success in the logs. If
you can't read that JSON and immediately recognise the match, neither can Claude.

## Cost and platform limits

**Claude — not a concern.** At Sonnet 5's $2/$10 per million tokens and roughly
1,200 input / 150 output tokens per call, ~30 calls/day is about **$0.12/day** —
around 60 cents for an entire five-day Test. Set a spend cap in the console and
stop thinking about it.

**Render free tier — this is the one that bites.** 750 free instance hours per
workspace per calendar month, and a month is ~730 hours. Keeping one service awake
24/7 consumes almost the entire allowance:

- Only **one** always-on free service per workspace. A second one and free services
  get suspended until the next month.
- Better: only keep it awake during play hours. A Test in Sri Lanka runs roughly
  09:30–16:30 IST; pinging 08:00–18:00 IST uses ~300 hours/month.
- Free services spin down after 15 minutes without traffic and take up to a minute
  to wake. An external pinger (UptimeRobot on `/health`) prevents this, at the cost
  of instance hours.
- The filesystem is ephemeral — wiped on every redeploy, restart and spin-down.

**Known limitation:** `digestHistory` and all state live in memory, so they're lost
on restart, and the first poll after a cold start re-digests the current state as
if it were new. Either label the dashboard panel "session history" or move it to
Postgres — note Render's free Postgres expires 30 days after creation.

## Deploying

1. Push to GitHub. **Make sure `.gitignore` exists first** — it must contain
   `node_modules/` and `.env`. Adding it later doesn't help: `.gitignore` has no
   effect on files git already tracks.
2. New Web Service on Render → connect the repo → Node is auto-detected.
3. Add environment variables in the Render dashboard.
4. If a build fails on dependencies, use **Manual Deploy → Clear build cache &
   deploy**. Render caches `node_modules` between builds and will happily reuse a
   broken tree.

`package.json` and `package-lock.json` must always be committed together — `npm ci`
refuses to install when they disagree.

If you ever see `fetch is not defined`, Node is older than 18. Set `NODE_VERSION=20`.

## Tuning the digests

Both personas live in one system prompt in `src/digestGenerator.js`. Add a third
audience or change the tone there.

The prompt's most important rule is the null-handling instruction: *if a field is
absent, omit that point entirely — never estimate.* `digestGenerator.js` also strips
null and empty values before serialising, so the model never sees a blank slot to
fill. Blank fields are where hallucinations come from; an instruction not to invent
data does nothing if you hand the model a form with every box empty.

## Honest scope

This is a working demonstration of the raw-feed → reasoning-layer →
persona-specific-briefing pattern. It is not a notification product and doesn't
compete with Cricbuzz. It depends on an undocumented third-party endpoint with
active bot protection, which could stop working at any time.
