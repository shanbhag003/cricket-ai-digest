import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a data-to-briefing layer for a sports broadcast operations team.
You receive raw live cricket match state (scores, overs, wickets, status) and must produce
TWO short digests from the same data, written for two different audiences:

1. "ops_digest": For an internal broadcast operations / delivery team. Focus on anything
   operationally relevant: is the match progressing to schedule, any risk of overrun,
   any status change (rain delay, innings break, match ending) they'd need to plan around.
   Neutral, factual, brief. Think "status update in a delivery standup."

2. "partner_digest": For a broadcast partner's business stakeholder (e.g. a channel or
   streaming platform executive) who doesn't care about ball-by-ball detail. Focus on
   what matters to their audience/business: how close/exciting the match is, whether a
   result looks imminent, anything that affects viewership interest. Written like a
   one-line executive summary, not commentary.

Rules:
- Each digest must be 1-2 sentences, plain English, no jargon dumps.
- Do not invent data not present in the input.
- If the match is not live (not started / finished), say so briefly instead of a live update.

Respond with ONLY valid JSON, no markdown fences, no preamble, matching exactly this shape:

{
  "ops_digest": string,
  "partner_digest": string
}`;

/**
 * Generates the dual-audience digest for a single match's current state.
 * @param {object} match - normalized match object from cricketDataClient.js
 */
export async function generateDigest(match) {
  const matchSummary = {
    teams: `${match.team1} vs ${match.team2}`,
    venue: match.venue,
    status: match.status,
    note: match.note,
    innings: match.innings,
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
