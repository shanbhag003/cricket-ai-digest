import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// claude-sonnet-5 is cheaper AND better than the old sonnet-4-6.
// For this task (JSON in, two sentences out) claude-haiku-4-5-20251001 is
// plenty and costs half as much — swap via the MODEL env var.
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const SYSTEM_PROMPT = `You turn one live cricket match state into TWO short digests for two
different readers. Same facts, different framing.

1. "analyst_digest" — for someone who wants the facts behind the moment.
   Numbers-led: run rate, overs bowled, wickets in hand, target/required rate if
   chasing, follow-on status, reviews remaining. Neutral. No adjectives, no drama.

2. "fan_digest" — for someone who wants to know why this moment matters.
   Narrative: who's in form, what the pressure is, what happens next, why they
   should look up from their phone. Conversational. Name the players.

HARD RULES:
- 1-2 sentences each. Plain English.
- Use ONLY the numbers given. Never estimate, never round up into a milestone,
  never infer a scoreline that isn't in the data.
- If a field is null, absent, or an empty array, OMIT that point entirely.
  Do not say "unknown" and do not guess. A shorter digest is always correct;
  an invented one is never correct.
- Only "innings" entries listed are real. If a team has no innings entry, they
  have NOT batted — never give them a score.
- currentBatters are unbeaten right now. leaders are match-to-date totals.
- If status is not "Live", say so in one line instead of a live update.
- statusDetail may describe a delay or stoppage. If so, that IS the news — lead
  with it in both digests.

Return ONLY valid JSON. No markdown fences, no preamble:
{"analyst_digest": string, "fan_digest": string}`;

/** Strip keys that are null/undefined/empty so the model never sees a blank slot. */
function compact(value) {
  if (Array.isArray(value)) {
    const arr = value.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === null || value === "" || value === false) return undefined;
  return value;
}

export async function generateDigest(match) {
  const payload = compact({
    match: `${match.team1} vs ${match.team2}`,
    series: match.seriesName,
    format: match.matchFormat,
    venue: match.venue,
    city: match.city,
    status: match.status,
    statusDetail: match.statusDetail,
    session: match.session,
    toss: match.tossNote,
    innings: match.innings,
    currentBatters: match.currentBatters,
    leaders: match.leaders,
  });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Match state:\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No text content in Claude response");

  const cleaned = text.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
  if (!parsed.analyst_digest || !parsed.fan_digest) {
    throw new Error(`Claude JSON missing a digest field: ${cleaned.slice(0, 200)}`);
  }
  return parsed;
}
