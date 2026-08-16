import fetch from "node-fetch";

const BASE_URL = "https://api.cricapi.com/v1";

/**
 * Fetches all currently live/ongoing matches from CricketData.org (CricAPI v1).
 * Free tier: 100 requests/day, no expiry, covers Test/ODI/T20/domestic — not
 * restricted to specific leagues like Sportmonks' free plan.
 * Docs: https://cricketdata.org/how-to-use-cricket-data-api.aspx
 */
export async function getLiveMatches() {
  const url = `${BASE_URL}/currentMatches?apikey=${process.env.CRICKETDATA_API_KEY}&offset=0`;

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`CricketData API error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  if (data.status !== "success") {
    throw new Error(`CricketData API returned non-success status: ${JSON.stringify(data)}`);
  }

  return normalizeMatches(data.data || []);
}

/**
 * Normalizes CricAPI's raw response into the same flat shape the rest of the
 * app expects (team1/team2/venue/status/innings/fingerprint), regardless of
 * which underlying provider we're using.
 */
function normalizeMatches(rawMatches) {
  return rawMatches.map((m) => {
    const [team1, team2] = m.teams && m.teams.length === 2 ? m.teams : ["Team A", "Team B"];

    // CricAPI's `score` array has one entry per innings, e.g.
    // { r: 250, w: 4, o: 78.2, inning: "India Inning 1" }
    const innings = (m.score || []).map((s) => ({
      team: s.inning ? s.inning.replace(/ Inning \d+$/i, "") : "Unknown",
      score: s.r,
      wickets: s.w,
      overs: s.o,
      inningLabel: s.inning,
    }));

    // CricAPI doesn't give a clean "Live" enum like Sportmonks does — we infer it
    // from matchStarted/matchEnded flags instead.
    let status = "Not Started";
    if (m.matchStarted && !m.matchEnded) status = "Live";
    if (m.matchEnded) status = "Finished";

    return {
      matchId: m.id,
      matchType: m.matchType, // "test" | "odi" | "t20" | etc.
      team1,
      team2,
      venue: m.venue || "Unknown venue",
      status,
      note: m.status || null, // CricAPI's free-text status line, e.g. "Sri Lanka opt to bowl"
      innings,
      fingerprint:
        innings.map((i) => `${i.inningLabel}:${i.score}/${i.wickets}(${i.overs})`).join("|") + `|${status}|${m.status}`,
    };
  });
}
