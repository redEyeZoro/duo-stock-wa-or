// A persisted outbox separates stock observations from notification delivery.
// A short lease prevents two healthy runners from sending the same alert.
// If a runner dies, another can retry after the lease expires, while stock remains available.
const { randomUUID } = require("node:crypto");
const { applyRows } = require("./record");
const LEASE_MS = 3 * 60 * 1000;
const keyOf = ({ store, part }) => `${store}|${part}`;

function prepareDelivery(record, rows, nowIso, { pinged = new Map() } = {}) {
  const applied = applyRows(record, rows, nowIso, { pinged });
  const next = applied.record;
  next.pending ??= {};
  let changed = applied.changed;
  const now = Date.parse(nowIso);
  for (const claim of applied.claims) {
    next.pending[keyOf(claim)] = { ...claim, token: "", leaseUntil: 0 };
    changed = true;
  }
  const claims = [];
  for (const [key, pending] of Object.entries(next.pending)) {
    const row = rows.find((r) => r.name === pending.store);
    const cell = row?.parts[pending.part];
    if (pinged.has(key) || !row || !(pending.part in row.parts)) {
      delete next.pending[key];
      changed = true;
      continue;
    }
    if (cell?.available === false) {
      // Keep undelivered work through a brief sellout, but invalidate any old sender.
      if (pending.leaseUntil || pending.token) {
        pending.leaseUntil = 0;
        pending.token = "";
        changed = true;
      }
      continue;
    }
    // Never send an old alert when the latest result for its store is unknown.
    if (!cell?.available || pending.leaseUntil > now) continue;
    pending.token = randomUUID();
    pending.leaseUntil = now + LEASE_MS;
    claims.push({ ...pending });
    changed = true;
  }
  return { record: next, changed, claims };
}

// A late acknowledgement may only touch its own lease, never a newer attempt.
function finishDelivery(record, claims, failed) {
  const next = structuredClone(record);
  const failures = new Set(failed.map((c) => c.token));
  let changed = false;
  for (const claim of claims) {
    const key = keyOf(claim);
    const pending = next.pending?.[key];
    if (!pending || pending.token !== claim.token) continue;
    if (failures.has(claim.token)) {
      pending.leaseUntil = 0;
      pending.token = "";
    } else {
      delete next.pending[key];
    }
    changed = true;
  }
  return { record: next, changed };
}

module.exports = { prepareDelivery, finishDelivery, LEASE_MS };
