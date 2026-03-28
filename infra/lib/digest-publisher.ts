import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const TWITTER_BEARER_TOKEN_PARAM = process.env.TWITTER_BEARER_TOKEN_PARAM!;
const TELEGRAM_BOT_TOKEN_PARAM = process.env.TELEGRAM_BOT_TOKEN_PARAM!;
const TELEGRAM_CHANNEL_ID_PARAM = process.env.TELEGRAM_CHANNEL_ID_PARAM!;

interface WebhookPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string;
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    name: string;
    owner: {
      login: string;
    };
    html_url: string;
  };
}

async function getParameter(name: string): Promise<string> {
  try {
    const resp = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
    return resp.Parameter?.Value ?? "";
  } catch (error) {
    console.error(`Failed to get parameter ${name}:`, error);
    return "";
  }
}

function parseDigestContent(body: string): {
  stats: { succeeded: number; failed: number; timed_out: number; total: number; successRate: number };
  mergedPRs: Array<{ title: string; number: number; repo: string; url: string }>;
  creditSpent: number;
  lowBalanceRepos: Array<{ repo: string; balance: number }>;
} {
  const stats = {
    succeeded: 0,
    failed: 0,
    timed_out: 0,
    total: 0,
    successRate: 0,
  };

  // Extract task outcomes
  const succeededMatch = body.match(/✅ Succeeded: (\d+)/);
  const failedMatch = body.match(/❌ Failed: (\d+)/);
  const timeoutMatch = body.match(/⏱️ Timeout: (\d+)/);
  const rateMatch = body.match(/Success Rate: (\d+)%/);
  const creditMatch = body.match(/Total Spent \(All Time\): ([\d,]+)/);

  if (succeededMatch) stats.succeeded = parseInt(succeededMatch[1]);
  if (failedMatch) stats.failed = parseInt(failedMatch[1]);
  if (timeoutMatch) stats.timed_out = parseInt(timeoutMatch[1]);
  if (rateMatch) stats.successRate = parseInt(rateMatch[1]);

  stats.total = stats.succeeded + stats.failed + stats.timed_out;

  // Extract merged PRs
  const mergedPRs: Array<{ title: string; number: number; repo: string; url: string }> = [];
  const prMatches = body.matchAll(/\[(.+?) \(#(\d+)\)\]\((https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)\) in ([^\n]+)/g);
  for (const match of prMatches) {
    mergedPRs.push({
      title: match[1],
      number: parseInt(match[2]),
      url: match[3],
      repo: match[4],
    });
  }

  // Extract credit spend
  let creditSpent = 0;
  if (creditMatch) {
    creditSpent = parseInt(creditMatch[1].replace(/,/g, ""));
  }

  // Extract low balance repos
  const lowBalanceRepos: Array<{ repo: string; balance: number }> = [];
  const lowBalanceSection = body.match(/⚠️.*Action Required[\s\S]*?(?=---|\*\*Artifact|$)/);
  if (lowBalanceSection) {
    const repoMatches = lowBalanceSection[0].matchAll(/- ([^\s:]+): (\d+) credits/g);
    for (const repoMatch of repoMatches) {
      lowBalanceRepos.push({
        repo: repoMatch[1],
        balance: parseInt(repoMatch[2]),
      });
    }
  }

  return {
    stats,
    mergedPRs,
    creditSpent,
    lowBalanceRepos,
  };
}

function formatForTwitter(
  digestDate: string,
  stats: { succeeded: number; failed: number; timed_out: number; total: number; successRate: number },
  mergedPRs: Array<{ title: string; number: number; repo: string; url: string }>,
  issueUrl: string
): string[] {
  const tweets: string[] = [];
  const dateObj = new Date(digestDate);
  const dateStr = dateObj.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Tweet 1: Overview
  const successEmoji = stats.successRate >= 80 ? "✅" : stats.successRate >= 50 ? "⚠️" : "❌";
  tweets.push(
    `Daily agent digest for ${dateStr}\n\n${successEmoji} Tasks: ${stats.total}\n✅ Succeeded: ${stats.succeeded}\n❌ Failed: ${stats.failed}\n⏱️ Timeout: ${stats.timed_out}\n\nSuccess rate: ${stats.successRate}%\n\nRead the full digest:\n${issueUrl}`
  );

  // Tweet 2: PR activity (if any)
  if (mergedPRs.length > 0) {
    const prSummary = mergedPRs.length === 1
      ? `1 PR merged today`
      : `${mergedPRs.length} PRs merged today`;

    const prList = mergedPRs.slice(0, 3)
      .map((pr) => `• ${pr.repo}: ${pr.title.substring(0, 40)}${pr.title.length > 40 ? "..." : ""}`)
      .join("\n");

    tweets.push(
      `📦 ${prSummary}\n\n${prList}${mergedPRs.length > 3 ? `\n\n+${mergedPRs.length - 3} more` : ""}`
    );
  }

  // Tweet 3: Call to action
  tweets.push(
    `⚙️ Our agents are shipping every day. Watch what they build in real-time.\n\nFull activity log:\n${issueUrl}`
  );

  return tweets;
}

function formatForTelegram(
  digestDate: string,
  stats: { succeeded: number; failed: number; timed_out: number; total: number; successRate: number },
  mergedPRs: Array<{ title: string; number: number; repo: string; url: string }>,
  shortUrl: string
): string {
  const dateObj = new Date(digestDate);
  const dateStr = dateObj.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let message = `**📊 Daily Agent Digest - ${dateStr}**\n\n`;

  // Task stats
  message += `**Task Summary:**\n`;
  message += `✅ Succeeded: ${stats.succeeded}\n`;
  message += `❌ Failed: ${stats.failed}\n`;
  message += `⏱️ Timed Out: ${stats.timed_out}\n`;
  message += `📈 Total Tasks: ${stats.total}\n`;
  if (stats.total > 0) {
    message += `📊 Success Rate: ${stats.successRate}%\n`;
  }

  // PR section
  if (mergedPRs.length > 0) {
    message += `\n**🔀 Merged PRs:**\n`;
    for (const pr of mergedPRs.slice(0, 5)) {
      message += `• [${pr.repo}] ${pr.title.substring(0, 50)}${pr.title.length > 50 ? "..." : ""}\n`;
    }
    if (mergedPRs.length > 5) {
      message += `\nAnd ${mergedPRs.length - 5} more PRs...\n`;
    }
  }

  message += `\n**📋 Full Details:** [View Digest](${shortUrl})\n`;
  message += `\n_This report is auto-published by our agents. All activity is tracked here._`;

  return message;
}

async function postToTwitter(
  tweets: string[],
  bearerToken: string
): Promise<void> {
  if (!bearerToken) {
    console.log("Twitter bearer token not configured, skipping Twitter posting");
    return;
  }

  try {
    // Post as a thread
    let previousTweetId: string | null = null;

    for (const tweetText of tweets) {
      const tweetBody: any = { text: tweetText };
      if (previousTweetId) {
        tweetBody.reply = { in_reply_to_tweet_id: previousTweetId };
      }

      const response = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(tweetBody),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Twitter API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as any;
      previousTweetId = data.data?.id ?? null;
      console.log(`Posted tweet: ${tweetText.substring(0, 50)}...`);
    }
  } catch (error) {
    console.error("Failed to post to Twitter:", error);
    throw error;
  }
}

async function postToTelegram(
  message: string,
  botToken: string,
  channelId: string
): Promise<void> {
  if (!botToken || !channelId) {
    console.log("Telegram credentials not configured, skipping Telegram posting");
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: channelId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }

    console.log("Posted message to Telegram channel");
  } catch (error) {
    console.error("Failed to post to Telegram:", error);
    throw error;
  }
}

export async function publishDigestToSocialMedia(
  issueTitle: string,
  issueBody: string,
  issueUrl: string
): Promise<void> {
  // Check if it's a digest issue
  if (!issueTitle.includes("Agent Daily Digest")) {
    console.log("Issue is not a digest issue, skipping social media publishing");
    return;
  }

  try {
    // Get API credentials
    const [twitterToken, telegramToken, telegramChannelId] = await Promise.all([
      getParameter(TWITTER_BEARER_TOKEN_PARAM),
      getParameter(TELEGRAM_BOT_TOKEN_PARAM),
      getParameter(TELEGRAM_CHANNEL_ID_PARAM),
    ]);

    // Extract digest date from title
    const dateMatch = issueTitle.match(/(\d{4}-\d{2}-\d{2})/);
    const digestDate = dateMatch ? dateMatch[1] : new Date().toISOString().split("T")[0];

    // Parse digest content
    const { stats, mergedPRs } = parseDigestContent(issueBody);

    console.log(`Publishing digest for ${digestDate}:`, {
      stats,
      prCount: mergedPRs.length,
    });

    // Post to X/Twitter
    if (twitterToken) {
      const tweets = formatForTwitter(digestDate, stats, mergedPRs, issueUrl);
      await postToTwitter(tweets, twitterToken);
    }

    // Post to Telegram
    if (telegramToken && telegramChannelId) {
      const telegramMessage = formatForTelegram(digestDate, stats, mergedPRs, issueUrl);
      await postToTelegram(telegramMessage, telegramToken, telegramChannelId);
    }

    console.log("Digest successfully published to social media");
  } catch (error) {
    console.error("Failed to publish digest:", error);
    throw error;
  }
}

export async function handler(event: any): Promise<void> {
  console.log("Digest publisher triggered:", JSON.stringify(event, null, 2));

  // Check if this is a GitHub issue event with bot-summary label
  const payload: WebhookPayload = event.body ? JSON.parse(event.body) : event;

  if (payload.action !== "opened" && payload.action !== "labeled") {
    console.log(`Ignoring action: ${payload.action}`);
    return;
  }

  // Check for bot-summary label
  const hasBotSummaryLabel = payload.issue.labels.some((label) => label.name === "bot-summary");
  if (!hasBotSummaryLabel) {
    console.log("Issue does not have bot-summary label, skipping");
    return;
  }

  await publishDigestToSocialMedia(payload.issue.title, payload.issue.body, payload.issue.html_url);
}
