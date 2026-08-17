import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DEFAULT_MERGE_HOLD_CONFIG,
  MergeHoldConfig,
  parseAgentConfig,
} from "./agent-config";
import {
  GitHubAppConfig,
  getInstallationToken,
  parseRepoSlug,
  PROTECTED_PATHS,
} from "./types";
import {
  ALL_MERGE_TRIAGE_LABELS,
  MERGE_TRIAGE_LABELS,
  MergeCheckState,
  MergePlan,
  MergePlanItem,
  MergeTriageCandidate,
  isCodingAgentAuthor,
  planMergeTriage,
} from "./merge-triage-policy";

const ssm = new SSMClient({});
const s3 = new S3Client({});

const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const MONITORED_REPOS = (process.env.MONITORED_REPOS || "").split(",").filter(r => r.trim());
const DEFAULT_REPOS = [
  "cenetex/aws-swarm",
  "cenetex/kyro",
  "cenetex/raticross",
  "cenetex/ratibot",
  "cenetex/litigation",
  "cenetex/agent",
  "cenetex/governance",
  "atimics/AutoForwarder",
];

const PLAN_COMMENT_MARKER = "<!-- merge-triage-plan -->";
const REVIEW_APPROVED_LABEL = "review:approved";
const FAST_TRACK_LABEL = "fast-track";
const DEFAULT_MAX_MERGES_PER_RUN = 1;

const MERGE_TRIAGE_LABEL_DEFINITIONS = [
  {
    name: MERGE_TRIAGE_LABELS.ready,
    color: "0E8A16",
    description: "Merge triage says this PR is ready for the next safe merge slot",
  },
  {
    name: MERGE_TRIAGE_LABELS.queued,
    color: "1D76DB",
    description: "Merge triage is waiting for another PR or queue slot before merging",
  },
  {
    name: MERGE_TRIAGE_LABELS.waiting,
    color: "FBCA04",
    description: "Merge triage is waiting for review, checks, or hold-period gates",
  },
  {
    name: MERGE_TRIAGE_LABELS.blocked,
    color: "D73A4A",
    description: "Merge triage found a merge blocker that needs attention",
  },
  {
    name: MERGE_TRIAGE_LABELS.conflict,
    color: "B60205",
    description: "Merge triage found merge conflicts with the base branch",
  },
  {
    name: MERGE_TRIAGE_LABELS.stale,
    color: "C5DEF5",
    description: "Merge triage found a branch that needs to be updated",
  },
];

interface GitHubPullFile {
  filename: string;
  additions?: number;
  deletions?: number;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  user: {
    login: string;
  };
  labels: Array<{
    name: string;
  }>;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  additions?: number;
  deletions?: number;
  created_at?: string;
  updated_at?: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
  };
}

interface GitHubIssueEvent {
  event?: string;
  created_at?: string;
  label?: {
    name?: string;
  };
}

interface GitHubIssueComment {
  id: number;
  body?: string;
}

interface GitHubCheckRun {
  status?: string;
  conclusion?: string | null;
}

interface GitHubRepository {
  archived?: boolean;
  disabled?: boolean;
}

