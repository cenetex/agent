/**
 * Types for the immutable task contract system
 */
import { createSign } from "crypto";

export interface GitHubAppConfig {
  /** GitHub App ID */
  appId: string;
  /** GitHub App private key (PEM format) */
  privateKey: string;
}

export interface InstallationTokenResponse {
  /** The installation token */
  token: string;
  /** Token expiration time */
  expires_at: string;
}

/**
 * Creates a JWT for GitHub App authentication
 */
export function createGitHubAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issues 1 minute in the past
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(privateKey).toString("base64url");

  return `${signatureInput}.${signature}`;
}

/**
 * Gets the installation ID for a repository using GitHub App JWT
 */
export async function getInstallationId(
  repoOwner: string,
  repoName: string,
  appJWT: string
): Promise<number> {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/installation`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJWT}`,
        "User-Agent": "github-agent-control-plane",
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to get installation ID for ${repoOwner}/${repoName}: ${response.status} ${errorBody}`
    );
  }

  const installation = await response.json() as any;
  return installation.id;
}

/**
 * Mints an installation token for a GitHub App installation
 */
export async function createInstallationToken(
  installationId: number,
  appJWT: string
): Promise<InstallationTokenResponse> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJWT}`,
        "User-Agent": "github-agent-control-plane",
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to create installation token for installation ${installationId}: ${response.status} ${errorBody}`
    );
  }

  return await response.json() as InstallationTokenResponse;
}

/**
 * Gets a GitHub App installation token for a repository
 */
export async function getInstallationToken(
  repoOwner: string,
  repoName: string,
  appConfig: GitHubAppConfig
): Promise<string> {
  const jwt = createGitHubAppJWT(appConfig.appId, appConfig.privateKey);
  const installationId = await getInstallationId(repoOwner, repoName, jwt);
  const tokenResponse = await createInstallationToken(installationId, jwt);
  return tokenResponse.token;
}

export interface TaskPayload {
  /** Unique identifier for this task execution */
  task_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** The original reference that was requested (branch, tag, PR) */
  requested_ref: string;
  /** The immutable commit SHA that was resolved from requested_ref */
  resolved_commit_sha: string;
  /** Issue or PR metadata */
  issue_metadata: IssueMetadata;
  /** Task execution mode */
  task_mode: "issue" | "pull_request" | "planning" | "diagnostic";
  /** Institutional role performing the task */
  agent_class?: "developer" | "reviewer" | "researcher" | "archivist" | "operator" | "trainer" | "miner" | "commander" | "courier" | string;
  /** Timestamp when task was created */
  created_at: string;
  /** Model to use for this task, defaults based on task type if not specified */
  model?: string;
}

export interface IssueMetadata {
  /** Issue or PR number */
  number: number;
  /** Issue or PR title */
  title: string;
  /** Issue or PR body */
  body: string;
  /** Array of label names */
  labels: string[];
  /** For PRs: the head branch name */
  head_ref?: string;
  /** For PRs: the base branch name */
  base_ref?: string;
  /** Author of the issue/PR */
  author: string;
}

/**
 * Task lifecycle states
 */
export type TaskLifecycleState =
  | "requested"     // Task has been created and queued
  | "running"       // Task is currently executing
  | "succeeded"     // Task completed successfully
  | "failed"        // Task failed during execution
  | "timed_out"     // Task exceeded time limit
  | "waiting";      // Task is waiting for user input

/**
 * Task metadata record for persistence
 */
export interface TaskMetadata {
  /** Unique task identifier */
  task_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** Issue or PR number */
  issue_number: number;
  /** Task execution mode */
  task_mode: "issue" | "pull_request" | "planning" | "diagnostic";
  /** Institutional role performing the task */
  agent_class?: string;
  /** Current lifecycle state */
  status: TaskLifecycleState;
  /** The original reference that was requested */
  requested_ref: string;
  /** The immutable commit SHA that was resolved */
  resolved_commit_sha: string;
  /** Fargate task ARN */
  task_arn?: string;
  /** S3 artifact prefix for this task */
  artifact_prefix: string;
  /** Task creation timestamp */
  created_at: string;
  /** Task start timestamp */
  started_at?: string;
  /** Task completion timestamp */
  completed_at?: string;
  /** Error message if failed */
  error_message?: string;
  /** Failure category for classification and retry decision (e.g., credit_exhaustion, timeout, auth_failure) */
  failure_category?: string;
  /** Created PR URL if applicable */
  pr_url?: string;
  /** Issue/PR metadata at task creation time */
  issue_metadata: IssueMetadata;
  /** Number of times this task has been retried due to transient failures */
  retry_count?: number;
  /** Model used for this task */
  model?: string;
  /** Executor used inside the agent container */
  executor?: "custom" | "codex" | string;
  /** History of retry attempts for this task */
  retry_attempts?: Array<{
    timestamp: string;
    reason: string;
    old_status: TaskLifecycleState;
  }>;
}

/**
 * Artifact manifest for a task execution
 */
export interface TaskArtifacts {
  /** Unique task identifier */
  task_id: string;
  /** Task metadata file location */
  metadata_key: string;
  /** Agent log file location */
  log_key?: string;
  /** Summary file location */
  summary_key?: string;
  /** Exit code from task execution */
  exit_code?: number;
  /** Size of artifacts in bytes */
  total_size_bytes?: number;
  /** Artifact creation timestamp */
  created_at: string;
}

/**
 * Feedback example for few-shot learning
 */
export interface FeedbackExample {
  /** Unique identifier for this example */
  example_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** Task type: issue or pull_request */
  task_type: "issue" | "pull_request";
  /** Outcome: merged (success) or closed (human rejection) */
  outcome: "merged" | "closed";
  /** The task that created this example */
  task_id: string;
  /** Original task payload */
  task_payload: TaskPayload;
  /** PR diff (truncated to ~5KB for context) */
  pr_diff?: string;
  /** Human comments on closed PR (if applicable) */
  human_comments?: string;
  /** When the task was created */
  created_at: string;
  /** When the outcome occurred (PR merge/close timestamp) */
  outcome_at: string;
}

/**
 * Rolling index of feedback examples for a repository and task type
 */
export interface FeedbackExampleIndex {
  /** Repository in owner/name format */
  repo_slug: string;
  /** Task type filter */
  task_type: "issue" | "pull_request" | "all";
  /** List of recorded examples with basic metadata */
  examples: Array<{
    example_id: string;
    outcome: "merged" | "closed";
    created_at: string;
    outcome_at: string;
  }>;
  /** Last updated timestamp */
  updated_at: string;
}

export interface TaskResult {
  /** Unique task identifier */
  task_id: string;
  /** Task completion status */
  status: "succeeded" | "failed" | "waiting";
  /** Commit SHA that was checked out */
  resolved_commit_sha: string;
  /** Error message if failed */
  error?: string;
  /** Created PR URL if applicable */
  pr_url?: string;
  /** Task execution timestamps */
  timestamps: {
    started_at: string;
    completed_at: string;
  };
}

export interface TaskEnvironment {
  /** S3 key for the task payload (preferred for large payloads) */
  TASK_PAYLOAD_S3_KEY?: string;
  /** The complete task payload as JSON string (backwards compat fallback) */
  TASK_PAYLOAD: string;
  /** GitHub installation token for API access */
  GITHUB_TOKEN: string;
  /** OpenRouter API key */
  OPENROUTER_API_KEY: string;
  /** S3 bucket for artifacts */
  ARTIFACTS_BUCKET: string;
  /** S3 prefix for this task's artifacts */
  ARTIFACT_PREFIX: string;
  /** Signal labels for status tracking */
  TRIGGER_LABEL: string;
  SIGNAL_LABEL_RUNNING: string;
  SIGNAL_LABEL_WAITING: string;
  SIGNAL_LABEL_FAILED: string;
  SIGNAL_LABEL_SUCCEEDED: string;
}

/**
 * Generates a unique task ID using timestamp and random string
 */
export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `task_${timestamp}_${random}`;
}

/**
 * Parses a repository slug into owner and name components
 */
export function parseRepoSlug(repoSlug: string): { owner: string; name: string } {
  const [owner, name] = repoSlug.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repository slug: ${repoSlug}`);
  }
  return { owner, name };
}

