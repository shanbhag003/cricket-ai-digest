import "dotenv/config";
import express from "express";
import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

import {
  getLiveMatches,
  isMaterialChange,
  setTrackedMatch,
  getTrackedMatch,
  getFormatRules,
} from "./espnClient.js";
import { listMatches } from "./matchDiscovery.js";
import { generateDigest } from "./digestGenerator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
// The score strip refreshes at this rate. Costs bandwidth only — the ~6 KB
// scoreboard endpoint is what gets polled, and the Claude gate is independent.
const POLL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 30;
// If set, this overrides the per-format default. Left unset (recommended),
// each format uses its own floor: Test 180s, ODI 120s, T20 90s.
const MIN_GAP_OVERRIDE = parseInt(process.env.MIN_SECONDS_BETWEEN_DIGESTS, 10) || null;
const minGapFor = (match) =>
  MIN_GAP_OVERRIDE ?? getFormatRules(match).minGapSeconds;

// A restart must NOT produce a digest. Without this, every crash, redeploy or
// spin-down wake emits a fresh digest for a match state that hasn't moved —
// which looks exactly like the app working, and isn't.
const DIGEST_ON_STARTUP = process.env.DIGEST_ON_STARTUP === "true";

// Best-effort persistence. Render's free filesystem is ephemeral, so this
// survives in-container restarts and crash loops but NOT redeploys. That's
// still most of the problem. It is a cache, never a source of truth.
const STATE_FILE = process.env.STATE_FILE || "/tmp/cricket-digest-state.json";

const lastMatchState = new Map();
const lastDigestAt = new Map();
let lastSnapshot = null;          // most recent live state, for the heartbeat

const digestHistory = [];
const MAX_HISTORY = 50;

const stats = {
  startedAt: new Date().toISOString(),
  polls: 0,
  pollErrors: 0,
  changesSeen: 0,
  digestsGenerated: 0,
  digestErrors: 0,
  baselinesEstablished: 0, // cold starts that set state WITHOUT calling Claude
  suppressedByFloor: 0,
  stateRestored: false,
  lastPollAt: null,
  lastError: null,
  lastMatchSeen: null,
};

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const [id, m] of Object.entries(raw.lastMatchState || {})) {
      lastMatchState.set(id, m);
    }
    for (const [id, t] of Object.entries(raw.lastDigestAt || {})) {
      lastDigestAt.set(id, t);
    }
    if (Array.isArray(raw.digestHistory)) digestHistory.push(...raw.digestHistory);
    stats.stateRestored = lastMatchState.size > 0;
    console.log(
      `State restored: ${lastMatchState.size} match(es), ${digestHistory.length} digest(s)`
    );
  } catch {
    console.log("No previous state found — will establish a baseline silently.");
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        lastMatchState: Object.fromEntries(lastMatchState),
        lastDigestAt: Object.fromEntries(lastDigestAt),
        digestHistory: digestHistory.slice(0, MAX_HISTORY),
      })
    );
  } catch (err) {
    console.error("Could not persist state:", err.message);
  }
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

/** Compact snapshot pushed to the console every poll, so it never looks dead. */
function liveSnapshot(match) {
  const bat = match.innings.find((i) => i.isBatting);
  lastSnapshot = {
    teams: `${match.team1} v ${match.team2}`,
    score: bat ? bat.score : match.status,
    runRate: bat?.runRate ?? null,
    status: match.status,
    statusDetail: match.statusDetail,
    session: match.session,
    venue: match.venue,
    format: match.matchFormat,
    batters: match.currentBatters,
    hasScorecard: match.hasScorecard,
    liveDataAvailable: match.liveDataAvailable,
    at: new Date().toISOString(),
  };
  return lastSnapshot;
}

/** Generate a digest, store it, push it to the console. Shared by the poller
 *  and the manual "Digest now" button. */
