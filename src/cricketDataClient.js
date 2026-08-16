import fetch from "node-fetch";

const BASE_URL = "https://api.cricapi.com/v1";

// Once we've located the match the user cares about, we cache its ID here so
// subsequent polls hit the cheap single-match endpoint instead of re-paginating
// through currentMatches every time (which burns through the 100 req/day quota fast).
let lockedMatchId = null;

/**
 * Fetches the target match's current state.
 * - If TEAM_FILTER env var is set (comma-separated, e.g. "India,Sri Lanka"),
 *   searches currentMatches for a match involving those teams, locks onto its
 *   ID, and from then on polls that specific match directly via match_info.
 * - If TEAM_FILTER is not set, falls back to returning all currently live matches
 *   (original behaviour).
 */
export async function getLiveMatches() {
  const teamFilter = (process.env.TEAM_FILTER || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (teamFilter.length === 0) {
    // No filter configured: return whatever's live, as before.
    const rawMatches = await fetchCurrentMatchesPage(0);
    return normalizeMatches(rawMatches.filter((m) => m.matchStarted && !m.matchEnded));
  }

  // If we've already locked onto a match, just refresh that one match directly.
  if (lockedMatchId) {
    try {
      const match = await fetchMatchInfo(lockedMatchId);
      return normalizeMatches([match]);
    } catch (err) {
      console.error(`Locked match ${lockedMatchId} lookup failed, re-searching:`, err.message);
      lockedMatchId = null; // fall through to re-search below
    }
  }

  // Search across a few pages of currentMatches for a match involving all
  // filter terms (e.g. both "india" and "sri lanka" must appear in the teams).
  const MAX_PAGES = 4; // 4 pages x 25 = up to 100 matches checked per search
  for (let page = 0; page < MAX_PAGES; page++) {
    const rawMatches = await fetchCurrentMatchesPage(page * 25);
    if (rawMatches.length === 0) break; // no more pages

    const found = rawMatches.find((m) => {
      const teamNames = (m.teams || []).join(" ").toLowerCase();
      return teamFilter.every((term) => teamNames.includes(term));
    });

    if (found) {
      lockedMatchId = found.id;
      console.log(`Locked onto match: ${found.name} (id: ${found.id})`);
      return normalizeMatches([found]);
    }
  }

  console.warn(`No match found for TEAM_FILTER="${teamFilter.join(",")}" across ${MAX_PAGES} pages.`);
  return [];
}

async function fetchCurrentMatchesPage(offset) {
  const url = `${BASE_URL}/currentMatches?apikey=${process.env.CRICKETDATA_API_KEY}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`CricketData API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(`CricketData API returned non-success status: ${JSON.stringify(data)}`);
  }
  return data.data || [];
}

async function fetchMatchInfo(matchId) {
  const url = `${BASE_URL}/match_info?apikey=${process.env.CRICKETDATA_API_KEY}&id=${matchId}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`CricketData match_info error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(`CricketData match_info returned non-success status: ${JSON.stringify(data)}`);
  }
  return data.data;
}

/**
 * Normalizes CricAPI's raw response into the flat shape the rest of the app expects.
 */
function normalizeMatches(rawMatches) {
  return rawMatches.map((m) => {
    const [team1, team2] = m.teams && m.teams.length === 2 ? m.teams : ["Team A", "Team B"];

    const innings = (m.score || []).map((s) => ({
      team: s.inning ? s.inning.replace(/ Inning \d+$/i, "") : "Unknown",
      score: s.r,
      wickets: s.w,
      overs: s.o,
      inningLabel: s.inning,
    }));

    let status = "Not Started";
    if (m.matchStarted && !m.matchEnded) status = "Live";
    if (m.matchEnded) status = "Finished";

    return {
      matchId: m.id,
      matchType: m.matchType,
      team1,
      team2,
      venue: m.venue || "Unknown venue",
      status,
      note: m.status || null,
      innings,
      fingerprint:
        innings.map((i) => `${i.inningLabel}:${i.score}/${i.wickets}(${i.overs})`).join("|") + `|${status}|${m.status}`,
    };
  });
}