/**
 * Creates a repository slug from owner and name
 */
export function createRepoSlug(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/**
 * Creates a predictable artifact prefix for a task
 */
export function createArtifactPrefix(repoSlug: string, taskId: string): string {
  return `tasks/${repoSlug}/${taskId}`;
}

/**
 * Creates standardized S3 keys for task artifacts
 */
export function createArtifactKeys(artifactPrefix: string) {
  return {
    metadata: `${artifactPrefix}/metadata.json`,
    log: `${artifactPrefix}/agent.log`,
    summary: `${artifactPrefix}/summary.md`,
    manifest: `${artifactPrefix}/manifest.json`,
  };
}

/**
 * Generates a unique example ID using timestamp and random string
 */
export function generateExampleId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `ex_${timestamp}_${random}`;
}

/**
 * Creates the S3 path for a feedback example
 */
export function createFeedbackExamplePath(
  repoSlug: string,
  outcome: "merged" | "closed",
  exampleId: string
): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return `feedback-examples/${repoSlug}/${outcome}/${date}/${exampleId}.json`;
}

/**
 * Creates the S3 path for the feedback index
 */
export function createFeedbackIndexPath(
  repoSlug: string,
  taskType: "issue" | "pull_request"
): string {
  return `feedback-examples/${repoSlug}/${taskType}/index.json`;
}

