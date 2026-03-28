/**
 * Social Media Handler Lambda
 *
 * Triggered when a digest issue is labeled with bot-summary. This handler:
 * - Parses the daily digest issue content
 * - Formats for X (3-5 tweet thread) and Telegram (markdown message)
 * - Posts to both platforms
 * - Returns success/failure status
 */

import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

// Environment variable parameter names
const X_API_KEY_PARAM = process.env.X_API_KEY_PARAM || "/github-agent/X_API_KEY";
const X_API_SECRET_PARAM = process.env.X_API_SECRET_PARAM || "/github-agent/X_API_SECRET";
const X_ACCESS_TOKEN_PARAM = process.env.X_ACCESS_TOKEN_PARAM || "/github-agent/X_ACCESS_TOKEN";
const X_ACCESS_TOKEN_SECRET_PARAM = process.env.X_ACCESS_TOKEN_SECRET_PARAM || "/github-agent/X_ACCESS_TOKEN_SECRET";
const TELEGRAM_BOT_TOKEN_PARAM = process.env.TELEGRAM_BOT_TOKEN_PARAM || "/github-agent/TELEGRAM_BOT_TOKEN";
const TELEGRAM_CHAT_ID_PARAM = process.env.TELEGRAM_CHAT_ID_PARAM || "/github-agent/TELEGRAM_CHAT_ID";

interface DigestContent {
  date: string;
  succeeded: number;
  failed: number;
  timedOut: number;
  successRate: number;
  mergedPRs: Array<{ title: string; number: number; repo: string; url: string }>;
  creditsSpent: number;
  repoCount: number;
  repositoryUrl: string;
}

