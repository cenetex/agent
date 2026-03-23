import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  createGitHubAppJWT,
  getInstallationId,
  createInstallationToken,
} from "./types";

const ssm = new SSMClient({});

const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
}

async function githubRequest(
  path: string,
  token: string,
  init: RequestInit,
  expectedStatuses: number[]
): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-agent-qa-trigger",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!expectedStatuses.includes(response.status)) {
    const responseBody = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${responseBody}`
    );
  }

  return response;
}

async function createQAIssue(
  repoOwner: string,
  repoName: string,
  token: string,
  qaPrompt: string
): Promise<number> {
  const response = await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        title: "QA: Nightly System Check",
        body: qaPrompt,
        labels: ["agent"],
      }),
    },
    [201]
  );

  const issue = (await response.json()) as any;
  return issue.number;
}

const QA_PROMPT = `You are a QA agent. Run the following checks against this repository and post your findings as a comment. Then close this issue.

## Checks to run

### 1. Shell syntax
- Run: bash -n agent/entrypoint.sh
- Run: bash -n agent/review-entrypoint.sh
- Report any syntax errors

### 2. TypeScript compilation
- Run: cd infra && npm ci && npx tsc --noEmit
- Report any type errors

### 3. Pre-flight simulation
- Check OpenRouter connectivity: curl the /auth/key endpoint
- Check GitHub API access: gh api repos/cenetex/agent
- Check git push access: git ls-remote --exit-code origin HEAD
- Report any failures

### 4. Container dependencies
- Verify aws CLI exists: which aws
- Verify claude CLI exists: which claude
- Verify jq exists: which jq
- Report any missing tools

### 5. Recent changes audit
- Run: git log --oneline -10
- For each changed file in the last 10 commits, verify it exists and is valid
- Report anything suspicious

### 6. Cost check
- Check OpenRouter usage: curl /auth/key endpoint, report usage
- Check if any expensive AWS resources exist that shouldn't

### 7. End-to-end smoke test (optional, skip if risky)
- Only if you're confident it won't cause issues

## Output format
Post a single comment with:
- [PASS] / [FAIL] / [WARN] for each check
- Details on any failures
- Create a new issue for any [FAIL] items (don't label with agent)

Then close this issue.`;

export async function handler(): Promise<{ issueNumber: number }> {
  console.log("Starting QA trigger");

  try {
    // Fetch GitHub credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

    // Create GitHub App JWT
    const jwt = createGitHubAppJWT(appId, privateKey);

    // Get installation for cenetex/agent
    const installationId = await getInstallationId("cenetex", "agent", jwt);

    // Create installation token
    const tokenResult = await createInstallationToken(installationId, jwt);
    const githubToken = tokenResult.token;

    // Create QA issue
    const issueNumber = await createQAIssue(
      "cenetex",
      "agent",
      githubToken,
      QA_PROMPT
    );

    console.log(`Created QA issue #${issueNumber}`);
    return { issueNumber };
  } catch (error) {
    console.error(`QA trigger failed: ${error}`);
    throw error;
  }
}