async function produceDigest(match, reason) {
  const score = match.innings.find((i) => i.isBatting)?.score || match.status;

  // No innings data means any digest would be a fixture preview dressed up as
  // a live update. Don't pay for that, and don't show it.
  if (!match.hasScorecard) {
    const why = match.liveDataAvailable
      ? "ESPN hasn't published a scorecard for this match yet."
      : "ESPN lists this fixture but doesn't provide live scoring for it.";
    console.log(`[no-data] ${match.team1} v ${match.team2} — ${why}`);
    broadcast({ type: "nodata", match: `${match.team1} v ${match.team2}`, message: why });
    return { ok: false, error: why, noData: true };
  }
  try {
    const digest = await generateDigest(match);
    const entry = {
      matchId: match.matchId,
      teams: `${match.team1} vs ${match.team2}`,
      venue: match.venue,
      status: match.status,
      format: match.matchFormat,
      reason,
      score,
      fingerprint: match.fingerprint, // enables the dedupe check
      analystDigest: digest.analyst_digest,
      fanDigest: digest.fan_digest,
      generatedAt: new Date().toISOString(),
    };

    digestHistory.unshift(entry);
    if (digestHistory.length > MAX_HISTORY) digestHistory.pop();

    stats.digestsGenerated++;
    saveState();
    broadcast({ type: "digest", entry });
    console.log(`[digest #${stats.digestsGenerated}] ${reason} · ${entry.teams} ${score}`);
    return { ok: true, entry };
  } catch (err) {
    stats.digestErrors++;
    stats.lastError = `${new Date().toISOString()} DIGEST: ${err.message}`;
    console.error(`Digest failed for ${match.matchId}:`, err.message);
    broadcast({ type: "error", scope: "digest", message: err.message });
    return { ok: false, error: err.message };
  }
}

async function pollAndDigest() {
  stats.polls++;
  stats.lastPollAt = new Date().toISOString();

  let matches = [];
  try {
    matches = await getLiveMatches();
  } catch (err) {
    stats.pollErrors++;
    stats.lastError = `${new Date().toISOString()} POLL: ${err.message}`;
    console.error("POLL FAILED:", err.message);
    broadcast({ type: "error", scope: "poll", message: err.message });
    return;
  }

  // getLiveMatches() returns [] when nothing changed since the last poll.
  // Still tell the console we checked — otherwise the score strip freezes on an
  // old timestamp during any quiet spell and looks like the app has died.
  if (matches.length === 0) {
    if (lastSnapshot) {
      broadcast({ type: "heartbeat", snapshot: { ...lastSnapshot, at: new Date().toISOString() } });
    }
    return;
  }

  for (const match of matches) {
    const score = match.innings.find((i) => i.isBatting)?.score || match.status;
    stats.lastMatchSeen = `${match.team1} v ${match.team2} — ${score}`;

    const prev = lastMatchState.get(match.matchId);

    // --- cold start: record where things stand, say nothing -----------------
    if (!prev && !DIGEST_ON_STARTUP) {
      lastMatchState.set(match.matchId, match);
      // Backdate so the floor is armed immediately — otherwise the very next
      // material change fires with no rate limit applied.
      lastDigestAt.set(match.matchId, Date.now());
      stats.baselinesEstablished++;
      saveState();
      console.log(
        `[baseline] ${stats.lastMatchSeen} — ${getFormatRules(match).label}, no digest (cold start)`
      );
      broadcast({ type: "baseline", match: stats.lastMatchSeen, snapshot: liveSnapshot(match) });
      continue;
    }

    const reason = isMaterialChange(prev, match);
    if (!reason) {
      lastMatchState.set(match.matchId, match); // advance baseline
      saveState();
      broadcast({ type: "tick", match: stats.lastMatchSeen, snapshot: liveSnapshot(match) });
      continue;
    }

    // Guard against re-digesting an identical state after a state-file loss.
    if (digestHistory[0]?.fingerprint === match.fingerprint) {
      console.log(`[dedupe] identical fingerprint already digested — skipping`);
      lastMatchState.set(match.matchId, match);
      saveState();
      continue;
    }

    const minGap = minGapFor(match);
    const since = Date.now() - (lastDigestAt.get(match.matchId) || 0);
    if (since < minGap * 1000) {
      stats.suppressedByFloor++;
      console.log(
        `[hold] material, but only ${Math.round(since / 1000)}s since last digest (${match.formatKey} floor ${minGap}s)`
      );
      continue; // baseline NOT advanced — retry next tick
    }

    stats.changesSeen++;
    broadcast({ type: "tick", match: stats.lastMatchSeen, snapshot: liveSnapshot(match) });
    lastMatchState.set(match.matchId, match);
    lastDigestAt.set(match.matchId, Date.now());
    await produceDigest(match, reason);
  }
}

