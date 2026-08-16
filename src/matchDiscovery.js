// ---------------------------------------------------------------------------
// Discovers what cricket is on, from ESPN's header endpoint.
//
// SCOPE — be honest about this in the UI: the header endpoint covers roughly a
// 3-day window around now (live, today's remaining fixtures, and matches that
// just finished). It is NOT a season calendar. There is no ESPN endpoint that
// lists future series which aren't already in progress, so a "what's on in
// September" view is not buildable from this source.
// ---------------------------------------------------------------------------

const HEADER_URL =
  "https://site.api.espn.com/apis/personalized/v2/scoreboard/header?sport=cricket&region=in&tz=Asia/Calcutta";

const HEADERS = { "User-Agent": "curl/8.5.0", Accept: "*/*" };

let cache = { at: 0, data: null };
const CACHE_MS = 60_000; // the list barely changes; don't hammer ESPN per page load

/** ISO UTC -> "16 Aug, 14:00 IST" */
function toIST(iso) {
  if (!iso) return null;
  return (
    new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

export async function listMatches({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const res = await fetch(HEADER_URL, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ESPN header failed (${res.status})`);
  const body = await res.json();

  const sport = (body.sports || []).find(
    (s) => s.slug === "cricket" || s.uid?.includes("cricket")
  );

  const matches = [];
  for (const league of sport?.leagues || []) {
    for (const event of league.events || []) {
      const cls = event.class || {};
      const state = event.status?.state || event.fullStatus?.type?.state || "pre";

      // internationalClassId: "0" = domestic, anything else = international
      // (1 = Test, 2 = ODI, 3 = T20I). Verified against live data.
      const isInternational =
        String(cls.internationalClassId || "0") !== "0";

      matches.push({
        leagueId: league.id,
        eventId: event.id,
        seriesName: league.name,
        matchName: event.name,
        shortName: event.shortName,
        format: cls.generalClassCard || cls.name || "Match",
        level: isInternational ? "International" : "Domestic",
        isTournament: Boolean(league.isTournament),
        location: event.location || null,
        startUTC: event.date,
        startIST: toIST(event.date),
        state, // "pre" | "in" | "post"
        statusLabel:
          state === "in" ? "Live" : state === "post" ? "Finished" : "Scheduled",
        summary: event.summary || null,
      });
    }
  }

  // Live first, then upcoming by start time, then finished.
  const rank = { in: 0, pre: 1, post: 2 };
  matches.sort(
    (a, b) =>
      (rank[a.state] ?? 3) - (rank[b.state] ?? 3) ||
      new Date(a.startUTC) - new Date(b.startUTC)
  );

  const data = {
    fetchedAt: new Date().toISOString(),
    counts: {
      live: matches.filter((m) => m.state === "in").length,
      scheduled: matches.filter((m) => m.state === "pre").length,
      finished: matches.filter((m) => m.state === "post").length,
      international: matches.filter((m) => m.level === "International").length,
      domestic: matches.filter((m) => m.level === "Domestic").length,
    },
    windowNote:
      "ESPN's feed covers roughly a 3-day window around now. Future fixtures beyond that are not available.",
    matches,
  };

  cache = { at: Date.now(), data };
  return data;
}
