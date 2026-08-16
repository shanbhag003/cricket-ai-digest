import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";

import { getLiveMatches } from "./espnClient.js";
import { generateDigest } from "./digestGenerator.js";
import { postToSlack } from "./slackNotifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const POLL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES, 10) || 10;

// In-memory store: matchId -> last known fingerprint, so we only call Claude
// when the score/status has actually changed since the last poll.
const lastFingerprints = new Map();

// In-memory log of generated digests, shown on the dashboard's history panel.
const digestHistory = [];
const MAX_HISTORY = 50;

function broadcastToDashboard(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(message);
  });
}

async function pollAndDigest() {
  let matches;
  try {
    matches = await getLiveMatches();
  } catch (err) {
    console.error("Failed to fetch live matches:", err.message);
    return;
  }

  const liveMatches = matches.filter((m) => m.status === "Live");

  if (liveMatches.length === 0) {
    console.log(`[${new Date().toISOString()}] No live matches right now.`);
    broadcastToDashboard({ type: "status", message: "No live matches currently.", checkedAt: new Date().toISOString() });
    return;
  }

  for (const match of liveMatches) {
    const previousFingerprint = lastFingerprints.get(match.matchId);

    if (previousFingerprint === match.fingerprint) {
      continue; // nothing material changed since last poll, skip the Claude call
    }
    lastFingerprints.set(match.matchId, match.fingerprint);

    try {
      const digest = await generateDigest(match);

      const entry = {
        matchId: match.matchId,
        teams: `${match.team1} vs ${match.team2}`,
        venue: match.venue,
        status: match.status,
        analystDigest: digest.analyst_digest,
        fanDigest: digest.fan_digest,
        generatedAt: new Date().toISOString(),
      };

      digestHistory.unshift(entry);
      if (digestHistory.length > MAX_HISTORY) digestHistory.pop();

      broadcastToDashboard({ type: "digest", entry });
      await postToSlack(match, digest);

      console.log(`[${entry.generatedAt}] Digest generated for ${entry.teams}`);
    } catch (err) {
      console.error(`Failed to generate digest for match ${match.matchId}:`, err.message);
    }
  }
}

// REST endpoint so the dashboard can load history on first page load
app.get("/api/history", (req, res) => {
  res.json({ history: digestHistory });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "history", history: digestHistory }));
});

// Schedule polling every POLL_MINUTES minutes
cron.schedule(`*/${POLL_MINUTES} * * * *`, pollAndDigest);

server.listen(PORT, () => {
  console.log(`Cricket digest server listening on port ${PORT}`);
  console.log(`Polling every ${POLL_MINUTES} minute(s)`);
  pollAndDigest(); // run once immediately on startup instead of waiting for first cron tick
});
