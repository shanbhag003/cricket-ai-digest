import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a data-to-briefing layer for live cricket. You receive raw match state
(scores, overs, wickets, status, and optionally top-performer stats) and must produce TWO
short digests from the same data, written for two different reader mindsets:

1. "analyst_digest": For someone who wants "the facts behind the moment." Precise, numbers-
   led, no narrative framing. State what's happening in the match in terms a data analyst
   would want: run rate, required rate, session/innings context, wicket-in-hand situation,
   session-level trend if inferable. Neutral tone, no excitement, no storytelling.

2. "fan_digest": For someone who wants "why this moment matters." Narrative, stakes-driven,
   written like you're explaining to a friend why they should care right now — momentum
   shifts, pressure, a standout individual performance, how this affects the result or the
   series. Conversational tone, can convey excitement where the data warrants it.

Rules:
- Each digest must be 1-2 sentences, plain English, no jargon dumps.
- Do not invent data not present in the input.
- If leaders/top-performer data is present, the fan_digest may reference it (e.g. a standout
  innings) since that's the kind of moment a fan cares about — the analyst_digest should only
  cite it as a stat line, not narrate it.
- If the match is not live (not started / finished), say so briefly instead of a live update.

Respond with ONLY valid JSON, no markdown fences, no preamble, matching exactly this shape:

{
  "analyst_digest": string,
  "fan_digest": string
}`;

/**
 * Generates the dual-audience digest for a single match's current state.
 * @param {object} match - normalized match object from espnClient.js
 */
export async function generateDigest(match) {
  const matchSummary = {
    teams: `${match.team1} vs ${match.team2}`,
    venue: match.venue,
    status: match.status,
    note: match.note,
    innings: match.innings,
    leaders: match.leaders && match.leaders.length > 0 ? match.leaders : undefined,
  };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Current match state:\n${JSON.stringify(matchSummary, null, 2)}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content in Claude response");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Claude JSON output: ${cleaned}`);
  }
}
