#!/usr/bin/env node
// One stock check for the iPhone Duo models and stores in duo.js. Meant for
// GitHub Actions: runs once, sends an ntfy push for anything that just came
// into stock, and writes status.json for the GitHub Pages page. state.json
// lives on GitHub and is shared with the laptop watcher: each new restock is
// leased before its push. Unfinished delivery can retry after a crash.

const fs = require("fs");
const { MODELS, toRows, fetchRows, notify, pushClaims, coverageOf } = require("./duo");
const { prepareDelivery, finishDelivery } = require("./delivery");
const { summarize } = require("./history");
const { apiFromEnv, update } = require("./notebook");

const FAIL_ALERT_AT = 6; // one heads up after ~30 min of failures, not one every run

function writeStatus(status) {
  fs.writeFileSync("status.json", JSON.stringify(status, null, 2) + "\n");
}

// Bumps the failure streak. Stops counting at FAIL_ALERT_AT so a long outage
// makes no writes. Returns whether this run is the one that reaches it.
async function recordFailure(api, nowIso) {
  const { record, result } = await update(
    api,
    (rec) => {
      const failStreak = Math.min(rec.failStreak + 1, FAIL_ALERT_AT);
      return {
        record: { ...rec, failStreak },
        changed: failStreak !== rec.failStreak,
        reached: rec.failStreak + 1 === FAIL_ALERT_AT,
      };
    },
    { nowIso }
  );
  return { record, reached: result.reached };
}

async function handleAppleFailure(api, nowIso, e) {
  // Exit 0 on purpose: a red run every 5 min would mean a GitHub email
  // every 5 min. The page shows the error and the push below tells you.
  console.log(`::error title=Apple check failed::${e.message}`);
  let { record, reached } = await recordFailure(api, nowIso);
  if (reached) {
    const told = await notify(
      "Duo checker is failing",
      `${FAIL_ALERT_AT} checks in a row failed: ${e.message}. Alerts won't work until this clears.`,
      { priority: "default" }
    );
    // try again on the next failed run
    if (!told) {
      const retry = (rec) => ({ record: { ...rec, failStreak: FAIL_ALERT_AT - 1 }, changed: true });
      ({ record } = await update(api, retry, { nowIso }));
    }
  }
  return record;
}

async function handleRows(api, nowIso, rows) {
  const coverage = coverageOf(rows);
  let { record, result } = await update(
    api,
    (rec) => {
      const applied = prepareDelivery(rec, rows, nowIso);
      return {
        record: { ...applied.record, failStreak: coverage.complete ? 0 : Math.min(rec.failStreak + 1, FAIL_ALERT_AT) },
        changed: applied.changed || (coverage.complete ? rec.failStreak !== 0 : rec.failStreak < FAIL_ALERT_AT),
        claims: applied.claims,
        wasStreak: rec.failStreak,
      };
    },
    { nowIso }
  );
  if (coverage.complete && result.wasStreak >= FAIL_ALERT_AT) {
    await notify("Duo checker is back", "Apple is answering again.", { priority: "default" });
  }
  if (!coverage.complete && result.wasStreak + 1 === FAIL_ALERT_AT) {
    const told = await notify("Duo checker has incomplete coverage",
      `Stock is unknown at ${coverage.missing.join(", ")}. Other store results are still being checked.`,
      { priority: "default" });
    if (!told) {
      ({ record } = await update(api, (rec) => ({
        record: { ...rec, failStreak: FAIL_ALERT_AT - 1 }, changed: true,
      }), { nowIso }));
    }
  }
  const failed = await pushClaims(result.claims, rows);
  if (!result.claims.length) return record;
  return (await update(api, (rec) => finishDelivery(rec, result.claims, failed), { nowIso })).record;
}

function logRows(rows) {
  for (const r of rows) {
    const cells = MODELS.map((m) => {
      const c = r.parts[m.part];
      return `${m.name}: ${c ? (c.available ? "AVAILABLE" : "no") : "?"}`;
    });
    console.log(`${r.name}${r.found ? "" : " (not in Apple's response)"}: ${cells.join(", ")}`);
  }
}

// Every rejection is logged here once, with context, before the caller exits 1.
async function main(options = {}) {
  try {
    await check(options);
  } catch (e) {
    console.error(`check failed: ${e.message}`);
    throw e;
  }
}

async function check({ now = () => new Date(), env = process.env } = {}) {
  const api = apiFromEnv(env);
  const nowIso = now().toISOString();
  const status = { checkedAt: nowIso, ok: true, models: MODELS };

  let rows;
  let appleError;
  try {
    rows = await fetchRows();
  } catch (e) {
    appleError = e;
  }

  try {
    if (appleError) {
      const record = await handleAppleFailure(api, nowIso, appleError);
      const failed = { ...status, ok: false, error: appleError.message, failStreak: record.failStreak };
      writeStatus({ ...failed, stores: toRows([]), history: summarize(record) });
    } else {
      const record = await handleRows(api, nowIso, rows);
      logRows(rows);
      writeStatus({ ...status, coverage: coverageOf(rows), failStreak: record.failStreak, stores: rows, history: summarize(record) });
    }
  } catch (e) {
    // The record could not be read or saved. If we got as far as deciding
    // on pushes, send them anyway: a repeat ping beats a missed restock.
    if (e.lastResult?.claims?.length) await pushClaims(e.lastResult.claims, rows);
    try {
      writeStatus({ ...status, ok: false, error: e.message, stores: toRows([]) });
    } catch (we) {
      console.error(`could not write status.json: ${we.message}`);
    }
    throw e;
  }
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}

module.exports = { main, FAIL_ALERT_AT };
