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
 * Point the poller at a specific match, chosen at runtime (e.g. from the
 * dashboard dropdown) instead of via TEAM_FILTER. Resets the cheap fingerprint
 * so the next poll definitely fetches fresh state for the new match.
 */
export function setTrackedMatch({ leagueId, eventId, leagueName }) {
  locked = { leagueId: String(leagueId), eventId: String(eventId), leagueName };
  lastCheapFingerprint = null;
  console.log(`Tracking switched to league ${leagueId}, event ${eventId}`);
  return locked;
}

export function getTrackedMatch() {
  return locked;
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
    matchFormat: comp.class?.generalClassCard || comp.class?.name || noteOf("matchnumber") || null,
    // eventType is ESPN's clean discriminator: "Test" | "T20" | "ODI".
    // limitedOvers is the fallback when eventType is missing.
    formatKey: detectFormat(comp),
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

    // ESPN lists fixtures it doesn't actually score. Associate and lower-tier
    // matches often come back state="in" with linescores: [] and
    // liveAvailable: false — the match is on, ESPN just isn't covering it.
    // Verified: liveAvailable is true for matches with real data, false here.
    hasScorecard: innings.length > 0,
    liveDataAvailable: Boolean(comp.liveAvailable),

    fingerprint:
      innings
        .map((i) => `${i.team}#${i.inningsNumber}:${i.runs}/${i.wickets}@${i.overs}`)
        .join("|") + `|${statusLabel}|${type.description || ""}`,
  };
}

// ---------------------------------------------------------------------------
// Format-aware materiality
//
// What counts as "worth a Claude call" depends entirely on the format. Fifty
// runs is an hour's grind in a Test and five overs in a T20. Over 10 is a
// routine marker in a Test and the halfway point of a T20 innings.
//
// keyOvers are the moments that matter in that format specifically, and they
// don't fall on a regular step: the powerplay ends at 6 in a T20, the death
// begins at 16, ODI fielding restrictions change at 10 and 40, and the second
// new ball is available at 80 in a Test.
// ---------------------------------------------------------------------------

export const FORMAT_RULES = {
  test: {
    label: "Test / first-class",
    teamRunStep: 50,
    overStep: 10,
    batterRunStep: 50,
    keyOvers: [80],            // second new ball available
    minGapSeconds: 180,
  },
  odi: {
    label: "ODI / List A",
    teamRunStep: 50,
    overStep: 10,
    batterRunStep: 50,
    keyOvers: [10, 40],        // powerplay end, death overs begin
    minGapSeconds: 120,
  },
  t20: {
    label: "T20",
    teamRunStep: 50,
    overStep: 5,
    batterRunStep: 50,
    keyOvers: [6, 16],         // powerplay end, death overs begin
    minGapSeconds: 90,
  },
};

/** ESPN competition object -> "test" | "odi" | "t20" */
function detectFormat(comp) {
  const t = (comp?.class?.eventType || "").toUpperCase();
  if (t === "TEST") return "test";
  if (t === "T20") return "t20";
  if (t === "ODI") return "odi";

  const card = (comp?.class?.generalClassCard || comp?.class?.name || "").toLowerCase();
  if (card.includes("test") || card.includes("first-class")) return "test";
  if (card.includes("t20") || card.includes("twenty20") || card.includes("hundred")) return "t20";
  if (card.includes("od") || card.includes("list a") || card.includes("one-day")) return "odi";

  return comp?.limitedOvers === false ? "test" : "odi";
}

export function getFormatRules(match) {
  return FORMAT_RULES[match?.formatKey] || FORMAT_RULES.odi;
}

/** Did we pass one of the format's landmark overs since last poll? */
function crossedKeyOver(prevOvers, curOvers, keyOvers) {
  return keyOvers.some((k) => prevOvers < k && curOvers >= k);
}

/**
 * Should we spend a Claude call on this change?
 * Runs ticking up by 2 is not news. A wicket is.
 *
 * Returns null when nothing material happened, otherwise a short reason string.
 * Truthy/falsy semantics are unchanged, so `if (!isMaterialChange(...))` still
 * works — but the reason lets us label the digest and read the logs.
 */
export function isMaterialChange(prev, next) {
  if (!prev) return "first-sighting";
  if (prev.status !== next.status) return "status";
  if (prev.statusDetail !== next.statusDetail) return "status-detail";
  if (prev.innings.length !== next.innings.length) return "innings";

  const cur = next.innings.find((i) => i.isBatting);
  const old = prev.innings.find((i) => i.isBatting);
  if (!cur || !old) return "innings";

  const r = getFormatRules(next);

  if (cur.wickets !== old.wickets) return "wicket";
  if (cur.followOn !== old.followOn) return "follow-on";
  if (cur.target !== old.target) return "target";

  for (const b of next.currentBatters) {
    const before = prev.currentBatters.find((p) => p.name === b.name);
    if (!before) return "new-batter";
    if (Math.floor(b.runs / r.batterRunStep) !== Math.floor(before.runs / r.batterRunStep)) {
      return "batter-milestone";
    }
  }

  if (Math.floor(cur.runs / r.teamRunStep) !== Math.floor(old.runs / r.teamRunStep)) {
    return "team-milestone";
  }
  if (crossedKeyOver(old.overs, cur.overs, r.keyOvers)) return "key-over";
  if (Math.floor(cur.overs / r.overStep) !== Math.floor(old.overs / r.overStep)) {
    return "over-mark";
  }
  return null;
}
