#!/usr/bin/env node
// Watches Apple Store pickup availability for the iPhone Duo models and
// stores in duo.js, and pings your phone through ntfy.sh when one shows up.
// Laptop version of check.js: faster, but only runs while this does.
//
// Usage:
//   NTFY_TOPIC=your-topic node duo-watch.js   (sends a test push on startup)
//   node duo-watch.js --no-test  (skip the test push)
//
// Needs Node 20+ (built in fetch). No npm install.

const { MODELS, STORES, HEADERS, fetchRows, notify, pushClaims, coverageOf } = require("./duo");
const { claimedKeys } = require("./record");
const { prepareDelivery, finishDelivery } = require("./delivery");
const { apiFromGh, update, dispatchCheck } = require("./notebook");

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 120);
const NTFY_TOPIC = process.env.NTFY_TOPIC; // subscribe to this in the ntfy app

let cookies = "";

// Load the product page first like a browser would, and keep its cookies.
// The pickup endpoint works without them, but a fresh session is a cheap
// thing to try after a block.
async function warmUp() {
  const res = await fetch(MODELS[0].buy, {
    headers: { "User-Agent": HEADERS["User-Agent"], Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20000),
  });
  const set = res.headers.getSetCookie?.() || [];
  cookies = set.map((c) => c.split(";")[0]).join("; ");
  console.log(`warmed up (page ${res.status}, ${set.length} cookies)`);
}

// Extra headers the browser sends with this request, as JSON in the
// DUO_EXTRA_HEADERS env var. If 541 keeps happening: in Chrome, open a buy
// page, open DevTools > Network, click "Check availability" for pickup, right
// click the pickup-message request > Copy > Copy as cURL, and put the header
// values there. Never paste them into this file: a copied request carries
// your Apple sign-in cookies, and this repo is public.
const EXTRA_HEADERS = JSON.parse(process.env.DUO_EXTRA_HEADERS || "{}");

const keyOf = (store, part) => `${store}|${part}`;

function availableKeys(rows) {
  const keys = new Set();
  for (const r of rows) for (const m of MODELS) if (r.parts[m.part]?.available) keys.add(keyOf(r.name, m.part));
  return keys;
}

function logRows(rows, now) {
  const found = rows.flatMap((r) =>
    MODELS.filter((m) => r.parts[m.part]?.available).map((m) => `${m.name} at ${r.name}`)
  );
  const missing = coverageOf(rows).missing;
  console.log(
    `[${now.toLocaleTimeString()}] ${found.length ? "AVAILABLE: " + found.join(", ") : `nothing yet (${rows.length - missing.length} stores checked)`}` +
      (missing.length ? `; unknown stock: ${missing.join(", ")}` : "")
  );
}

async function startGitHubCheck(api) {
  try {
    await dispatchCheck(api);
  } catch (e) {
    console.warn(`could not start a GitHub check (${e.message})`);
  }
}

// Pushes keys that have no record to claim them in. Returns the ones that went out.
async function pingKeys(keys, rows) {
  const claims = keys.map((key) => {
    const cut = key.indexOf("|");
    return { store: key.slice(0, cut), part: key.slice(cut + 1), prevOut: null };
  });
  const failed = new Set((await pushClaims(claims, rows)).map((c) => keyOf(c.store, c.part)));
  return keys.filter((key) => !failed.has(key));
}

