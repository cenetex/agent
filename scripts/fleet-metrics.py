#!/usr/bin/env python3
"""Fleet metrics: the outcome numbers each specialist role must drive down.

Every metric here is a GitHub query, so this runs in Actions and does not
depend on anyone's laptop being awake. Local-disk state (worktrees, dirty
trees) is deliberately out of scope -- that stays with control/prune.py.

Usage:
  fleet-metrics.py --out metrics/fleet.jsonl [--summary $GITHUB_STEP_SUMMARY]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPOS = [
    "atimics/crownlesscarriage",
    "cenetex/agent",
    "cenetex/signal",
    "cenetex/cosyworld",
    "cenetex/ilXyr",
    "atimics/zero-grounded-literary-lm",
    "cenetex/app-ruby-high",
    "atimics/runner-watch",
    "atimics/AutoForwarder",
]

# metric -> the direction that counts as progress
MONOTONIC = {
    "open_issues": "down",
    "merged_branches_live": "down",
    "agent_failed": "down",
    "status_blocked": "down",
}


def gh(args: list[str], default=None):
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return default
    if p.returncode != 0:
        print(f"  warn: gh {' '.join(args[:3])} -> rc={p.returncode} {p.stderr.strip()[:120]}",
              file=sys.stderr)
        return default
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return default


def lines(args: list[str]) -> list[str]:
    """gh call whose output is one plain value per line (paginates safely)."""
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return []
    if p.returncode != 0:
        print(f"  warn: gh {' '.join(args[:2])} -> rc={p.returncode}", file=sys.stderr)
        return []
    return [l.strip() for l in p.stdout.splitlines() if l.strip()]


def count(repo: str, *args: str) -> int:
    return len(gh(["issue", "list", "-R", repo, "--limit", "500", "--json", "number", *args],
                  default=[]))


def measure(repo: str) -> dict:
    since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")

    closed = gh(["issue", "list", "-R", repo, "--state", "closed", "--limit", "500",
                 "--search", f"closed:>={since}", "--json", "stateReason"], default=[])
    not_planned = sum(1 for i in closed if i.get("stateReason") == "NOT_PLANNED")
    completed = sum(1 for i in closed if i.get("stateReason") == "COMPLETED")

    # Reap backlog: merged PR head branches that still exist on the remote.
    # NB: `gh api --paginate --jq` emits one result per page, so a multi-page
    # array is not parseable as a whole. Ask for lines and count them instead.
    branches = set(lines(["api", "--paginate",
                          f"repos/{repo}/branches?per_page=100", "--jq", ".[].name"]))
    merged_heads = {p["headRefName"] for p in
                    gh(["pr", "list", "-R", repo, "--state", "merged", "--limit", "200",
                        "--json", "headRefName"], default=[])}

    return {
        "open_issues": count(repo),
        "open_prs": len(gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "300",
                            "--json", "number"], default=[])),
        "branches": len(branches),
        "merged_branches_live": len(merged_heads & branches),
        "agent_failed": count(repo, "--label", "agent:failed"),
        "status_blocked": count(repo, "--label", "status:blocked"),
        "closed_not_planned_30d": not_planned,
        "closed_completed_30d": completed,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="metrics/fleet.jsonl")
    ap.add_argument("--summary")
    args = ap.parse_args()

    repos, totals = {}, {}
    for r in REPOS:
        print(f"measuring {r}", file=sys.stderr)
        m = measure(r)
        repos[r] = m
        for k, v in m.items():
            totals[k] = totals.get(k, 0) + v

    entry = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "totals": totals, "repos": repos}

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    prev = None
    if out.exists():
        lines = [l for l in out.read_text().splitlines() if l.strip()]
        if lines:
            try:
                prev = json.loads(lines[-1])
            except json.JSONDecodeError:
                pass
    with out.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")

    # 30-day rejection rate: is "no" expressible in this fleet at all?
    np_, cp = totals["closed_not_planned_30d"], totals["closed_completed_30d"]
    rate = (100 * np_ / (np_ + cp)) if (np_ + cp) else 0.0

    rows = ["# Fleet metrics", "", f"_{entry['ts']}_", "",
            "| metric | value | Δ vs last | direction |", "|---|---|---|---|"]
    regressions = []
    for k, v in totals.items():
        d, mark = "", ""
        if prev:
            delta = v - prev["totals"].get(k, v)
            d = f"{delta:+d}" if delta else "0"
            want = MONOTONIC.get(k)
            if want == "down" and delta > 0:
                mark = " ⚠️ wrong way"
                regressions.append(f"{k} {delta:+d}")
            elif want == "down" and delta < 0:
                mark = " ✅"
        rows.append(f"| {k} | {v} | {d} |{mark or ' —'} |")
    rows += ["", f"**30-day rejection rate: {rate:.1f}%** "
                 f"({np_} not-planned / {np_ + cp} closed). "
                 "Healthy repos in this fleet historically run ~12%.", ""]
    if regressions:
        rows.append("**Moved the wrong way:** " + ", ".join(regressions))
    rows += ["", "| repo | open | PRs | branches | to reap | failed | blocked |",
             "|---|---|---|---|---|---|---|"]
    for r, m in sorted(repos.items(), key=lambda kv: -kv[1]["open_issues"]):
        rows.append(f"| {r} | {m['open_issues']} | {m['open_prs']} | {m['branches']} | "
                    f"{m['merged_branches_live']} | {m['agent_failed']} | {m['status_blocked']} |")

    text = "\n".join(rows)
    print(text)
    if args.summary:
        Path(args.summary).write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
