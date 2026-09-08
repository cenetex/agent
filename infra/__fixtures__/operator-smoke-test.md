# Operator Smoke Test

This document describes the smoke test procedure for the operator (read-only
inspection) agent. The smoke test verifies that an issue labeled `agent` +
`operator` dispatches to the diagnostic runtime and produces an evidence
report **without modifying source, labels, credits, or infrastructure**.

## Preconditions

- The diagnostic task definition and IAM role are deployed.
- The operator role contract resolves to read-only with the nine inspection
  tools listed in issue #632.
- The IAM policy fixture (`diagnostic-iam-policy.json`) matches the deployed
  diagnostic task role.

## Steps

1. Open an issue with the body describing a canary or QA task failure.
2. Add the `agent` label and the `operator` label.
3. Observe the webhook dispatch path:
   - `agentClass` resolves to `"operator"`.
   - `taskMode` resolves to `"diagnostic"`.
   - The Fargate task launches with `DIAGNOSTIC_TASK_DEFINITION_ARN` and
     `DIAGNOSTIC_CONTAINER_NAME`.
4. The diagnostic runtime inspects logs, ECS tasks, S3 artifacts, and GitHub
   issue data using only the nine read-only tools.
5. The runtime produces a diagnostic report with all five sections:
   Observed, Verified, Suspected, Unknown, Recommended.
6. The verifier (`diagnostic-verifier` v2) checks the report:
   - All sections present and non-empty.
   - Every Verified entry has at least one evidence reference.
   - Every evidence reference names an operator tool.
7. The task completes without any source commits, label changes, credit
   deductions, or infrastructure modifications.

## Failure Handling

If the first smoke fails because credentials, log groups, or task metadata
are unavailable, the failure is preserved as a failure record and a follow-up
issue is opened. The failure is not papered over with prompt text.

## Pass Criteria

- [ ] Task dispatches to diagnostic runtime (not developer task definition).
- [ ] Capability packet exposes only the nine operator tools.
- [ ] Evidence report has all five required sections.
- [ ] Verified section has evidence references to operator tools.
- [ ] No source, labels, credits, or infrastructure modified.