interface RepoSummary {
  repo: string;
  candidates: number;
  ready: number;
  queued: number;
  waiting: number;
  blocked: number;
  conflicts: number;
  stale: number;
  merged: number;
  mergeFailures: number;
  skipped?: boolean;
  skipReason?: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAutoMergeEnabled(): boolean {
  return (process.env.MERGE_TRIAGE_AUTO_MERGE ?? "true").toLowerCase() !== "false";
}

function maxMergesPerRun(): number {
  return parsePositiveInteger(
    process.env.MERGE_TRIAGE_MAX_MERGES_PER_RUN,
    DEFAULT_MAX_MERGES_PER_RUN
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedOptionalGitHubError(message: string): boolean {
  return (
    message.includes("Resource not accessible by integration") ||
    message.includes("Not Found")
  );
}

function repoSkipReason(error: unknown): string | null {
  const message = errorMessage(error);

  if (message.includes("Failed to get installation ID")) {
    return "GitHub App is not installed or cannot access this repository.";
  }

  if (message.includes("Repository was archived so is read-only")) {
    return "Repository is archived/read-only.";
  }

  if (message.includes("disabled")) {
    return "Repository is disabled.";
  }

  return null;
}

function skippedRepoSummary(repo: string, reason: string): RepoSummary {
  return {
    repo,
    candidates: 0,
    ready: 0,
    queued: 0,
    waiting: 0,
    blocked: 0,
    conflicts: 0,
    stale: 0,
    merged: 0,
    mergeFailures: 0,
    skipped: true,
    skipReason: reason,
  };
}

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
      "User-Agent": "github-agent-merge-triage",
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

async function githubOptionalRequest(
  path: string,
  token: string,
  init: RequestInit,
  expectedStatuses: number[]
): Promise<Response | null> {
  try {
    return await githubRequest(path, token, init, expectedStatuses);
  } catch (error) {
    const message = errorMessage(error);
    if (isExpectedOptionalGitHubError(message)) {
      console.warn(`Optional GitHub request unavailable for ${path}: ${message}`);
    } else {
      console.warn(`Optional GitHub request failed for ${path}:`, error);
    }
    return null;
  }
}

async function githubPaginatedRequest<T>(
  path: string,
  token: string
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (page <= 10) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await githubRequest(
      `${path}${separator}per_page=100&page=${page}`,
      token,
      { method: "GET" },
      [200]
    );
    const pageResults = await response.json() as T[];
    results.push(...pageResults);

    if (pageResults.length < 100) {
      break;
    }

    page += 1;
  }

  return results;
}

async function getRepoAgentConfigContent(repo: string, token: string): Promise<string | null> {
  const response = await githubOptionalRequest(
    `/repos/${repo}/contents/.github/AGENT.md`,
    token,
    { method: "GET" },
    [200, 404]
  );

  if (!response || response.status === 404) {
    return null;
  }

  const content = await response.json() as { type?: string; content?: string };
  if (content.type !== "file" || !content.content) {
    return null;
  }

  return Buffer.from(content.content, "base64").toString("utf8");
}

async function getRepositoryInfo(repo: string, token: string): Promise<GitHubRepository> {
  const response = await githubRequest(
    `/repos/${repo}`,
    token,
    { method: "GET" },
    [200]
  );
  return await response.json() as GitHubRepository;
}

async function getRepoMergeHoldConfig(repo: string, token: string): Promise<MergeHoldConfig> {
  const content = await getRepoAgentConfigContent(repo, token);
  return content ? parseAgentConfig(content).mergeHold : DEFAULT_MERGE_HOLD_CONFIG;
}

function requiredHoldMinutesForPR(
  pr: GitHubPullRequest,
  files: GitHubPullFile[],
  config: MergeHoldConfig
): number {
  const hasFastTrackLabel = pr.labels.some(
    (label) => label.name.toLowerCase() === FAST_TRACK_LABEL
  );
  if (hasFastTrackLabel) {
    return 5;
  }

  const touchesInfra = files.some((file) => file.filename.startsWith("infra/"));
  return touchesInfra ? config.merge_hold_minutes_infra : config.merge_hold_minutes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesProtectedPattern(filename: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(escapeRegExp(pattern).replace(/\\\*/g, ".*"));
    return regex.test(filename);
  }

  if (pattern.endsWith("/")) {
    return filename.startsWith(pattern) || filename.includes(`/${pattern}`);
  }

  return filename.includes(pattern);
}

function findProtectedFiles(files: GitHubPullFile[]): string[] {
  return files
    .map((file) => file.filename)
    .filter((filename) =>
      PROTECTED_PATHS.some((pattern) => matchesProtectedPattern(filename, pattern))
    );
}

function latestReviewApprovedAt(events: GitHubIssueEvent[]): string | undefined {
  const approvedEvent = events
    .filter((event) =>
      event.event === "labeled" &&
      event.label?.name === REVIEW_APPROVED_LABEL &&
      event.created_at
    )
    .sort((left, right) =>
      new Date(right.created_at!).getTime() - new Date(left.created_at!).getTime()
    )[0];

  return approvedEvent?.created_at;
}

function combineCheckState(current: MergeCheckState, next: MergeCheckState): MergeCheckState {
  if (current === "failure" || next === "failure") {
    return "failure";
  }

  if (current === "pending" || next === "pending") {
    return "pending";
  }

  if (current === "success" || next === "success") {
    return "success";
  }

  return "unknown";
}

async function getCombinedStatusState(
  repo: string,
  headSha: string,
  token: string
): Promise<MergeCheckState> {
  const response = await githubOptionalRequest(
    `/repos/${repo}/commits/${headSha}/status`,
    token,
    { method: "GET" },
    [200]
  );

  if (!response) {
    return "unknown";
  }

  const status = await response.json() as { state?: string };
  if (status.state === "success") {
    return "success";
  }
  if (status.state === "pending") {
    return "pending";
  }
  if (status.state === "failure" || status.state === "error") {
    return "failure";
  }

  return "unknown";
}

async function getCheckRunState(
  repo: string,
  headSha: string,
  token: string
): Promise<MergeCheckState> {
  const response = await githubOptionalRequest(
    `/repos/${repo}/commits/${headSha}/check-runs`,
    token,
    { method: "GET" },
    [200]
  );

  if (!response) {
    return "unknown";
  }

  const payload = await response.json() as { check_runs?: GitHubCheckRun[] };
  const runs = payload.check_runs ?? [];
  if (runs.length === 0) {
    return "unknown";
  }

  let state: MergeCheckState = "success";

  for (const run of runs) {
    if (run.status !== "completed") {
      state = combineCheckState(state, "pending");
      continue;
    }

    if (
      run.conclusion === "success" ||
      run.conclusion === "neutral" ||
      run.conclusion === "skipped"
    ) {
      continue;
    }

    state = combineCheckState(state, "failure");
  }

  return state;
}

async function getChecksState(
  repo: string,
  headSha: string,
  token: string
): Promise<MergeCheckState> {
  const [statusState, checkRunState] = await Promise.all([
    getCombinedStatusState(repo, headSha, token),
    getCheckRunState(repo, headSha, token),
  ]);

  return combineCheckState(statusState, checkRunState);
}

async function buildCandidate(
  repo: string,
  prNumber: number,
  token: string,
  mergeHoldConfig: MergeHoldConfig
): Promise<MergeTriageCandidate> {
  const prResponse = await githubRequest(
    `/repos/${repo}/pulls/${prNumber}`,
    token,
    { method: "GET" },
    [200]
  );
  const pr = await prResponse.json() as GitHubPullRequest;

  const [files, events, checksState] = await Promise.all([
    githubPaginatedRequest<GitHubPullFile>(`/repos/${repo}/pulls/${prNumber}/files`, token),
    githubPaginatedRequest<GitHubIssueEvent>(`/repos/${repo}/issues/${prNumber}/events`, token),
    getChecksState(repo, pr.head.sha, token),
  ]);

  const labels = pr.labels.map((label) => label.name);
  const additions = pr.additions ?? files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = pr.deletions ?? files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user.login,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    labels,
    isDraft: pr.draft ?? false,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
    files: files.map((file) => file.filename),
    additions,
    deletions,
    protectedFiles: findProtectedFiles(files),
    reviewApprovedAt: latestReviewApprovedAt(events),
    requiredHoldMinutes: requiredHoldMinutesForPR(pr, files, mergeHoldConfig),
    createdAt: pr.created_at,
    checksState,
  };
}

async function discoverCandidates(
  repo: string,
  token: string,
  mergeHoldConfig: MergeHoldConfig
): Promise<MergeTriageCandidate[]> {
  const openPRs = await githubPaginatedRequest<GitHubPullRequest>(
    `/repos/${repo}/pulls?state=open`,
    token
  );
  const trackedPRs = openPRs.filter((pr) => {
    const labels = pr.labels.map((label) => label.name);
    const hasMergeLabel = labels.some((label) => ALL_MERGE_TRIAGE_LABELS.includes(label));
    const hasAgentLifecycleLabel =
      labels.includes("agent:succeeded") ||
      labels.some((label) => label.startsWith("review:"));

    return hasMergeLabel || (isCodingAgentAuthor(pr.user.login) && hasAgentLifecycleLabel);
  });

  const candidates: MergeTriageCandidate[] = [];

  for (const pr of trackedPRs) {
    try {
      candidates.push(await buildCandidate(repo, pr.number, token, mergeHoldConfig));
    } catch (error) {
      console.error(`Failed to build merge candidate for ${repo}#${pr.number}:`, error);
    }
  }

  return candidates;
}

async function ensureMergeLabels(repo: string, token: string): Promise<void> {
  for (const label of MERGE_TRIAGE_LABEL_DEFINITIONS) {
    await githubRequest(
      `/repos/${repo}/labels`,
      token,
      {
        method: "POST",
        body: JSON.stringify(label),
      },
      [201, 422]
    );
  }
}

async function setMergeLabel(
  repo: string,
  prNumber: number,
  token: string,
  status: MergePlanItem["status"]
): Promise<void> {
  const desiredLabel = MERGE_TRIAGE_LABELS[status];

  await Promise.all(
    ALL_MERGE_TRIAGE_LABELS
      .filter((label) => label !== desiredLabel)
      .map((label) =>
        githubRequest(
          `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
          token,
          { method: "DELETE" },
          [200, 204, 404]
        )
      )
  );

  await githubRequest(
    `/repos/${repo}/issues/${prNumber}/labels`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ labels: [desiredLabel] }),
    },
    [200]
  );
}

function formatFiles(files: string[]): string {
  const shown = files.slice(0, 8).map((file) => `\`${file}\``);
  if (files.length > shown.length) {
    shown.push(`and ${files.length - shown.length} more`);
  }
  return shown.join(", ") || "none";
}

function formatPlanComment(
  item: MergePlanItem,
  plan: MergePlan,
  lastMergeAttempt?: string
): string {
  const overlap = item.overlapWith.length > 0
    ? item.overlapWith.map((number) => `#${number}`).join(", ")
    : "none";
  const queueRank = item.queueRank ? `\nQueue rank: ${item.queueRank}` : "";
  const reasons = item.reasons.map((reason) => `- ${reason}`).join("\n");
  const mergeAttempt = lastMergeAttempt
    ? `\nLast merge attempt:\n- ${lastMergeAttempt}\n`
    : "";

  return `${PLAN_COMMENT_MARKER}
### Merge triage

Status: \`${MERGE_TRIAGE_LABELS[item.status]}\`${queueRank}
Generated: ${plan.generatedAt}

Reasons:
${reasons}

Overlap: ${overlap}
Risk score: ${item.riskScore}
Checks visibility: \`${item.candidate.checksState ?? "unknown"}\`
Files: ${formatFiles(item.candidate.files)}
${mergeAttempt}
Repository queue: ${plan.ready.length} ready, ${plan.queued.length} queued, ${plan.waiting.length} waiting, ${plan.blocked.length} blocked, ${plan.conflicts.length} conflict, ${plan.stale.length} stale.

Merge triage merges at most ${maxMergesPerRun()} ready PR(s) per repository per run, then rechecks the remaining queue on the next pass.`;
}

async function upsertPlanComment(
  repo: string,
  prNumber: number,
  token: string,
  body: string
): Promise<void> {
  const comments = await githubPaginatedRequest<GitHubIssueComment>(
    `/repos/${repo}/issues/${prNumber}/comments`,
    token
  );
  const existing = comments.find((comment) => comment.body?.includes(PLAN_COMMENT_MARKER));

  if (existing) {
    if (existing.body === body) {
      return;
    }

    await githubRequest(
      `/repos/${repo}/issues/comments/${existing.id}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
      },
      [200]
    );
    return;
  }

  await githubRequest(
    `/repos/${repo}/issues/${prNumber}/comments`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    [201]
  );
}

async function storePlanArtifact(repo: string, plan: MergePlan): Promise<void> {
  const payload = {
    repo,
    generatedAt: plan.generatedAt,
    items: plan.items.map((item) => ({
      number: item.candidate.number,
      title: item.candidate.title,
      url: item.candidate.url,
      status: item.status,
      label: MERGE_TRIAGE_LABELS[item.status],
      reasons: item.reasons,
      riskScore: item.riskScore,
      overlapWith: item.overlapWith,
      queueRank: item.queueRank,
      files: item.candidate.files,
      checksState: item.candidate.checksState,
      mergeableState: item.candidate.mergeableState,
      headSha: item.candidate.headSha,
    })),
  };

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: `merge-triage/${repo}/latest.json`,
    Body: JSON.stringify(payload, null, 2),
    ContentType: "application/json",
  }));
}

async function requestBranchUpdate(
  repo: string,
  token: string,
  item: MergePlanItem
): Promise<void> {
  const response = await githubRequest(
    `/repos/${repo}/pulls/${item.candidate.number}/update-branch`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({ expected_head_sha: item.candidate.headSha }),
    },
    [200, 202, 409, 422]
  );

  if (response.status === 200 || response.status === 202) {
    console.log(`Requested branch update for ${repo}#${item.candidate.number}`);
    return;
  }

  const body = await response.text();
  console.log(
    `Branch update skipped for ${repo}#${item.candidate.number}: ${response.status} ${body}`
  );
}

async function postComment(
  repo: string,
  prNumber: number,
  token: string,
  body: string
): Promise<void> {
  await githubRequest(
    `/repos/${repo}/issues/${prNumber}/comments`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    [201]
  );
}

async function attemptMerge(
  repo: string,
  token: string,
  item: MergePlanItem
): Promise<{ merged: boolean; message: string }> {
  const response = await githubRequest(
    `/repos/${repo}/pulls/${item.candidate.number}/merge`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        commit_title: `Auto-merge: ${item.candidate.title}`,
        commit_message: `Merged by merge triage after review approval, hold period, and queue checks.`,
        merge_method: "squash",
        sha: item.candidate.headSha,
      }),
    },
    [200, 405, 409, 422]
  );

  if (response.status !== 200) {
    const body = await response.text();
    return {
      merged: false,
      message: `GitHub merge API returned ${response.status}: ${body}`,
    };
  }

  const result = await response.json() as { merged?: boolean; sha?: string };
  if (!result.merged) {
    return {
      merged: false,
      message: "GitHub accepted the merge request but did not report a merged PR.",
    };
  }

  return {
    merged: true,
    message: `Merged with ${result.sha ?? "unknown merge SHA"}.`,
  };
}

async function syncPlanToGitHub(
  repo: string,
  token: string,
  plan: MergePlan
): Promise<void> {
  for (const item of plan.items) {
    await setMergeLabel(repo, item.candidate.number, token, item.status);
    await upsertPlanComment(
      repo,
      item.candidate.number,
      token,
      formatPlanComment(item, plan)
    );
  }
}

async function handleRepo(
  repo: string,
  appConfig: GitHubAppConfig
): Promise<RepoSummary> {
  const { owner, name } = parseRepoSlug(repo);
  const token = await getInstallationToken(owner, name, appConfig);
  const repoInfo = await getRepositoryInfo(repo, token);
  if (repoInfo.archived) {
    return skippedRepoSummary(repo, "Repository is archived/read-only.");
  }
  if (repoInfo.disabled) {
    return skippedRepoSummary(repo, "Repository is disabled.");
  }

  const mergeHoldConfig = await getRepoMergeHoldConfig(repo, token);

  await ensureMergeLabels(repo, token);

  const candidates = await discoverCandidates(repo, token, mergeHoldConfig);
  const plan = planMergeTriage(candidates, {
    defaultHoldMinutes: mergeHoldConfig.merge_hold_minutes,
    maxReady: maxMergesPerRun(),
  });

  await storePlanArtifact(repo, plan);
  await syncPlanToGitHub(repo, token, plan);

  for (const item of plan.stale) {
    await requestBranchUpdate(repo, token, item);
  }

  let merged = 0;
  let mergeFailures = 0;

  if (isAutoMergeEnabled()) {
    for (const item of plan.ready) {
      const result = await attemptMerge(repo, token, item);
      if (result.merged) {
        merged += 1;
        await postComment(
          repo,
          item.candidate.number,
          token,
          `Merge triage auto-merged this PR.\n\n${result.message}`
        );
        continue;
      }

      mergeFailures += 1;
      await setMergeLabel(repo, item.candidate.number, token, "blocked");
      await upsertPlanComment(
        repo,
        item.candidate.number,
        token,
        formatPlanComment(
          { ...item, status: "blocked", reasons: ["Merge attempt failed."] },
          plan,
          result.message
        )
      );
    }
  }

  return {
    repo,
    candidates: plan.items.length,
    ready: plan.ready.length,
    queued: plan.queued.length,
    waiting: plan.waiting.length,
    blocked: plan.blocked.length,
    conflicts: plan.conflicts.length,
    stale: plan.stale.length,
    merged,
    mergeFailures,
  };
}

export async function handler() {
  console.log("Merge triage handler triggered");

  const [appId, privateKey] = await Promise.all([
    getParameter(GITHUB_APP_ID_PARAM),
    getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
  ]);
  const appConfig: GitHubAppConfig = { appId, privateKey };
  const repos = MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;
  const summaries: RepoSummary[] = [];

  for (const repo of repos) {
    try {
      summaries.push(await handleRepo(repo, appConfig));
    } catch (error) {
      const skipReason = repoSkipReason(error);
      if (skipReason) {
        console.log(`Merge triage skipped ${repo}: ${skipReason}`);
        summaries.push(skippedRepoSummary(repo, skipReason));
        continue;
      }

      console.error(`Merge triage failed for ${repo}:`, error);
      summaries.push({
        repo,
        candidates: 0,
        ready: 0,
        queued: 0,
        waiting: 0,
        blocked: 0,
        conflicts: 0,
        stale: 0,
        merged: 0,
        mergeFailures: 1,
      });
    }
  }

  console.log("Merge triage completed", JSON.stringify(summaries));

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Merge triage completed",
      summaries,
    }),
  };
}