app.use(express.json());

// What's on right now, for the dashboard dropdown.
app.get("/api/matches", async (req, res) => {
  try {
    const data = await listMatches({ force: req.query.force === "true" });
    res.json({ ...data, tracking: getTrackedMatch() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Switch which match the poller follows.
// NOTE: this is a GLOBAL switch, not per-user. Whoever picks last wins for
// everyone connected. Fine for a single-operator dashboard; would need
// per-connection subscriptions to be a real multi-user product.
app.post("/api/track", async (req, res) => {
  const { leagueId, eventId, seriesName } = req.body || {};
  if (!leagueId || !eventId) {
    return res.status(400).json({ error: "leagueId and eventId are required" });
  }

  setTrackedMatch({ leagueId, eventId, leagueName: seriesName });

  // Clear per-match state so the new match establishes a baseline silently
  // instead of immediately emitting a digest for a state nobody has seen change.
  lastMatchState.clear();
  lastDigestAt.clear();
  lastSnapshot = null;
  saveState();

  broadcast({ type: "tracking", leagueId, eventId, seriesName });
  res.json({ ok: true, tracking: getTrackedMatch() });

  pollAndDigest().catch((e) => console.error("post-switch poll failed:", e.message));
});

// Manual "Digest now" — bypasses the materiality gate. The console is the only
// consumer, so an on-demand brief is exactly what you want when you open it
// mid-match and the score hasn't moved yet.
app.post("/api/digest-now", async (req, res) => {
  try {
    const matches = await getLiveMatches({ force: true });
    if (matches.length === 0) {
      return res.status(404).json({ error: "No match currently tracked." });
    }
    const match = matches[0];
    lastMatchState.set(match.matchId, match);
    lastDigestAt.set(match.matchId, Date.now());
    const out = await produceDigest(match, "manual");
    res.status(out.ok ? 200 : out.noData ? 422 : 500).json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", (req, res) => res.json({ history: digestHistory }));

app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    ...stats,
  })
);

// Shows the exact object handed to Claude. If this looks wrong, digests are wrong.
app.get("/api/debug/raw", async (req, res) => {
  try {
    const matches = await getLiveMatches({ force: true });
    res.json({ count: matches.length, matches, stats });
  } catch (err) {
    res.status(500).json({ error: err.message, stats });
  }
});

// Any unmatched /api/* route returns JSON, not Express's default HTML error
// page. Without this a missing route surfaces in the browser as the useless
// "Unexpected token '<'" JSON parse error instead of naming the problem.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` });
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "history", history: digestHistory }));
});

loadState();
setInterval(pollAndDigest, POLL_SECONDS * 1000);

server.listen(PORT, () => {
  console.log(`Listening on ${PORT} — polling every ${POLL_SECONDS}s`);
  console.log(
    `Digest floor: ${MIN_GAP_OVERRIDE ? MIN_GAP_OVERRIDE + "s (override)" : "per-format"}` +
      ` · digest on startup: ${DIGEST_ON_STARTUP}`
  );
  pollAndDigest();
});