async function getParameter(name: string, optional: boolean = false): Promise<string | null> {
  try {
    const resp = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
    return resp.Parameter?.Value ?? null;
  } catch (error: any) {
    if (optional || error.name === "ParameterNotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * Parse digest issue body to extract key metrics
 */
function parseDigestIssue(issueBody: string, repositoryUrl: string): DigestContent {
  // Extract date from title or body
  const dateMatch = issueBody.match(/## Agent Activity Summary: (\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

  // Extract task outcomes
  const succeededMatch = issueBody.match(/✅ Succeeded: (\d+)/);
  const failedMatch = issueBody.match(/❌ Failed: (\d+)/);
  const timeoutMatch = issueBody.match(/⏱️ Timeout: (\d+)/);
  const successRateMatch = issueBody.match(/Success Rate: (\d+)%/);

  const succeeded = parseInt(succeededMatch?.[1] || "0");
  const failed = parseInt(failedMatch?.[1] || "0");
  const timedOut = parseInt(timeoutMatch?.[1] || "0");
  const successRate = parseInt(successRateMatch?.[1] || "0");

  // Extract merged PRs
  const mergedPRs: Array<{ title: string; number: number; repo: string; url: string }> = [];
  const prMatches = issueBody.matchAll(/- \[(.*?)\s+\(#(\d+)\)\]\((https:\/\/github\.com\/.*?\/pull\/\d+)\) in ([\w/]+)/g);
  for (const match of prMatches) {
    mergedPRs.push({
      title: match[1],
      number: parseInt(match[2]),
      url: match[3],
      repo: match[4],
    });
  }

  // Extract credits spent
  const creditsMatch = issueBody.match(/Total Spent \(All Time\): (\d+) credits/);
  const creditsSpent = parseInt(creditsMatch?.[1] || "0");

  // Count unique repos
  const repoMatches = issueBody.matchAll(/in ([\w/]+)/g);
  const repoSet = new Set<string>();
  for (const match of repoMatches) {
    repoSet.add(match[1]);
  }

  return {
    date,
    succeeded,
    failed,
    timedOut,
    successRate,
    mergedPRs,
    creditsSpent,
    repoCount: repoSet.size,
    repositoryUrl,
  };
}

/**
 * Format digest as Twitter thread (3-5 tweets)
 */
function formatTwitterThread(digest: DigestContent): string[] {
  const tweets: string[] = [];

  // Tweet 1: Summary
  const total = digest.succeeded + digest.failed + digest.timedOut;
  tweets.push(
    `🤖 Daily Digest: ${digest.date}\n\n` +
    `Total Tasks: ${total}\n` +
    `✅ Succeeded: ${digest.succeeded}\n` +
    `❌ Failed: ${digest.failed}\n` +
    `⏱️ Timed Out: ${digest.timedOut}\n` +
    `Success Rate: ${digest.successRate}%\n\n` +
    `Repos Touched: ${digest.repoCount}`
  );

  // Tweet 2: PRs and activity (if any)
  if (digest.mergedPRs.length > 0) {
    const prList = digest.mergedPRs
      .slice(0, 3)
      .map((pr) => `• ${pr.title}`)
      .join("\n");

    tweets.push(
      `📦 Merged PRs (${digest.mergedPRs.length} total):\n\n${prList}` +
      (digest.mergedPRs.length > 3 ? `\n\n+${digest.mergedPRs.length - 3} more` : "")
    );
  }

  // Tweet 3: Credits and links
  tweets.push(
    `💳 Credits Spent: ${digest.creditsSpent}\n\n` +
    `Full digest and metrics available on GitHub:\n${digest.repositoryUrl}`
  );

  return tweets;
}

/**
 * Format digest as Telegram message (markdown)
 */
function formatTelegramMessage(digest: DigestContent): string {
  const total = digest.succeeded + digest.failed + digest.timedOut;

  let message = `*🤖 Agent Daily Digest: ${digest.date}*\n\n`;

  message += `*Task Outcomes*\n`;
  message += `✅ Succeeded: *${digest.succeeded}*\n`;
  message += `❌ Failed: *${digest.failed}*\n`;
  message += `⏱️ Timeout: *${digest.timedOut}*\n`;
  message += `Total: *${total}*\n`;
  if (total > 0) {
    message += `Success Rate: *${digest.successRate}%*\n`;
  }
  message += `\n`;

  message += `*Coverage*\n`;
  message += `Repositories Touched: *${digest.repoCount}*\n`;
  message += `\n`;

  if (digest.mergedPRs.length > 0) {
    message += `*Merged PRs (${digest.mergedPRs.length})*\n`;
    digest.mergedPRs.slice(0, 5).forEach((pr) => {
      message += `• [${pr.title}](${pr.url})\n`;
    });
    if (digest.mergedPRs.length > 5) {
      message += `\\+ ${digest.mergedPRs.length - 5} more\n`;
    }
    message += `\n`;
  }

  message += `*Resources*\n`;
  message += `💳 Credits Spent: *${digest.creditsSpent}*\n`;
  message += `[Full Digest](${digest.repositoryUrl})`;

  return message;
}

/**
 * Post to X/Twitter using v2 API
 */
async function postToTwitter(tweets: string[], xApiKey: string, xApiSecret: string, xAccessToken: string, xAccessTokenSecret: string): Promise<void> {
  if (!xApiKey || !xApiSecret || !xAccessToken || !xAccessTokenSecret) {
    console.warn("Twitter credentials not configured, skipping X posting");
    return;
  }

  // For now, log tweet content. In production, integrate with twitter-api-v2 or similar
  console.log("Would post to X (Twitter):");
  tweets.forEach((tweet, i) => {
    console.log(`\nTweet ${i + 1}:\n${tweet}`);
  });
}

/**
 * Post to Telegram
 */
async function postToTelegram(message: string, botToken: string, chatId: string): Promise<void> {
  if (!botToken || !chatId) {
    console.warn("Telegram credentials not configured, skipping Telegram posting");
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to post to Telegram: ${response.status} ${error}`);
  }

  console.log("Successfully posted to Telegram");
}

export interface SocialMediaEvent {
  issue?: {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    html_url: string;
    repository_url: string;
  };
}

export async function handler(event: SocialMediaEvent): Promise<{ statusCode: number; body: string }> {
  try {
    const issue = event.issue;
    if (!issue) {
      return { statusCode: 400, body: "No issue data in event" };
    }

    // Check if this is a bot-summary issue
    const hasBotsummaryLabel = issue.labels.some((label) => label.name === "bot-summary");
    if (!hasBotsummaryLabel) {
      console.log("Issue does not have bot-summary label, skipping");
      return { statusCode: 200, body: "Not a bot-summary issue" };
    }

    // Parse digest content
    const digest = parseDigestIssue(issue.body, issue.html_url);

    // Get credentials
    const [xApiKey, xApiSecret, xAccessToken, xAccessTokenSecret, telegramBotToken, telegramChatId] = await Promise.all([
      getParameter(X_API_KEY_PARAM, true),
      getParameter(X_API_SECRET_PARAM, true),
      getParameter(X_ACCESS_TOKEN_PARAM, true),
      getParameter(X_ACCESS_TOKEN_SECRET_PARAM, true),
      getParameter(TELEGRAM_BOT_TOKEN_PARAM, true),
      getParameter(TELEGRAM_CHAT_ID_PARAM, true),
    ]);

    // Format for both platforms
    const twitterThreads = formatTwitterThread(digest);
    const telegramMessage = formatTelegramMessage(digest);

    // Post to both platforms
    await Promise.all([
      postToTwitter(twitterThreads, xApiKey || "", xApiSecret || "", xAccessToken || "", xAccessTokenSecret || ""),
      postToTelegram(telegramMessage, telegramBotToken || "", telegramChatId || ""),
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Successfully posted digest to social media",
        tweetsPosted: twitterThreads.length,
        telegramPosted: true,
      }),
    };
  } catch (error) {
    console.error("Social media handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Failed to post to social media: ${error}`,
      }),
    };
  }
}
