import fetch from "node-fetch";

// Once we've located the target match, cache its leagueId + eventId so
// subsequent polls hit the summary endpoint directly instead of re-searching
// the active-series list every time.
let locked = null; // { leagueId, eventId }

/**
 * Fetches the target match's current state from ESPN's public cricket API.
 * No API key required — these are ESPN's own public endpoints (unofficial,
 * undocumented, but free and open). Docs reference:
 * https://github.com/pseudo-r/Public-ESPN-API/blob/main/docs/sports/cricket.md
 *
 * Uses TEAM_FILTER env var (comma-separated, e.g. "India,Sri Lanka") to find
 * and lock onto a specific series/match.
 */
export async function getLiveMatches() {
  const teamFilter = (process.env.TEAM_FILTER || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (locked) {
    try {
      const summary = await fetchMatchSummary(locked.leagueId, locked.eventId);
      return [normalizeMatch(summary)];
    } catch (err) {
      console.error(`Locked match lookup failed, re-searching:`, err.message);
      locked = null;
    }
  }

  const header = await fetchActiveSeriesHeader();
  const cricketSport = (header.sports || []).find((s) => s.uid?.includes("cricket") || s.slug === "cricket");
  const leagues = cricketSport?.leagues || [];

  for (const league of leagues) {
    const nameMatch = teamFilter.length === 0 || teamFilter.every((term) => (league.name || "").toLowerCase().includes(term));
    if (!nameMatch) continue;

    const event = (league.events || [])[0]; // most recent/active event in this series
    if (!event) continue;

    locked = { leagueId: league.id, eventId: event.id };
    console.log(`Locked onto ESPN series: ${league.name} (leagueId: ${league.id}, eventId: ${event.id})`);

    const summary = await fetchMatchSummary(locked.leagueId, locked.eventId);
    return [normalizeMatch(summary)];
  }

  console.warn(`No active ESPN cricket series found matching TEAM_FILTER="${teamFilter.join(",")}"`);
  return [];
}

async function fetchActiveSeriesHeader() {
  const url = `https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket&region=in&tz=Asia/Calcutta`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ESPN header endpoint error (${res.status}): ${errText}`);
  }
  return res.json();
}

async function fetchMatchSummary(leagueId, eventId) {
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${leagueId}/summary?contentorigin=espn&event=${eventId}&lang=en&region=in`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ESPN summary endpoint error (${res.status}): ${errText}`);
  }
  return res.json();
}

/**
 * Normalizes ESPN's match summary payload into the flat shape the rest of
 * the app expects. ESPN's response is unofficial/undocumented, so this is
 * defensive — it falls back gracefully if a field isn't where expected.
 * If you see missing data on the dashboard, check the raw JSON (fetch the
 * summary URL directly in a browser) and adjust the field paths below.
 */
function normalizeMatch(summary) {
  const header = summary.header || {};
  const competition = (header.competitions || [])[0] || {};
  const competitors = competition.competitors || [];

  const team1 = competitors[0]?.team?.displayName || competitors[0]?.team?.name || "Team A";
  const team2 = competitors[1]?.team?.displayName || competitors[1]?.team?.name || "Team B";

  const statusText = competition.status?.type?.detail || competition.status?.type?.description || "Unknown status";
  const statusState = competition.status?.type?.state; // "pre" | "in" | "post"

  let status = "Not Started";
  if (statusState === "in") status = "Live";
  if (statusState === "post") status = "Finished";

  // matchcards (if present) holds the innings-by-innings scorecard summary —
  // this is the "deep data" ESPN gives us that basic score APIs don't.
  const matchcards = summary.matchcards || [];
  const innings = matchcards.map((card) => ({
    team: card.team?.displayName || card.teamName || "Unknown",
    score: card.runs ?? card.score ?? null,
    wickets: card.wickets ?? null,
    overs: card.overs ?? null,
    inningLabel: card.title || card.inningLabel || null,
  }));

  // Top performers, if ESPN's `leaders` block is present — nice detail for
  // the digest prompt to reference (e.g. "century from X").
  const leaders = (summary.leaders || []).map((l) => ({
    name: l.athlete?.displayName || l.name,
    statLine: l.displayValue,
    category: l.name || l.category,
  }));

  return {
    matchId: header.id || competition.id,
    matchType: header.season?.type || null,
    team1,
    team2,
    venue: competition.venue?.fullName || competition.venue?.address?.summary || "Unknown venue",
    status,
    note: statusText,
    innings,
    leaders,
    fingerprint:
      innings.map((i) => `${i.inningLabel}:${i.score}/${i.wickets}(${i.overs})`).join("|") + `|${status}|${statusText}`,
  };
}