/**
 * Creates initial task metadata when task is requested
 */
export function createInitialTaskMetadata(
  taskPayload: TaskPayload,
  taskArn?: string
): TaskMetadata {
  const artifactPrefix = createArtifactPrefix(
    taskPayload.repo_slug,
    taskPayload.task_id
  );

  return {
    task_id: taskPayload.task_id,
    repo_slug: taskPayload.repo_slug,
    issue_number: taskPayload.issue_metadata.number,
    task_mode: taskPayload.task_mode,
    agent_class: taskPayload.agent_class,
    status: "requested",
    requested_ref: taskPayload.requested_ref,
    resolved_commit_sha: taskPayload.resolved_commit_sha,
    task_arn: taskArn,
    artifact_prefix: artifactPrefix,
    created_at: taskPayload.created_at,
    model: taskPayload.model,
    issue_metadata: taskPayload.issue_metadata,
  };
}

/**
 * Review Agent Types
 */

export interface ReviewPayload {
  /** Unique identifier for this review task */
  task_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** PR number to review */
  pr_number: number;
  /** The commit SHA at the head of the PR */
  head_sha: string;
  /** The base branch commit SHA */
  base_sha: string;
  /** PR metadata */
  pr_metadata: PRMetadata;
  /** Timestamp when review was requested */
  created_at: string;
}

export interface PRMetadata {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR body */
  body: string;
  /** Array of label names */
  labels: string[];
  /** PR author */
  author: string;
  /** Head branch name */
  head_ref: string;
  /** Base branch name */
  base_ref: string;
  /** Created by the coding agent */
  created_by_bot: boolean;
}

export interface ReviewResult {
  /** Unique review task identifier */
  task_id: string;
  /** PR number that was reviewed */
  pr_number: number;
  /** Review decision: approved, changes_requested, or error */
  decision: "approved" | "changes_requested" | "error";
  /** Structured review findings */
  findings: ReviewFindings;
  /** Error message if review failed */
  error?: string;
  /** Review completion timestamp */
  completed_at: string;
}

export interface ReviewFindings {
  /** Does the code compile/pass linting? */
  compilation: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Are there security issues? */
  security: {
    status: "pass" | "fail" | "unknown";
    issues?: string[];
  };
  /** Does it address the linked issue? */
  issue_alignment: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Are there obvious logic errors? */
  logic: {
    status: "pass" | "fail" | "unknown";
    issues?: string[];
  };
  /** Does it introduce unnecessary complexity? */
  complexity: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Is the cost impact reasonable? */
  cost_impact: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Overall summary */
  summary: string;
}

export interface ReviewEnvironment {
  /** S3 key for the review payload (preferred for large payloads) */
  REVIEW_PAYLOAD_S3_KEY?: string;
  /** The complete review payload as JSON string (backwards compat fallback) */
  REVIEW_PAYLOAD?: string;
  /** GitHub installation token for API access */
  GITHUB_TOKEN: string;
  /** OpenRouter API key for model access */
  OPENROUTER_API_KEY: string;
  /** S3 bucket for review artifacts */
  ARTIFACTS_BUCKET: string;
  /** S3 prefix for this review's artifacts */
  ARTIFACT_PREFIX: string;
  /** Repository in owner/name format */
  REPO: string;
  /** PR number being reviewed */
  PR_NUMBER: string;
  /** Review criteria configuration */
  REVIEW_CRITERIA: string;
}

/**
 * Credit system types for billing and revenue
 */

export interface CreditBalance {
  /** Repository in owner/name format */
  repo_slug: string;
  /** Current available credits (can be negative for debt tracking) */
  current_balance: number;
  /** Total credits purchased (cumulative) */
  total_purchased: number;
  /** Total credits spent on completed tasks */
  total_spent: number;
  /** Last update timestamp */
  last_updated: string;
  /** Version for optimistic locking / concurrency control */
  version: number;
}

export interface CreditTransaction {
  /** Transaction timestamp */
  timestamp: string;
  /** Transaction type: credit (purchase), debit (task charge), refund (failed task) */
  type: "credit" | "debit" | "refund";
  /** Amount of credits (positive for credit/refund, positive for debit amount) */
  amount: number;
  /** Human-readable reason */
  reason: string;
  /** Task ID if this is a debit/refund transaction */
  task_id: string | null;
  /** Model used for task (if applicable) */
  model?: string;
}

