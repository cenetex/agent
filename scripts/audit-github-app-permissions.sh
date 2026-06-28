#!/usr/bin/env bash
set -euo pipefail

node - "$@" <<'NODE'
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const appIdParam = process.env.GITHUB_APP_ID_PARAM || "/github-agent/GITHUB_APP_ID";
const privateKeyParam = process.env.GITHUB_APP_PRIVATE_KEY_PARAM || "/github-agent/GITHUB_APP_PRIVATE_KEY";
const repo = process.argv[2] || "";

function ssm(name, decrypt = false) {
  const args = ["ssm", "get-parameter"];
  if (decrypt) args.push("--with-decryption");
  args.push("--name", name, "--query", "Parameter.Value", "--output", "text");
  return execFileSync("aws", args, { encoding: "utf8" }).trim();
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createJwt() {
  const appId = ssm(appIdParam);
  const privateKey = ssm(privateKeyParam, true);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${b64url(signature)}`;
}

async function api(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-agent-permission-audit",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function permissionOk(actual, required) {
  if (!actual) return false;
  if (required === "read") return ["read", "write", "admin"].includes(actual);
  if (required === "write") return ["write", "admin"].includes(actual);
  return actual === required;
}

async function main() {
  const jwt = createJwt();
  const { response, body: app } = await api("/app", jwt);
  if (response.status !== 200) {
    throw new Error(`GET /app failed with ${response.status}: ${JSON.stringify(app)}`);
  }

  const required = {
    metadata: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    workflows: "write",
    statuses: "read",
    checks: "read",
  };

  console.log(`GitHub App: ${app.slug} (${app.name})`);
  console.log(`Owner: ${app.owner?.login || "unknown"}`);
  console.log("");
  console.log("Repository permissions:");

  const missing = [];
  for (const [name, level] of Object.entries(required)) {
    const actual = app.permissions?.[name] || "none";
    const ok = permissionOk(actual, level);
    console.log(`  ${ok ? "OK " : "NO "} ${name.padEnd(14)} required=${level.padEnd(5)} actual=${actual}`);
    if (!ok) missing.push(`${name}:${level}`);
  }

  if (missing.length > 0) {
    console.log("");
    console.log(`Missing required permission(s): ${missing.join(", ")}`);
    console.log("Update the GitHub App settings, then approve the updated installation permissions.");
    console.log(`Org-owned app settings:  https://github.com/organizations/${app.owner?.login || "OWNER"}/settings/apps/${app.slug}/permissions`);
    console.log(`User-owned app settings: https://github.com/settings/apps/${app.slug}/permissions`);
  }

  if (!repo) {
    if (missing.length > 0) process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`Installation endpoint check for ${repo}:`);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error("Repository argument must be owner/name");

  const installationResult = await api(`/repos/${owner}/${name}/installation`, jwt);
  if (installationResult.response.status !== 200) {
    console.log(`  NO  installation lookup status=${installationResult.response.status}`);
    process.exitCode = 1;
    return;
  }

  const tokenResult = await api(
    `/app/installations/${installationResult.body.id}/access_tokens`,
    jwt,
    { method: "POST" }
  );
  if (tokenResult.response.status !== 201) {
    console.log(`  NO  installation token status=${tokenResult.response.status}`);
    process.exitCode = 1;
    return;
  }

  const token = tokenResult.body.token;
  const branch = await api(`/repos/${owner}/${name}/branches/${encodeURIComponent("main")}`, token);
  const sha = branch.body?.commit?.sha;
  if (!sha) {
    console.log(`  NO  could not resolve main branch (status=${branch.response.status})`);
    process.exitCode = 1;
    return;
  }

  for (const [label, path] of [
    ["commit statuses", `/repos/${owner}/${name}/commits/${sha}/status`],
    ["check runs", `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=1`],
  ]) {
    const result = await api(path, token);
    const accepted = result.response.headers.get("x-accepted-github-permissions") || "unknown";
    const ok = result.response.status === 200;
    console.log(`  ${ok ? "OK " : "NO "} ${label.padEnd(15)} status=${result.response.status} accepted=${accepted}`);
    if (!ok) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
