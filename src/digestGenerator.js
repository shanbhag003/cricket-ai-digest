import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

// 400 was too low and produced silently truncated JSON: the model hit the cap
// mid-sentence, so the response was valid text but unparseable. Two digests of
// 1-2 sentences need ~200 tokens; the headroom costs nothing because you only
// pay for tokens actually generated, not for the ceiling.
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || 1024;

const SYSTEM_PROMPT = `You are the reasoning layer for a live cricket console. From one match state you
write TWO digests of the same moment for two different readers. Same facts, two
different jobs.

===============================================================
1. "analyst_digest" — for a reader who wants the facts behind the moment
===============================================================
Write like a performance analyst briefing a coaching staff. 3-5 sentences.

Lead with what CHANGED since the previous state, if a previous state is given —
wickets lost, runs added, overs consumed. That delta is the news; the raw total
is just context.

Then build the picture using whatever the data supports:
- Scoreline, overs, run rate. If chasing: target, required rate, balls left.
- The batting: who is set, their strike rates, how long they have been in.
- The bowling: who has done the damage, economy, maidens, spells. Name the
  bowler who is actually creating pressure, with figures.
- Structural facts that decide the game: reviews remaining, follow-on, the
  second new ball, partnerships that shaped the innings.

Rules of voice: neutral, specific, quantitative. No adjectives of excitement.
Every claim carries a number. Never a bare scoreboard readout — a reader can see
the score already; tell them what it MEANS. If run rate has moved, say by how
much. If a bowler is containing, give the economy that proves it.

===============================================================
2. "fan_digest" — for a reader who wants to know why this moment matters
===============================================================
Write like a good commentator talking to a friend. 3-5 sentences.

Find the story in the data and tell it. The story is usually one of:
- A batter building something (how long, how hard, what it's worth)
- A bowler dragging their side back into it
- A collapse or a rescue in progress
- The match tilting toward a result, or drifting away from one
- Pressure: a chase falling behind, wickets in hand running out, a new ball due

Use names, not roles. Use concrete images grounded in the numbers — 216 balls of
graft, five maidens, 121 runs conceded for two. Convey stakes: what happens next
if this continues, what the other side needs.

Rules of voice: warm, vivid, conversational. Excitement must be EARNED by the
data — do not manufacture drama for a quiet passage of play; a grind is a story
too, tell it as one. Never repeat the analyst digest in different words: the
analyst says what is happening, you say why anyone should care.

===============================================================
ACCURACY — these override everything above
===============================================================
- Use ONLY the numbers provided. Never estimate, never round into a milestone,
  never infer a scoreline that isn't in the data.
- If a field is null, absent, or an empty array, OMIT that point entirely. Do not
  say "unknown". A shorter digest is always correct; an invented one never is.
- Only "innings" entries listed are real. A team with no innings entry has NOT
  batted — never give them a score.
- battersAtCrease are unbeaten and batting RIGHT NOW. battersSoFar is everyone
  who has batted, with how they were out. A "retired not out" batter is off the
  field — never describe them as currently batting.
- "leaders" are match-to-date totals. "bowlers" figures are for this innings.
- "recentDeliveries" is the last couple of overs, ball by ball, oldest first.
  ESPN gives no structured shot or length tags, but the descriptions contain
  them in cricket language ("dug in short", "much fuller and angling across
  off", "scythes it away past sweeper"). Mine these for texture: the fan digest
  should reach for a specific delivery or shot rather than describing the
  innings in the abstract, and the analyst digest can cite the pattern they
  show (a bowler's length, a batter's scoring areas, a run of dots). Quote the
  cricket, never the raw string. Never invent a delivery that isn't listed.
- If "partnerships" is absent, the scorecard was stale and was withheld — say
  nothing about partnerships rather than guessing.
- If "previous" is absent, this is the first digest: describe the state as it
  stands instead of describing a change.
- "trigger" tells you why this digest fired. Make it the focus. If the trigger
  is a wicket, the wicket leads both digests.
- If status is not "Live", say so plainly instead of writing a live update.
- statusDetail may describe a delay, stoppage or session break. If so, that IS
  the news — lead with it in both digests.

Return ONLY valid JSON. No markdown fences, no preamble, nothing after the
closing brace:
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

/**
 * Pull the two digests out of a model response.
 * Handles clean JSON, markdown-fenced JSON, and JSON truncated mid-string by a
 * max_tokens cutoff — in the truncated case we recover whatever complete field
 * is present rather than throwing the whole response away.
 */
export function parseDigest(raw) {
  const text = String(raw || "").replace(/```json|```/g, "").trim();

  // 1. the normal path
  try {
    const j = JSON.parse(text);
    if (j.analyst_digest && j.fan_digest) return { ...j, salvaged: false };
  } catch {
    /* fall through to salvage */
  }

  // 2. salvage: grab any complete "key": "value" pair. A truncated field has no
  //    closing quote, so it simply won't match and is treated as missing.
  const pick = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim() : null;
  };

  const analyst = pick("analyst_digest");
  const fan = pick("fan_digest");
  if (analyst && fan) {
    return { analyst_digest: analyst, fan_digest: fan, salvaged: true };
  }
  return null;
}

// Prefilling the assistant turn with "{" removes any chance of a preamble
// before the JSON. But the API rejects assistant prefill when extended thinking
// is enabled, so if that's rejected we transparently fall back to no prefill.
let usePrefill = true;

async function callClaude(payload, { maxTokens, terse }) {
  const userContent =
    `Match state:\n${JSON.stringify(payload, null, 2)}` +
    (terse
      ? `\n\nYour previous reply was cut off because it was too long. ` +
        `Reply again, much shorter: ONE sentence per digest, under 30 words each. ` +
        `Output only the JSON object.`
      : "");

  const send = async (prefill) => {
    const messages = [{ role: "user", content: userContent }];
    if (prefill) messages.push({ role: "assistant", content: "{" });
    return anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages,
    });
  };

  let res;
  let prefilled = usePrefill;
  try {
    res = await send(prefilled);
  } catch (err) {
    const msg = String(err?.message || "");
    const prefillRejected =
      /thinking/i.test(msg) ||
      /final assistant/i.test(msg) ||
      /assistant.*prefill/i.test(msg) ||
      /prefill/i.test(msg);
    if (!prefilled || !prefillRejected) throw err;
    console.warn("Assistant prefill rejected — falling back without it.");
    usePrefill = false; // remember for the rest of the process
    prefilled = false;
    res = await send(false);
  }

  const text = res.content.find((b) => b.type === "text")?.text;
  const thinking = res.content.find((b) => b.type === "thinking");
  return {
    // the prefilled "{" is not echoed back, so put it back before parsing
    text: text ? (prefilled ? "{" + text : text) : null,
    stopReason: res.stop_reason,
    usage: res.usage,
    hadThinking: Boolean(thinking),
  };
}

/** What actually changed since the last digest — the news, not the totals. */
function buildDelta(match, previous) {
  if (!previous) return undefined;
  const cur = match.innings.find((i) => i.isBatting);
  const old = previous.innings?.find((i) => i.isBatting);
  if (!cur || !old) return undefined;

  const out = {
    previousScore: old.score,
    runsAdded: cur.runs - old.runs,
    wicketsLost: cur.wickets - old.wickets,
    oversBowled: +(cur.overs - old.overs).toFixed(1),
  };
  if (old.runRate != null && cur.runRate != null) {
    out.runRateMovedBy = +(cur.runRate - old.runRate).toFixed(2);
  }
  const goneNames = (previous.currentBatters || [])
    .filter((b) => !(match.currentBatters || []).some((c) => c.name === b.name))
    .map((b) => `${b.name} ${b.runs}(${b.balls})`);
  if (goneNames.length) out.leftTheCreaseSince = goneNames;
  return out;
}

export async function generateDigest(match, context = {}) {
  const { reason, previous, deliveries } = context;

  const payload = compact({
    trigger: reason || undefined,
    changedSinceLastDigest: buildDelta(match, previous),
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
    battersAtCrease: match.currentBatters,
    battersSoFar: match.allBatters,
    bowlers: match.bowlers,
    partnerships: match.partnerships,
    leaders: match.leaders,
    recentDeliveries: deliveries && deliveries.length ? deliveries : undefined,
  });

  let attempt = await callClaude(payload, { maxTokens: MAX_TOKENS, terse: false });

  if (attempt.text) {
    const parsed = parseDigest(attempt.text);
    if (parsed && attempt.stopReason !== "max_tokens") return parsed;

    // Truncated. Retry once, asking for something shorter and allowing more room.
    if (attempt.stopReason === "max_tokens") {
      console.warn(
        `Digest hit max_tokens (${MAX_TOKENS}) — retrying with a shorter target.` +
          (attempt.hadThinking
            ? " Response included thinking blocks, which consume the same budget;" +
              " raise CLAUDE_MAX_TOKENS or use claude-haiku-4-5-20251001."
            : "")
      );
      const retry = await callClaude(payload, {
        maxTokens: MAX_TOKENS * 2,
        terse: true,
      });
      const retryParsed = retry.text ? parseDigest(retry.text) : null;
      if (retryParsed) return retryParsed;

      // Last resort: use whatever survived from either attempt.
      if (parsed) {
        console.warn("Retry failed too — using the salvaged first response.");
        return parsed;
      }
      throw new Error(
        `Claude's reply was cut off at ${MAX_TOKENS} tokens twice. ` +
          `Raise CLAUDE_MAX_TOKENS.`
      );
    }
  }

  throw new Error(
    `Could not read Claude's response (stop_reason=${attempt.stopReason}): ` +
      `${String(attempt.text).slice(0, 200)}`
  );
}