/**
 * Cost function: maps model to credit debit amount.
 * Pricing: 1 credit = $0.10. GLM 5.2 keeps the existing Sonnet-tier default
 * until usage-based accounting is available.
 */
export function getModelCost(model: string): number {
  if (model.includes("glm-5.2")) return 12;
  if (model.includes("haiku")) return 4;      // $0.40
  if (model.includes("sonnet")) return 12;    // $1.20
  if (model.includes("opus")) return 20;      // $2.00
  return 12; // Default to sonnet price
}

/**
 * Creates the S3 path for a credit balance file
 */
export function createCreditBalancePath(repoSlug: string): string {
  return `credits/${repoSlug}/balance.json`;
}

/**
 * Creates the S3 path for a credit transaction ledger
 * Uses date-based partitioning for easy querying
 */
export function createCreditLedgerPath(repoSlug: string, date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `credits/${repoSlug}/ledger/${yyyy}/${mm}/transactions.jsonl`;
}

/**
 * Escalation system types for routing items needing human attention
 */

export type EscalationTriggerType =
  | "repeated_failure"      // Agent failed on same issue 3+ times
  | "pr_stale"              // PR open >48 hours with no merge
  | "waiting_question"      // Agent asked a question that can't be resolved
  | "security_sensitive"    // Security-labeled issue or CVE change
  | "production_config"     // Touches production deploy or secrets
  | "low_credits";          // Credit balance below threshold

export interface EscalationItem {
  /** Unique escalation ID */
  escalation_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** Issue or PR number */
  issue_number: number;
  /** Trigger type that caused escalation */
  trigger_type: EscalationTriggerType;
  /** Human-readable reason/context */
  reason: string;
  /** Suggested action to resolve escalation */
  suggested_action: string;
  /** GitHub URL to the issue/PR */
  github_url: string;
  /** Timestamp when escalation was created */
  created_at: string;
  /** Optional additional context or data */
  context?: Record<string, any>;
}

export interface EscalationQueue {
  /** List of active escalation items */
  items: EscalationItem[];
  /** Last updated timestamp */
  updated_at: string;
  /** Version for optimistic locking */
  version: number;
}

export interface EscalationConfig {
  /** Repository in owner/name format */
  repo_slug: string;
  /** Enable escalation routing */
  enabled: boolean;
  /** Failure threshold before escalating (default: 3) */
  failure_threshold: number;
  /** PR staleness threshold in hours (default: 48) */
  pr_staleness_hours: number;
  /** Low credit threshold (default: 5) */
  low_credit_threshold: number;
  /** Optional webhook URL for notifications (Slack, Telegram, etc.) */
  webhook_url?: string;
  /** Last updated timestamp */
  updated_at: string;
}

/**
 * Generates a unique escalation ID
 */
export function generateEscalationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `esc_${timestamp}_${random}`;
}

/**
 * Creates the S3 path for the escalation queue
 */
export function createEscalationQueuePath(repoSlug: string): string {
  return `escalations/${repoSlug}/queue.json`;
}

/**
 * Creates the S3 path for escalation configuration
 */
export function createEscalationConfigPath(repoSlug: string): string {
  return `escalations/${repoSlug}/config.json`;
}

/**
 * Creates the S3 path for escalation history
 */
export function createEscalationHistoryPath(repoSlug: string): string {
  const date = new Date().toISOString().split("T")[0];
  return `escalations/${repoSlug}/history/${date}/events.jsonl`;
}

/**
 * Bot usernames for the coding agent — used to identify bot-created PRs
 */
export const CODING_AGENT_BOT_LOGINS = [
  "cenetex[bot]",
  "cenetex-coding-agent[bot]",
  "github-agent[bot]",
];

/**
 * GitHub logins are case-insensitive, but trust decisions must otherwise use
 * exact identity matching. Substring matching lets an attacker choose a login
 * such as "evil-cenetex-contributor" and inherit bot privileges.
 */
export function isCodingAgentLogin(login: string): boolean {
  const normalized = login.trim().toLowerCase();
  return CODING_AGENT_BOT_LOGINS.some(
    candidate => candidate.toLowerCase() === normalized
  );
}

/**
 * Protected file patterns that should never be auto-merged.
 * Single source of truth — imported by both webhook-handler and review-handler.
 */
export const PROTECTED_PATHS = [
  ".github/workflows/",
  "infra/lib/stack.ts",
  "infra/bin/",
  "infra/cdk.json",
  "Dockerfile",
  "deploy.sh",
  ".env",
  "credentials",
  "secrets",
  "*.key",
  "*.pem",
];
