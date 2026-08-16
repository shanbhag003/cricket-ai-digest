import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// ESPN public cricket endpoints (unofficial, no key).
//
// TWO-TIER POLLING:
//   1. scoreboard endpoint  (~6 KB)   -> polled often, just to detect change
//   2. summary endpoint     (~271 KB) -> fetched ONLY when tier 1 changed
//
// All field paths below were verified against a real live Test match payload,
// not guessed.
// ---------------------------------------------------------------------------

let locked = null; // { leagueId, eventId, leagueName }
let lastCheapFingerprint = null;

const HEADER_URL =
  "https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket&region=in&tz=Asia/Calcutta";

async function getJson(url, label) {
  const res = await fetch(url, {
    headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" },
    signal: AbortSignal.timeout(15000), // don't let ESPN stall the poll loop
  });
  if (!res.ok) throw new Error(`${label} failed (${res.status})`);
  return res.json();
}

// --- tier 0: find the match ------------------------------------------------

async function lockOntoMatch() {
  const terms = (process.env.TEAM_FILTER || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const header = await getJson(HEADER_URL, "ESPN header");
  const sport = (header.sports || []).find(
    (s) => s.slug === "cricket" || s.uid?.includes("cricket")
  );

  const candidates = [];
  for (const league of sport?.leagues || []) {
    for (const event of league.events || []) candidates.push({ league, event });
  }

  // Match team names against BOTH series name and event name. Series name
  // alone is fragile — "The Hundred Men's Competition" has no team names in it.
  const scored = candidates.filter(({ league, event }) => {
    if (terms.length === 0) return true;
    const hay = `${league.name || ""} ${event.name || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });

  // Prefer a match actually in progress over a finished one.
  const stateOf = (e) => e.status?.state || e.status?.type?.state || e.state;
  const chosen = scored.find(({ event }) => stateOf(event) === "in") || scored[0];

  if (!chosen) {
    console.warn(`No ESPN cricket match matched TEAM_FILTER="${terms.join(",")}"`);
    return null;
  }

  locked = {
    leagueId: chosen.league.id,
    eventId: chosen.event.id,
    leagueName: chosen.league.name,
  };
  console.log(
    `Locked onto: ${chosen.league.name} — ${chosen.event.name} ` +
      `(league ${locked.leagueId}, event ${locked.eventId})`
  );
  return locked;
}

// --- tier 1: cheap change check (~6 KB) ------------------------------------

async function fetchCheapState() {
  const url = `https://site.api.espn.com/apis/site/v2/sports/cricket/${locked.leagueId}/scoreboard`;
  const data = await getJson(url, "ESPN scoreboard");

  const event = (data.events || []).find((e) => e.id === String(locked.eventId));
  if (!event) return null;

  const comp = (event.competitions || [])[0] || {};
  const parts = (comp.competitors || []).flatMap((c) =>
    (c.linescores || []).map(
      (ls) =>
        `${c.team?.abbreviation || c.id}#${ls.period}:${ls.runs}/${ls.wickets}@${ls.overs}`
    )
  );
  return {
    fingerprint: parts.join("|") + "|" + (comp.status?.type?.state || ""),
    state: comp.status?.type?.state,
  };
}

// --- tier 2: the rich payload (~271 KB) ------------------------------------

async function fetchSummary() {
  const url =
    `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${locked.leagueId}` +
    `/summary?contentorigin=espn&event=${locked.eventId}&lang=en&region=in`;
  return getJson(url, "ESPN summary");
}

/**
 * Returns [] when nothing changed since last call, so the caller never burns
 * a Claude call on a no-op. Pass { force: true } to bypass (e.g. on startup).
 */
export async function getLiveMatches({ force = false } = {}) {
  if (!locked && !(await lockOntoMatch())) return [];

  let cheap;
  try {
    cheap = await fetchCheapState();
  } catch (err) {
    console.error("Cheap poll failed, re-locking:", err.message);
    locked = null;
    return [];
  }

  if (!cheap) {
    locked = null; // event fell off the scoreboard — re-find next tick
    return [];
  }

  if (!force && cheap.fingerprint === lastCheapFingerprint) return [];
  lastCheapFingerprint = cheap.fingerprint;

  return [normalizeMatch(await fetchSummary())];
}

// --- normalisation ---------------------------------------------------------

function normalizeMatch(summary) {
  const header = summary.header || {};
  const comp = (header.competitions || [])[0] || {};
  const competitors = comp.competitors || [];
  const status = comp.status || {};
  const type = status.type || {};

  const state = type.state; // "pre" | "in" | "post"
  const statusLabel =
    state === "in" ? "Live" : state === "post" ? "Finished" : "Not Started";

  // linescores is the CORRECT source for runs/wickets/overs.
  // matchcards is Batting/Bowling/Partnerships cards for ONE innings — not an
  // innings list. Using it produced phantom innings and all-null scores.
  const innings = [];
  for (const c of competitors) {
    const team = c.team?.displayName || c.team?.name || `Team ${c.id}`;
    for (const ls of c.linescores || []) {
      // ESPN mirrors the BOWLING overs into the non-batting side's linescore,
      // so a team that hasn't batted shows up as "0/0 (73 ov)". Drop those —
      // otherwise Claude confidently reports a scoreline that never happened.
      const hasBatted = ls.runs > 0 || ls.wickets > 0 || ls.isBatting;
      if (!hasBatted) continue;
      innings.push({
        team,
        inningsNumber: ls.period,
        runs: ls.runs,
        wickets: ls.wickets,
        overs: ls.overs,
        score: ls.score || `${ls.runs}/${ls.wickets} (${ls.overs} ov)`,
        isBatting: Boolean(ls.isBatting),
        runRate: ls.overs ? +(ls.runs / ls.overs).toFixed(2) : null,
        target: ls.target || null,
        followOn: Boolean(ls.followOn),
        reviewsLeft: ls.reviews?.remaining ?? null,
      });
    }
  }

  // Current batters, from the batting card (typeID "11").
  const battingCard = (summary.matchcards || []).find((c) => c.typeID === "11");
  const currentBatters = (battingCard?.playerDetails || [])
    .filter((p) => p.dismissal === "not out" && p.runs !== "")
    .map((p) => ({
      name: p.playerName,
      runs: Number(p.runs),
      balls: Number(p.ballsFaced),
      fours: Number(p.fours),
      sixes: Number(p.sixes),
    }));

  // leaders is nested 4 levels deep. Flatten properly.
  const leaders = [];
  for (const teamBlock of summary.leaders || []) {
    const teamName = teamBlock.team?.displayName;
    for (const ls of teamBlock.linescores || []) {
      for (const cat of ls.leaders || []) {
        for (const l of cat.leaders || []) {
          if (!l.athlete?.displayName) continue;
          leaders.push({
            team: teamName,
            category: cat.displayName || cat.name,
            name: l.athlete.displayName,
            value: l.displayValue,
          });
        }
      }
    }
  }

  const noteOf = (t) => (summary.notes || []).find((n) => n.type === t)?.text;

  return {
    matchId: String(header.id || comp.id),
    seriesName: header.league?.name || (header.leagues || [])[0]?.name || null,
    matchFormat: comp.class?.description || noteOf("matchnumber") || null,
    team1: competitors[0]?.team?.displayName || "Team A",
    team2: competitors[1]?.team?.displayName || "Team B",

    // venue lives on gameInfo — competition.venue is null
    venue: summary.gameInfo?.venue?.fullName || "Unknown venue",
    city: summary.gameInfo?.venue?.address?.city || null,

    status: statusLabel,
    // type.detail is just "Live"; real context is in description + status.summary
    statusDetail: type.description || type.shortDetail || null,
    tossNote: status.summary || noteOf("toss") || null,
    session: status.session || null, // e.g. "Day 2"

    innings,
    currentBatters,
    leaders,

    fingerprint:
      innings
        .map((i) => `${i.team}#${i.inningsNumber}:${i.runs}/${i.wickets}@${i.overs}`)
        .join("|") + `|${statusLabel}|${type.description || ""}`,
  };
}

/**
 * Should we spend a Claude call on this change?
 * Runs ticking up by 2 is not news. A wicket is.
 */
export function isMaterialChange(prev, next) {
  if (!prev) return true;
  if (prev.status !== next.status) return true;
  if (prev.statusDetail !== next.statusDetail) return true; // rain delay etc.
  if (prev.innings.length !== next.innings.length) return true; // new innings

  const cur = next.innings.find((i) => i.isBatting);
  const old = prev.innings.find((i) => i.isBatting);
  if (!cur || !old) return true;

  if (cur.wickets !== old.wickets) return true;                              // wicket
  if (cur.followOn !== old.followOn) return true;                            // follow-on enforced
  if (cur.target !== old.target) return true;                                // chase target set
  if (Math.floor(cur.runs / 50) !== Math.floor(old.runs / 50)) return true;  // team 50
  if (Math.floor(cur.overs / 10) !== Math.floor(old.overs / 10)) return true; // 10 overs

  for (const b of next.currentBatters) {
    const before = prev.currentBatters.find((p) => p.name === b.name);
    if (!before) return true;
    if (Math.floor(b.runs / 50) !== Math.floor(before.runs / 50)) return true; // 50/100
  }
  return false;
}
