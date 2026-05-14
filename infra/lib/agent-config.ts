export interface DispatchConfig {
  auto_dispatch: boolean;
  auto_dispatch_labels: string[];
  wip_cap: number;
  max_concurrent: number;
}

export interface MergeHoldConfig {
  merge_hold_minutes: number;
  merge_hold_minutes_infra: number;
}

export interface AgentConfig {
  model: string | null;
  dispatch: DispatchConfig;
  mergeHold: MergeHoldConfig;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  auto_dispatch: true,
  auto_dispatch_labels: ["ready"],
  wip_cap: 0,
  max_concurrent: 3,
};

export const DEFAULT_MERGE_HOLD_CONFIG: MergeHoldConfig = {
  merge_hold_minutes: 60,
  merge_hold_minutes_infra: 120,
};

function getConfigValue(content: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escapedKey}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parseNonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseLabelList(value: string | null, fallback: string[]): string[] {
  if (value === null) return fallback;
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

export function parseAgentConfig(content: string): AgentConfig {
  const model = getConfigValue(content, "model");

  return {
    model,
    dispatch: {
      auto_dispatch: parseBoolean(
        getConfigValue(content, "auto_dispatch"),
        DEFAULT_DISPATCH_CONFIG.auto_dispatch
      ),
      auto_dispatch_labels: parseLabelList(
        getConfigValue(content, "auto_dispatch_labels"),
        DEFAULT_DISPATCH_CONFIG.auto_dispatch_labels
      ),
      wip_cap: parseNonNegativeInteger(
        getConfigValue(content, "wip_cap"),
        DEFAULT_DISPATCH_CONFIG.wip_cap
      ),
      max_concurrent: parseNonNegativeInteger(
        getConfigValue(content, "max_concurrent"),
        DEFAULT_DISPATCH_CONFIG.max_concurrent
      ),
    },
    mergeHold: {
      merge_hold_minutes: parseNonNegativeInteger(
        getConfigValue(content, "merge_hold_minutes"),
        DEFAULT_MERGE_HOLD_CONFIG.merge_hold_minutes
      ),
      merge_hold_minutes_infra: parseNonNegativeInteger(
        getConfigValue(content, "merge_hold_minutes_infra"),
        DEFAULT_MERGE_HOLD_CONFIG.merge_hold_minutes_infra
      ),
    },
  };
}
