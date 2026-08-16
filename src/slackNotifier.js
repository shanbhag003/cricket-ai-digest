import fetch from "node-fetch";

/**
 * Posts a formatted digest to Slack via Incoming Webhook.
 * @param {object} match - normalized match object
 * @param {object} digest - { ops_digest, partner_digest }
 */
export async function postToSlack(match, digest) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return; // Slack delivery is optional; skip silently if unconfigured

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🏏 ${match.team1} vs ${match.team2}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Venue:*\n${match.venue}` },
          { type: "mrkdwn", text: `*Status:*\n${match.status}` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Ops Digest:*\n${digest.ops_digest}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Broadcast Partner Digest:*\n${digest.partner_digest}` },
      },
      { type: "divider" },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Slack post failed (${res.status}): ${errText}`);
  }
}
