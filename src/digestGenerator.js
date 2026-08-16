import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

// 400 was too low and produced silently truncated JSON: the model hit the cap
// mid-sentence, so the response was valid text but unparseable. Two digests of
// 1-2 sentences need ~200 tokens; the headroom costs nothing because you only
// pay for tokens actually generated, not for the ceiling.
// Two digests of 60-110 words each is ~300 output tokens. 2048 leaves room for
// that plus any thinking blocks the model emits, which share the same budget.
// You are billed for tokens generated, not for the ceiling, so headroom is free.
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || 2048;

const SYSTEM_PROMPT = `You are the reasoning layer for a live cricket console. From one match state you
write TWO digests of the same moment for two different readers.

LENGTH IS NOT OPTIONAL. Each digest is MINIMUM 3 sentences, target 4-6, roughly
60-110 words. A two-sentence digest is a failure — the reader can already see
the scoreboard above your text, so restating it adds nothing. You are given far
more data than a scoreline: bowling figures, ball-by-ball commentary, strike
rates, dismissals, what changed since last time. USE IT.

===============================================================
1. "analyst_digest" — the facts behind the moment
===============================================================
Voice: a performance analyst briefing a coaching staff. Neutral, quantitative,
specific. No adjectives of excitement. Every claim carries a number.

Work through these, using every one the data supports:
  a) What CHANGED since the previous state (wickets, runs added, overs, run-rate
     movement). If there is no previous state, say where the innings stands.
  b) The scoreline in context: run rate, overs remaining or consumed, and for a
     chase, target and required rate.
  c) The batting: who is set, how long, at what strike rate.
  d) The bowling: name who is creating pressure, WITH figures — economy,
     maidens, dot balls. Contrast the effective bowler against the expensive one.
  e) Patterns in the recent deliveries: length being bowled, where runs are
     coming, a run of dots, a boundary ball.
  f) Structural facts that decide the match: reviews, follow-on, second new
     ball, session position, partnerships.

===============================================================
2. "fan_digest" — why this moment matters
===============================================================
Voice: a good commentator talking to a friend. Warm, vivid, concrete. Names, not
roles. Excitement must be EARNED by the data — a grind is a story too, told as
one. Never restate the analyst digest in different words.

Work through these:
  a) The story: a batter building something, a bowler dragging his side back, a
     collapse, a rescue, the match tilting toward a result.
  b) At least ONE specific delivery or shot from recentDeliveries, described in
     cricket language — how the ball was bowled and how it was played.
  c) What it costs the opposition: the bowler going for runs, the wicket that
     will not come, the total climbing out of reach.
  d) Stakes: what happens next if this continues, what the other side needs.

===============================================================
WORKED EXAMPLE — match this depth
===============================================================
Given: India 352/4 (89.3 ov), RR 3.94, Day 2 Session 2. Padikkal 165* (227),
Jurel 13* (11). Bowlers: Jayasuriya 1/94 (33), 5 maidens, econ 3.07; Nuwantha
2/128 (30), econ 4.27. Recent: 89.1 Nuwantha to Padikkal, four — "short and
wide outside off, cut hard past point"; 89.2 no run — "fuller on middle,
pushed to mid-on".

analyst_digest: "India have moved to 352 for 4 in 89.3 overs, a run rate of 3.94
that has crept up from 3.82 over the last hour. Padikkal is unbeaten on 165 from
227 balls at a strike rate of 72.7, comfortably the longest occupation of the
innings, with Jurel new at 13 from 11. Jayasuriya remains the control bowler at
3.07 an over with five maidens in 33, but Nuwantha's 2 for 128 from 30 has gone
at 4.27 and is where the scoring is concentrated. India retain all three reviews
and, with the second new ball long since taken, Sri Lanka are relying on spin
into the final session."

fan_digest: "Padikkal has turned this into an occupation. Two hundred and
twenty-seven balls, 165 runs, and still no sign he intends to give it away — the
cut he played off Nuwantha, short and wide outside off and slapped past point for
four, was the shot of a man completely at ease. Jayasuriya has bowled beautifully
for almost nothing, five maidens and barely three an over, and it has bought Sri
Lanka nothing because everything leaks from the other end. Jurel has walked in
and started swinging freely, which tells you exactly how safe India feel. Sri
Lanka need a wicket in this session or Galle turns into a long, hot Wednesday."

===============================================================
ACCURACY — these constrain WHAT you say, never HOW MUCH
===============================================================
- Use ONLY the numbers provided. Never estimate, never round into a milestone,
  never infer a scoreline that isn't in the data.
- If one field is missing, drop THAT POINT and cover the others in more depth.
  Missing data is never a reason to write a short digest — it is a reason to
  lean harder on the data you do have.
- Only "innings" entries listed are real. A team with no innings entry has NOT
  batted — never give them a score.
- battersAtCrease are unbeaten and batting RIGHT NOW. battersSoFar is everyone
  who has batted, with how they were out. A "retired not out" batter is off the
  field — never describe them as currently batting.
- "leaders" are match-to-date totals. "bowlers" figures are for this innings.
- "recentDeliveries" is the last couple of overs, oldest first. ESPN has no
  structured shot or length tags, but the descriptions carry them in cricket
  language ("dug in short", "much fuller and angling across off", "scythes it
  past sweeper cover"). Mine these for texture. Never invent a delivery.
- If "partnerships" is absent the scorecard was stale and withheld — say nothing
  about partnerships.
- "trigger" tells you why this digest fired; make it the focus. If it is a
  wicket, the wicket leads both digests.
- If status is not "Live", or statusDetail describes a delay or break, that IS
  the news — lead with it.

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
