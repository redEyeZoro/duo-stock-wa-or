// The shared record (state.json) and the rules for changing it. Pure: no I/O,
// so check.js and duo-watch.js can both lean on it and it is easy to test.

const FLAP_MS = 10 * 60 * 1000;

const emptyRecord = () => ({ version: 3, failStreak: 0, hours: {}, restocks: [], pending: {} });

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

const UNKNOWN_FORMAT =
  "state.json on GitHub has a format this version doesn't know, so it was left alone. Fix or delete it.";

const isStamp = (x) => x === null || typeof x === "string";
const isPart = (p) => isPlainObject(p) && typeof p.in === "string" && isStamp(p.out);
const isRestock = (r) =>
  isPlainObject(r) && typeof r.store === "string" && isPlainObject(r.parts) && Object.values(r.parts).every(isPart);
const isV1Key = (k) => typeof k === "string" && k.indexOf("|") > 0 && k.indexOf("|") < k.length - 1;

const validV2 = (raw) =>
  raw.version === 2 &&
  (raw.restocks === undefined || (Array.isArray(raw.restocks) && raw.restocks.every(isRestock))) &&
  (raw.hours === undefined || isPlainObject(raw.hours)) &&
  (raw.failStreak === undefined || typeof raw.failStreak === "number");

const validV3 = (raw) =>
  raw.version === 3 && validV2({ ...raw, version: 2 }) && isPlainObject(raw.pending) &&
  Object.entries(raw.pending).every(([key, p]) =>
    isPlainObject(p) && typeof p.store === "string" && typeof p.part === "string" &&
    key === `${p.store}|${p.part}` && isStamp(p.prevOut) && typeof p.token === "string" &&
    Number.isFinite(p.leaseUntil) && p.leaseUntil >= 0);

const validV1 = (raw) => raw.version === undefined && Array.isArray(raw.inStock) && raw.inStock.every(isV1Key);

// Migrates v1/v2 history into v3; old open stock is considered already announced. Anything else
// throws: writing back a default would replace the shared history.
function migrate(raw, nowIso) {
  if (!isPlainObject(raw) || !(validV3(raw) || validV2(raw) || validV1(raw))) throw new Error(UNKNOWN_FORMAT);
  const record = emptyRecord();
  record.failStreak = Number(raw.failStreak) || 0;
  if (raw.version === 2 || raw.version === 3) {
    if (raw.version === 3) record.pending = structuredClone(raw.pending);
    if (raw.hours) record.hours = structuredClone(raw.hours);
    if (raw.restocks) record.restocks = structuredClone(raw.restocks);
    return record;
  }
  // v1 only knew what was in stock and already pinged: treat each as open.
  for (const key of raw.inStock) {
    const cut = key.indexOf("|");
    const store = key.slice(0, cut);
    const part = key.slice(cut + 1);
    let restock = record.restocks.find((r) => r.store === store);
    if (!restock) record.restocks.push((restock = { store, parts: {} }));
    restock.parts[part] = { in: nowIso, out: null };
  }
  return record;
}

const partList = (r) => Object.values(r.parts);

function restockStart(r) {
  return partList(r)
    .map((p) => p.in)
    .sort()[0];
}

function restockEnd(r) {
  const outs = partList(r).map((p) => p.out);
  return outs.includes(null) ? null : outs.sort().at(-1);
}

function latestRestock(record, store) {
  return record.restocks.findLast((r) => r.store === store);
}

// Keys ("<store>|<part>") in stock and already claimed.
function claimedKeys(record) {
  const keys = new Set();
  const seen = new Set();
  for (const r of [...record.restocks].reverse()) {
    if (seen.has(r.store)) continue;
    seen.add(r.store);
    for (const [part, p] of Object.entries(r.parts)) if (p.out === null) keys.add(`${r.store}|${part}`);
  }
  for (const key of Object.keys(record.pending || {})) keys.delete(key);
  return keys;
}

// A restock still counts as "the same one" while open or just ended (a flap).
function isLive(restock, now) {
  if (!restock) return false;
  const end = restockEnd(restock);
  return end === null || now - Date.parse(end) <= FLAP_MS;
}

// Records an in-stock part. Returns a claim, or null when nobody should ping.
function markAvailable(record, row, part, nowIso, pinged) {
  const now = Date.parse(nowIso);
  const key = `${row.name}|${part}`;
  let restock = latestRestock(record, row.name);
  if (!isLive(restock, now)) {
    record.restocks.push((restock = { store: row.name, parts: {} }));
  }
  const known = restock.parts[part];
  if (known?.out === null) return { changed: false, claim: null };
  if (known) {
    const prevOut = known.out;
    known.out = null;
    const quiet = now - Date.parse(prevOut) <= FLAP_MS || pinged?.has(key);
    return { changed: true, claim: quiet ? null : { store: row.name, part, prevOut } };
  }
  const seenAt = pinged?.get(key);
  restock.parts[part] = { in: seenAt ?? nowIso, out: null };
  return { changed: true, claim: seenAt ? null : { store: row.name, part, prevOut: null } };
}

function markSoldOut(record, row, part, nowIso) {
  const p = latestRestock(record, row.name)?.parts[part];
  if (!p || p.out !== null) return false;
  p.out = nowIso;
  return true;
}

// Applies one check's rows. Never mutates `record`. `pinged` maps keys the
// laptop already pinged offline to when it first saw them: recorded, no claim.
function applyRows(record, rows, nowIso, { pinged } = {}) {
  const next = structuredClone(record);
  const claims = [];
  let changed = false;
  for (const row of rows) {
    if (row.hours && JSON.stringify(row.hours) !== JSON.stringify(next.hours[row.name])) {
      next.hours[row.name] = structuredClone(row.hours);
      changed = true;
    }
    for (const [part, cell] of Object.entries(row.parts)) {
      if (cell === null) continue;
      if (cell.available) {
        const res = markAvailable(next, row, part, nowIso, pinged);
        changed ||= res.changed;
        if (res.claim) claims.push(res.claim);
      } else {
        changed = markSoldOut(next, row, part, nowIso) || changed;
      }
    }
  }
  return { record: next, claims, changed };
}

// Undoes claims whose ping failed, so the next check tries again.
function unclaim(record, claims) {
  const next = structuredClone(record);
  let changed = false;
  for (const { store, part, prevOut } of claims) {
    const restock = latestRestock(next, store);
    if (!restock?.parts[part]) continue;
    changed = true;
    if (prevOut !== null) {
      restock.parts[part].out = prevOut;
      continue;
    }
    delete restock.parts[part];
    if (!partList(restock).length) next.restocks.splice(next.restocks.lastIndexOf(restock), 1);
  }
  return { record: next, changed };
}

module.exports = {
  FLAP_MS,
  emptyRecord,
  migrate,
  restockStart,
  restockEnd,
  claimedKeys,
  applyRows,
  unclaim,
};