// The laptop and check.js share state.json on GitHub: a restock is claimed
// there before its push, so only one of them pings. When GitHub can't be
// reached the laptop pings anyway (a repeat beats a miss) and remembers what
// it pinged in `offline`, to hand over when GitHub is back.
function createWatcher({ api, now = () => new Date() }) {
  const offline = new Map(); // "store|part" -> ISO time of the offline ping
  let lastKnown = new Set(); // claimed at the last good read; forgotten on sell-out
  let warned = false;

  async function claim(rows, nowIso) {
    const out = await update(api, (rec) => prepareDelivery(rec, rows, nowIso, { pinged: offline }), { nowIso });
    offline.clear();
    warned = false;
    lastKnown = claimedKeys(out.record);
    return out.result;
  }

  async function pingAndHandOver(result, rows, nowIso) {
    const failed = await pushClaims(result.claims, rows);
    const failedKeys = new Set(failed.map((c) => keyOf(c.store, c.part)));
    for (const c of result.claims) {
      const key = keyOf(c.store, c.part);
      if (failedKeys.has(key)) lastKnown.delete(key);
      else lastKnown.add(key);
    }
    if (result.claims.length) {
      try {
        await update(api, (rec) => finishDelivery(rec, result.claims, failed), { nowIso });
      } catch (e) {
        console.warn(`Could not save delivery result; unfinished alerts may retry (${e.message})`);
      }
    }
    if (result.changed) await startGitHubCheck(api);
  }

  async function fromMemory(rows, err) {
    if (!warned) {
      console.warn(`GitHub unreachable (${err.message}), pinging from this laptop's memory until it's back`);
      warned = true;
    }
    const available = availableKeys(rows);
    const soldOut = new Set(rows.flatMap((r) => MODELS
      .filter((m) => r.parts[m.part]?.available === false).map((m) => keyOf(r.name, m.part))));
    for (const key of offline.keys()) if (soldOut.has(key)) offline.delete(key);
    const fresh = new Set((err.lastResult?.claims || []).map((c) => keyOf(c.store, c.part)));
    // a sell-out, or a claim the record never saved, makes the next sighting a new restock
    for (const key of [...lastKnown]) if (soldOut.has(key) || fresh.has(key)) lastKnown.delete(key);
    const todo = [...available].filter((key) => !offline.has(key) && !lastKnown.has(key));
    for (const key of await pingKeys(todo, rows)) offline.set(key, now().toISOString());
  }

  async function checkOnce(extraHeaders = {}) {
    const rows = await fetchRows(extraHeaders);
    logRows(rows, now());
    if (!api) return fromMemory(rows, new Error("no GitHub login"));
    const nowIso = now().toISOString();
    let result;
    try {
      result = await claim(rows, nowIso);
    } catch (e) {
      return fromMemory(rows, e);
    }
    await pingAndHandOver(result, rows, nowIso);
  }

  return { checkOnce, offline };
}

async function warmedHeaders() {
  if (!cookies) await warmUp();
  return {
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...(cookies ? { Cookie: cookies } : {}),
    ...EXTRA_HEADERS,
  };
}

let blockedStreak = 0;

async function loop(watcher) {
  try {
    try {
      await watcher.checkOnce(await warmedHeaders());
    } catch (e) {
      if (e.blocked) cookies = ""; // get a fresh session next time
      throw e;
    }
    blockedStreak = 0;
  } catch (e) {
    blockedStreak = e.blocked ? blockedStreak + 1 : 0;
    console.error(`[${new Date().toLocaleTimeString()}] check failed: ${e.message}`);
    if (blockedStreak === 5) {
      await notify("Duo watcher is blocked", "Apple has blocked 5 checks in a row. The watcher is still running but probably isn't seeing stock.");
    }
  }
  // back off when blocked (2x, 4x, then 7.5x the interval: 4, 8, 15 min at
  // the default 2 min), plus random jitter
  const backoff = blockedStreak ? Math.min(2 ** blockedStreak, 7.5) : 1;
  const wait = INTERVAL_SEC * 1000 * backoff + Math.floor(Math.random() * 20000);
  setTimeout(() => loop(watcher), wait);
}

function start() {
  if (!Number.isFinite(INTERVAL_SEC) || INTERVAL_SEC < 60) {
    console.error("INTERVAL_SEC must be a number of at least 60 seconds.");
    process.exitCode = 1;
    return;
  }
  process.on("unhandledRejection", (e) => {
    console.error("duo-watch crashed:", e);
    process.exit(1);
  });

  let api = null;
  try {
    api = apiFromGh();
  } catch (e) {
    console.warn(`Can't use GitHub (${e.message}). Pings will come from this laptop only, so GitHub may ping again for the same restock.`);
  }
  if (!NTFY_TOPIC) console.warn("NTFY_TOPIC not set, alerts will only print to the terminal.");
  console.log(
    `Watching ${MODELS.map((m) => m.name).join(", ")} at ${STORES.length} stores every ~${INTERVAL_SEC}s` +
      (NTFY_TOPIC ? ", alerts to your ntfy topic" : "")
  );
  const watcher = createWatcher({ api });
  (async () => {
    if (!process.argv.includes("--no-test")) {
      await notify("Duo watcher running", "Test push. You'll get an alert like this when stock shows up.", {
        click: "https://ntfy.sh/" + NTFY_TOPIC,
      });
    }
    loop(watcher);
  })();
}

if (require.main === module) start();

module.exports = { createWatcher };
