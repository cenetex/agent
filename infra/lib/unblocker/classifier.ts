/**
 * Unblocker Failure Classifier
 *
 * Reads the latest failure-graph snapshot and analyzes failure patterns.
 * Implements retry logic for eventual consistency of `latest.json`.
 *
 * The collector writes snapshots then updates `latest.json`. During the
 * window between snapshot write and `latest.json` update, readers may
 * see `latest.json` pointing to a not-yet-available snapshot (404).
 * This classifier handles that with exponential backoff.
 */

import {
  S3Client,
  GetObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";

export interface FailureSnapshot {
  snapshot_id: string;
  collected_at: string;
  repos: Record<string, any>;
}

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load the latest failure snapshot from S3 with retry logic for eventual consistency.
 *
 * Handles the case where `latest.json` points to a snapshot that is still being written.
 * Uses exponential backoff to retry.
 *
 * @param s3Client S3 client instance
 * @param bucketName S3 bucket name
 * @param options Retry configuration (maxAttempts, baseDelayMs, maxDelayMs)
 * @returns The latest snapshot or null if unavailable after all retries
 */
export async function loadLatestSnapshotWithRetry(
  s3Client: S3Client,
  bucketName: string,
  options: RetryOptions = {}
): Promise<FailureSnapshot | null> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // First, fetch latest.json to get the pointer
      const latestResult = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: "unblocker/snapshots/latest.json",
        })
      );

      const latestContent = await latestResult.Body?.transformToString();
      if (!latestContent) {
        throw new Error("latest.json is empty");
      }

      const latestPointer = JSON.parse(latestContent) as { snapshot_key: string };

      // Now fetch the actual snapshot
      const snapshotResult = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: latestPointer.snapshot_key,
        })
      );

      const snapshotContent = await snapshotResult.Body?.transformToString();
      if (!snapshotContent) {
        throw new Error(`Snapshot at ${latestPointer.snapshot_key} is empty`);
      }

      return JSON.parse(snapshotContent) as FailureSnapshot;
    } catch (error) {
      lastError = error as Error;

      // If it's a NoSuchKey error and we have more attempts, retry
      if (error instanceof NoSuchKey && attempt < maxAttempts) {
        const delayMs = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs
        );
        console.warn(
          `Snapshot not yet available (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms: ${error.message}`
        );
        await sleep(delayMs);
        continue;
      }

      // For non-404 errors on last attempt, or 404 on last attempt after retries
      if (attempt === maxAttempts) {
        console.error(
          `Failed to load latest snapshot after ${maxAttempts} attempts: ${error}`
        );
      }
    }
  }

  return null;
}

/**
 * Load a specific snapshot from S3 by its key.
 *
 * @param s3Client S3 client instance
 * @param bucketName S3 bucket name
 * @param snapshotKey S3 key to the snapshot (e.g., "unblocker/snapshots/2026-05-03-15-23-45.json")
 * @returns The snapshot or null if not found
 */
export async function loadSnapshotByKey(
  s3Client: S3Client,
  bucketName: string,
  snapshotKey: string
): Promise<FailureSnapshot | null> {
  try {
    const result = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: snapshotKey,
      })
    );

    const content = await result.Body?.transformToString();
    if (!content) {
      return null;
    }

    return JSON.parse(content) as FailureSnapshot;
  } catch (error) {
    console.error(`Failed to load snapshot ${snapshotKey}: ${error}`);
    return null;
  }
}

/**
 * Analyze failure patterns in a snapshot.
 * This is a placeholder for future classification logic.
 *
 * @param snapshot The failure snapshot to analyze
 * @returns Classification results
 */
export interface FailureClassification {
  total_failures: number;
  failures_by_repo: Record<string, number>;
  failures_by_category: Record<string, number>;
  critical_blockers: Array<{ repo: string; issue: number; blocker_count: number }>;
}

export function classifyFailures(snapshot: FailureSnapshot): FailureClassification {
  const classification: FailureClassification = {
    total_failures: 0,
    failures_by_repo: {},
    failures_by_category: {},
    critical_blockers: [],
  };

  for (const [repoSlug, repoData] of Object.entries(snapshot.repos)) {
    const repoFailures =
      (repoData.issues?.length ?? 0) + (repoData.pull_requests?.length ?? 0);
    classification.total_failures += repoFailures;
    classification.failures_by_repo[repoSlug] = repoFailures;

    // Count by category
    for (const issue of repoData.issues ?? []) {
      if (issue.error_category) {
        classification.failures_by_category[issue.error_category] =
          (classification.failures_by_category[issue.error_category] ?? 0) + 1;
      }
    }

    for (const pr of repoData.pull_requests ?? []) {
      if (pr.error_category) {
        classification.failures_by_category[pr.error_category] =
          (classification.failures_by_category[pr.error_category] ?? 0) + 1;
      }
    }

    // Identify critical blockers (issues blocked by many other issues)
    const blockerMap: Record<number, number> = {};
    for (const ref of repoData.cross_references ?? []) {
      if (ref.type === "blocked_by" && ref.from.repo === repoSlug) {
        blockerMap[ref.from.issue_number] =
          (blockerMap[ref.from.issue_number] ?? 0) + 1;
      }
    }

    for (const [issueNum, blockerCount] of Object.entries(blockerMap)) {
      if (blockerCount >= 2) {
        // Critical: blocked by 2+ issues
        classification.critical_blockers.push({
          repo: repoSlug,
          issue: parseInt(issueNum, 10),
          blocker_count: blockerCount,
        });
      }
    }
  }

  return classification;
}
