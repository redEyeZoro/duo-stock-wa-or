#!/usr/bin/env node
// One Apple pickup query. No GitHub login, notification, purchase, or scheduling.
const fs = require("node:fs");
const { MODELS, fetchRows, coverageOf } = require("./duo");

async function checkLocal({ save = false, json = false } = {}) {
  const stores = await fetchRows();
  const status = { checkedAt: new Date().toISOString(), ok: true, models: MODELS, stores, coverage: coverageOf(stores) };
  if (save) fs.writeFileSync("status.json", JSON.stringify(status, null, 2) + "\n");
  if (json) console.log(JSON.stringify(status, null, 2));
  else {
    console.log(`iPhone Duo ${MODELS.map((m) => m.name).join(", ")} — ${status.checkedAt}`);
    console.table(stores.map((store) => ({
      Store: store.name,
      City: store.city,
      ...Object.fromEntries(MODELS.map((m) => [m.name, store.parts[m.part] == null ? "UNKNOWN"
        : store.parts[m.part].available ? "AVAILABLE" : "Unavailable"])),
    })));
    console.log(`${status.coverage.checked}/${status.coverage.total} stores checked.`);
    if (!status.coverage.complete) console.warn(`Unknown: ${status.coverage.missing.join(", ")}`);
  }
  return status;
}

if (require.main === module) {
  checkLocal({ save: process.argv.includes("--save"), json: process.argv.includes("--json") })
    .then((status) => { if (!status.coverage.complete) process.exitCode = 2; })
    .catch((e) => { console.error(`Check failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = { checkLocal };
