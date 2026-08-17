const AUTO_MERGE_BLOCKING_LABELS = new Set([
  "pause-agent",
  "review:human-required",
]);

export function hasBlockingAutoMergeLabel(labels: string[]): boolean {
  return labels.some((label) => AUTO_MERGE_BLOCKING_LABELS.has(label));
}
