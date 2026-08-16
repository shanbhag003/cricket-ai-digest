import "dotenv/config";
import express from "express";
import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

import { getLiveMatches, isMaterialChange } from "./espnClient.js";
import { generateDigest } from "./digestGenerator.js";
import { postToSlack } from "./slackNotifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const POLL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 60;
const MIN_SECONDS_BETWEEN_DIGESTS =
  parseInt(process.env.MIN_SECONDS_BETWEEN_DIGESTS, 10) || 120;

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

  if (matches.length === 0) return;

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
      console.log(`[baseline] ${stats.lastMatchSeen} — no digest (cold start)`);
      broadcast({ type: "baseline", match: stats.lastMatchSeen, at: stats.lastPollAt });
      continue;
    }

    if (!isMaterialChange(prev, match)) {
      lastMatchState.set(match.matchId, match); // advance baseline
      saveState();
      broadcast({ type: "tick", match: stats.lastMatchSeen, at: stats.lastPollAt });
      continue;
    }

    // Guard against re-digesting an identical state after a state-file loss.
    if (digestHistory[0]?.fingerprint === match.fingerprint) {
      console.log(`[dedupe] identical fingerprint already digested — skipping`);
      lastMatchState.set(match.matchId, match);
      saveState();
      continue;
    }

    const since = Date.now() - (lastDigestAt.get(match.matchId) || 0);
    if (since < MIN_SECONDS_BETWEEN_DIGESTS * 1000) {
      stats.suppressedByFloor++;
      console.log(`[hold] material, but only ${Math.round(since / 1000)}s since last digest`);
      continue; // baseline NOT advanced — retry next tick
    }

    stats.changesSeen++;
    lastMatchState.set(match.matchId, match);
    lastDigestAt.set(match.matchId, Date.now());

    try {
      const digest = await generateDigest(match);
      const entry = {
        matchId: match.matchId,
        teams: `${match.team1} vs ${match.team2}`,
        venue: match.venue,
        status: match.status,
        score,
        fingerprint: match.fingerprint, // enables the dedupe check above
        analystDigest: digest.analyst_digest,
        fanDigest: digest.fan_digest,
        generatedAt: new Date().toISOString(),
      };

      digestHistory.unshift(entry);
      if (digestHistory.length > MAX_HISTORY) digestHistory.pop();

      stats.digestsGenerated++;
      saveState();
      broadcast({ type: "digest", entry });
      await postToSlack(match, digest);
      console.log(`[digest #${stats.digestsGenerated}] ${entry.teams} ${entry.score}`);
    } catch (err) {
      stats.digestErrors++;
      stats.lastError = `${new Date().toISOString()} DIGEST: ${err.message}`;
      console.error(`Digest failed for ${match.matchId}:`, err.message);
      broadcast({ type: "error", scope: "digest", message: err.message });
    }
  }
}

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

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "history", history: digestHistory }));
});

loadState();
setInterval(pollAndDigest, POLL_SECONDS * 1000);

server.listen(PORT, () => {
  console.log(`Listening on ${PORT} — polling every ${POLL_SECONDS}s`);
  console.log(
    `Floor: ${MIN_SECONDS_BETWEEN_DIGESTS}s · digest on startup: ${DIGEST_ON_STARTUP}`
  );
  pollAndDigest();
});
