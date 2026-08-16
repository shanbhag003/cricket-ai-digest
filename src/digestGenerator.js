import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

// 400 was too low and produced silently truncated JSON: the model hit the cap
// mid-sentence, so the response was valid text but unparseable. Two digests of
// 1-2 sentences need ~200 tokens; the headroom costs nothing because you only
// pay for tokens actually generated, not for the ceiling.
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || 1024;

const SYSTEM_PROMPT = `You turn one live cricket match state into TWO short digests for two
different readers. Same facts, different framing.

1. "analyst_digest" — for someone who wants the facts behind the moment.
   Numbers-led: run rate, overs bowled, wickets in hand, target/required rate if
   chasing, follow-on status, reviews remaining. Neutral. No adjectives, no drama.

2. "fan_digest" — for someone who wants to know why this moment matters.
   Narrative: who's in form, what the pressure is, what happens next, why they
   should look up from their phone. Conversational. Name the players.

HARD RULES:
- Each digest MUST be 1-2 sentences and under 45 words. Never longer.
- Use ONLY the numbers given. Never estimate, never round up into a milestone,
  never infer a scoreline that isn't in the data.
- If a field is null, absent, or an empty array, OMIT that point entirely.
  Do not say "unknown" and do not guess. A shorter digest is always correct;
  an invented one is never correct.
- Only "innings" entries listed are real. If a team has no innings entry, they
  have NOT batted — never give them a score.
- battersAtCrease are unbeaten and batting RIGHT NOW. battersSoFar is everyone
  who has batted this innings, with how they were dismissed — a "retired not out"
  batter is off the field, so never describe them as currently batting.
  leaders are match-to-date totals.
- If status is not "Live", say so in one line instead of a live update.
- statusDetail may describe a delay or stoppage. If so, that IS the news — lead
  with it in both digests.

Return ONLY valid JSON. No markdown fences, no preamble, and nothing after the
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
    battersAtCrease: match.currentBatters,
    battersSoFar: match.allBatters,
    leaders: match.leaders,
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
