const { App } = require("@slack/bolt");
const http = require("http");

require("dotenv").config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const CLAY_WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL; 

function extractLinkedInUrl(text) {
  const pattern = /https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/i;
  const match = text.match(pattern);
  return match ? match[0] : null;
}

async function sendToClay(linkedinUrl, channel, threadTs, user) {

  const response = await fetch(CLAY_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      linkedin_url: linkedinUrl,
      channel: channel,
      thread_ts: threadTs,
      user: user,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Clay webhook error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  console.log("Clay webhook acknowledged:", JSON.stringify(data, null, 2));
}

const CALLBACK_PORT = process.env.PORT || 3333;

const callbackServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/clay-callback") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        console.log("Clay callback received:", JSON.stringify(data, null, 2));

        const { channel, thread_ts, user, phone_number, name } = data;

        if (!channel || !thread_ts) {
          console.error("Missing channel or thread_ts in Clay callback");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing channel or thread_ts" }));
          return;
        }

        if (phone_number) {
          const nameStr = name ? ` (${name})` : "";
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel,
            thread_ts,
            text: `Found it${nameStr}: ${phone_number}`,
          });
        } else {
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel,
            thread_ts,
            text: `No phone number found for that profile. Clay couldn't find one in its data sources.`,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("Error handling Clay callback:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

app.event("app_mention", async ({ event, client, say }) => {
  const { text, channel, ts, user } = event;
  if (event) {
  console.log(`Received mention from user ${user} in channel ${channel}: ${text}`);
  } else {
    console.log(`Received mention with no event data. Raw payload: ${JSON.stringify(event)}`);
  }
  const linkedinUrl = extractLinkedInUrl(text);

  if (!linkedinUrl) {
    await client.chat.postMessage({
      channel,
      thread_ts: ts, 
      text: `Hey <@${user}>, I couldn't find a LinkedIn profile URL in your message. Send me something like: @bot https://linkedin.com/in/someperson`,
    });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: ts,
    text: `Got it. Looking up the phone number for ${linkedinUrl}...`,
  });

  try {
    await sendToClay(linkedinUrl, channel, ts, user);
    console.log("Sent to Clay successfully. Waiting for Clay to post back.");
  } catch (err) {
    console.error("Clay webhook failed:", err);
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `Something went wrong sending to Clay. Error: ${err.message}`,
    });
  }
});


(async () => {
  await app.start();
  console.log("Slack bot is running. Listening for mentions...");

  callbackServer.listen(CALLBACK_PORT, () => {
    console.log(`Clay callback server running on port ${CALLBACK_PORT}`);
    console.log("Clay callback endpoint: /clay-callback");
  });
})();

