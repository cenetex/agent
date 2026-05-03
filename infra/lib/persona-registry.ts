/**
 * Persona Registry
 *
 * Maps `role:<id>` labels to persona profiles defined as YAML in
 * agent/agents/**\/<id>.yaml. The webhook handler uses this to:
 *   1. Detect when an issue carries a `role:<id>` label
 *   2. Validate the persona exists
 *   3. Inject `persona_id` into TaskPayload
 *
 * The container's entrypoint.sh does the actual loading/parsing at runtime
 * (the YAML files are baked into the Docker image at /agents/).
 *
 * To add a new persona:
 *   1. Drop <id>.yaml + <id>.md into agent/agents/<board>/
 *   2. Add the id to KNOWN_PERSONAS below
 *   3. Add a `role:<id>` label to repos that should be able to dispatch it
 *
 * Future enhancement (cenetex/agent#395): replace KNOWN_PERSONAS with
 * runtime YAML scanning so this list stays in sync automatically.
 */

/**
 * Persona IDs known to the dispatcher. Every entry must have a corresponding
 * `agent/agents/<board>/<id>.yaml` + `<id>.md` file in the repo.
 *
 * IDs are in `<board>-<role>` form to make label parsing trivial.
 */
export const KNOWN_PERSONAS: ReadonlySet<string> = new Set([
  // Change Advisory Board (operational governance, weekly Mondays)
  "cab-marcus", // SRE Lead
  "cab-priya", // AppSec Engineer
  "cab-jamie", // Product Reliability Manager

  // Architecture Review Board (design governance, weekly Wednesdays)
  "arb-noor", // Principal Architect
  "arb-dmitri", // Platform Engineer
  "arb-sasha", // Refactor / Tech Debt Pragmatist

  // CTO (strategic synthesis)
  "cto-weekly", // Sunday briefing — picks 2 of 6 voices to feature
  "cto-quarterly", // Quarterly Board Pack — synthesizes 13 weeks

  // Board of Directors (quarterly oversight, no weekly cadence)
  "board-eleanor", // Independent Director, Governance & Risk
  "board-hassan", // Technical Advisor
  "board-yuki", // Strategic / GTM Advisor
]);

/**
 * Label prefix that signals a persona-typed dispatch.
 *
 * Convention: `role:<persona-id>`. The trigger label `agent` still must be
 * present — `role:` only narrows behavior when the agent dispatches.
 */
export const ROLE_LABEL_PREFIX = "role:";

/**
 * Extract the persona ID from a list of labels, if any.
 *
 * Returns `null` if no `role:<id>` label is present. Returns the first
 * matching persona ID if multiple are set (which would be a label-hygiene bug).
 *
 * Returns `null` (not throws) for unknown persona IDs — the caller decides
 * how to handle "label says role:foobar but no profile exists." We log+ignore
 * rather than reject the dispatch.
 */
export function extractPersonaId(labels: readonly string[]): string | null {
  for (const label of labels) {
    if (!label.startsWith(ROLE_LABEL_PREFIX)) continue;
    const id = label.slice(ROLE_LABEL_PREFIX.length).trim();
    if (KNOWN_PERSONAS.has(id)) return id;
    // Unknown role:* label — don't fail dispatch, just don't apply a profile.
    // Log so it's visible in CloudWatch.
    console.warn(
      `[persona-registry] Label ${label} does not match a known persona. ` +
        `Dispatch will use the default agent flow. ` +
        `If this persona should exist, add it to KNOWN_PERSONAS in ` +
        `infra/lib/persona-registry.ts and ship a YAML+MD pair under agent/agents/.`,
    );
    return null;
  }
  return null;
}

/**
 * Returns true if the labels indicate this is a persona-typed dispatch
 * (regardless of whether the persona is known).
 *
 * Used by the dispatcher to short-circuit the default-flow checks (e.g.,
 * the "main CI must be healthy" gate doesn't apply to a board member's
 * read-only review).
 */
export function isPersonaDispatch(labels: readonly string[]): boolean {
  return labels.some((label) => label.startsWith(ROLE_LABEL_PREFIX));
}
