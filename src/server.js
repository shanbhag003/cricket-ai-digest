import "dotenv/config";
import express from "express";
import http from "http";
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

// SECONDS, not minutes. node-cron's "*/N * * * *" silently never fires for
// N > 59, which is why the old version could look alive but do nothing.
const POLL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 60;

// Hard floor on Claude calls, regardless of how material the change is.
// Stops a collapse (3 wickets in 2 overs) turning into 3 calls in 90 seconds.
const MIN_SECONDS_BETWEEN_DIGESTS =
  parseInt(process.env.MIN_SECONDS_BETWEEN_DIGESTS, 10) || 120;

const lastMatchState = new Map(); // matchId -> full normalized match
const lastDigestAt = new Map();   // matchId -> epoch ms

const digestHistory = [];
const MAX_HISTORY = 50;

// Everything the dashboard needs to tell "healthy" from "silently broken".
const stats = {
  startedAt: new Date().toISOString(),
  polls: 0,
  pollErrors: 0,
  changesSeen: 0,
  digestsGenerated: 0,
  digestErrors: 0,
  lastPollAt: null,
  lastError: null,
  lastMatchSeen: null,
};

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
    // Surface it. A silent catch is why you can't tell if this thing works.
    broadcast({ type: "error", scope: "poll", message: err.message });
    return;
  }

  if (matches.length === 0) return; // nothing changed, or no match found

  for (const match of matches) {
    stats.lastMatchSeen = `${match.team1} v ${match.team2} — ${
      match.innings.find((i) => i.isBatting)?.score || match.status
    }`;

    const prev = lastMatchState.get(match.matchId);

    if (!isMaterialChange(prev, match)) {
      console.log(`[skip] ${stats.lastMatchSeen} — changed, but not material`);
      lastMatchState.set(match.matchId, match); // still advance the baseline
      broadcast({ type: "tick", match: stats.lastMatchSeen, at: stats.lastPollAt });
      continue;
    }

    const since = Date.now() - (lastDigestAt.get(match.matchId) || 0);
    if (since < MIN_SECONDS_BETWEEN_DIGESTS * 1000) {
      console.log(`[hold] material change but only ${Math.round(since / 1000)}s since last digest`);
      continue; // do NOT advance baseline — we want to catch this next tick
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
        score: match.innings.find((i) => i.isBatting)?.score || null,
        analystDigest: digest.analyst_digest,
        fanDigest: digest.fan_digest,
        generatedAt: new Date().toISOString(),
      };

      digestHistory.unshift(entry);
      if (digestHistory.length > MAX_HISTORY) digestHistory.pop();

      stats.digestsGenerated++;
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

app.get("/health", (req, res) => res.json({ status: "ok", ...stats }));

// THE endpoint that answers "is it actually working?" — shows the exact
// object Claude is being handed. If this looks wrong, the digest is wrong.
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

setInterval(pollAndDigest, POLL_SECONDS * 1000);

server.listen(PORT, () => {
  console.log(`Listening on ${PORT} — polling every ${POLL_SECONDS}s`);
  console.log(`Min gap between Claude calls: ${MIN_SECONDS_BETWEEN_DIGESTS}s`);
  pollAndDigest();
});
