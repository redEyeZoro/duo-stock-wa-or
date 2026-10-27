// Reads and writes state.json in the GitHub repo through the contents API.
// Writes carry the file's blob SHA, so two checkers can never both win.

const { execFileSync } = require("child_process");
const { emptyRecord, migrate } = require("./record");

const API = "https://api.github.com";
const FILE = "state.json";

function apiFromEnv(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
  }
  return { repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, branch: "main" };
}

// The laptop borrows the logged-in gh CLI and the repo's origin remote.
function apiFromGh(run = execFileSync) {
  let token;
  let remote;
  try {
    token = String(run("gh", ["auth", "token"], { encoding: "utf8" })).trim();
    remote = String(run("git", ["remote", "get-url", "origin"], { encoding: "utf8" })).trim();
  } catch {
    throw new Error("Could not find a GitHub login or repo. Is gh installed and logged in, and is this a git clone?");
  }
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!token || !match) throw new Error("Could not read the GitHub repo from the origin remote, or gh has no token.");
  return { repo: match[1], token, branch: "main" };
}

async function request(api, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "duo-stock",
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { res, fail: () => httpError(method, path, res.status) };
}

function httpError(method, path, status) {
  return new Error(`GitHub API ${method} ${path} answered HTTP ${status}`);
}

async function readRecord(api, nowIso) {
  const path = `/repos/${api.repo}/contents/${FILE}?ref=${api.branch}`;
  const { res, fail } = await request(api, "GET", path);
  if (res.status === 404) return { record: emptyRecord(), sha: null };
  if (!res.ok) throw fail();
  const file = await res.json();
  let raw;
  try {
    raw = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  } catch {
    throw new Error("state.json on GitHub is not valid JSON, so it was left alone. Fix or delete it.");
  }
  return { record: migrate(raw, nowIso), sha: file.sha };
}

async function writeRecord(api, record, sha, message) {
  const path = `/repos/${api.repo}/contents/${FILE}`;
  const content = Buffer.from(JSON.stringify(record, null, 2) + "\n").toString("base64");
  const body = { message, content, branch: api.branch, ...(sha && { sha }) };
  const { res, fail } = await request(api, "PUT", path, body);
  if (res.status === 409 || res.status === 422) {
    throw Object.assign(fail(), { conflict: true });
  }
  if (!res.ok) throw fail();
  return (await res.json()).content.sha;
}

// Read, let fn decide, write if it changed something; on a lost race, start over.
async function update(api, fn, { message = "Update stock state", tries = 5, nowIso } = {}) {
  for (let attempt = 1; ; attempt++) {
    let result; // per attempt, so lastResult never comes from an earlier read
    try {
      const { record, sha } = await readRecord(api, nowIso);
      result = await fn(record);
      if (!result.changed) return { record: result.record, result };
      await writeRecord(api, result.record, sha, message);
      return { record: result.record, result };
    } catch (err) {
      if (!err.conflict || attempt >= tries) {
        err.lastResult = result;
        throw err;
      }
    }
  }
}

async function dispatchCheck(api) {
  const path = `/repos/${api.repo}/actions/workflows/check.yml/dispatches`;
  const { res, fail } = await request(api, "POST", path, { ref: api.branch });
  if (res.status !== 204) throw fail();
}

module.exports = { apiFromEnv, apiFromGh, readRecord, writeRecord, update, dispatchCheck };
