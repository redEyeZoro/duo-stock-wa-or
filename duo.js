// Shared by check.js (GitHub Actions) and duo-watch.js (laptop): what to
// watch, how to ask Apple, and how to push new stock to ntfy.

const { MODELS, PRIMARY_ZIP, STORE_CONFIG } = require("./config");
const STORES = STORE_CONFIG.map((store) => store.name);
const pickupUrl = (zip) =>
  "https://www.apple.com/shop/retail/pickup-message?pl=true&" +
  MODELS.map((m, i) => `parts.${i}=${encodeURIComponent(m.part)}`).join("&") +
  `&location=${encodeURIComponent(zip)}`;
const PICKUP_URL = pickupUrl(PRIMARY_ZIP);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: MODELS[0].buy,
};

// One row per watched store, in STORES order. A store Apple left out, or a
// part missing from a store, is null (unknown), not unavailable.
function toRows(apiStores) {
  return STORE_CONFIG.map(({ id, name, city }) => {
    const s = apiStores.find((x) => x?.storeNumber === id);
    const parts = {};
    for (const { part } of MODELS) {
      const info = s?.partsAvailability?.[part];
      parts[part] = ["available", "unavailable"].includes(info?.pickupDisplay)
        ? { available: info.pickupDisplay === "available", quote: info.pickupSearchQuote || "" }
        : null;
    }
    const hours = s?.retailStore?.storeHours;
    return {
      id,
      name,
      city: s?.city || city,
      miles: s?.storedistance != null && Number.isFinite(Number(s.storedistance)) ? Number(s.storedistance) : null,
      found: Boolean(s),
      hours: Array.isArray(hours)
        ? hours.map(({ storeDays, storeTimings }) => ({ storeDays, storeTimings }))
        : null,
      parts,
    };
  });
}

// Throws with err.blocked set when Apple refuses us (541 or 403).
async function fetchStores(zip, extraHeaders) {
  const res = await fetch(pickupUrl(zip), {
    headers: { ...HEADERS, ...extraHeaders },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 541 || res.status === 403) {
    throw Object.assign(new Error(`Apple blocked the request (HTTP ${res.status})`), { blocked: true });
  }
  if (!res.ok) throw new Error(`Apple answered HTTP ${res.status}`);
  const stores = (await res.json())?.body?.stores;
  if (!Array.isArray(stores) || !stores.length) {
    throw new Error("no stores in Apple's response (Apple may have changed the format)");
  }
  return stores;
}

function coverageOf(rows) {
  const missing = rows.filter((r) => MODELS.some((m) => r.parts[m.part] == null)).map((r) => r.name);
  return { complete: missing.length === 0, checked: rows.length - missing.length, total: rows.length, missing };
}

async function fetchRows(extraHeaders = {}) {
  let rows = toRows(await fetchStores(PRIMARY_ZIP, extraHeaders));
  const searched = new Set([PRIMARY_ZIP]);
  for (const target of STORE_CONFIG) {
    if (searched.has(target.zip) || !coverageOf(rows).missing.includes(target.name)) continue;
    searched.add(target.zip);
    try {
      const fallback = toRows(await fetchStores(target.zip, extraHeaders));
      rows = rows.map((row, i) => {
        const other = fallback[i];
        if (!other.found) return row;
        return {
          ...row, found: row.found || other.found,
          hours: row.hours ?? other.hours,
          // Keep distances relative to the primary ZIP; fallback distances aren't comparable.
          parts: Object.fromEntries(MODELS.map(({ part }) => [part, row.parts[part] ?? other.parts[part]])),
        };
      });
    } catch (e) {
      console.warn(`Coverage fallback for ${target.zip} failed: ${e.message}`);
    }
  }
  if (!rows.some((r) => r.found)) throw new Error("none of the watched stores are in Apple's response");
  return rows;
}

// The topic only ever comes from the env (a repo secret on GitHub). Anyone
// who knows it can read and send your pushes, so it is never logged.
async function notify(title, body, { priority = "urgent", click } = {}) {
  console.log(`PUSH: ${title}\n${body}`);
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.warn("NTFY_TOPIC not set, push skipped");
    return false;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body,
      headers: { Title: title, Priority: priority, Tags: "iphone", ...(click && { Click: click }) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error(`ntfy push failed: ${e.message}`);
    return false;
  }
}

// Pushes the claims: one push per model so the title and Click link fit it,
// all at once. Returns the claims whose push failed so the caller can undo them.
async function pushClaims(claims, rows) {
  const failed = await Promise.all(
    MODELS.map(async (model) => {
      const mine = claims.filter((c) => c.part === model.part);
      if (!mine.length) return [];
      const hits = STORES.filter((name) => mine.some((c) => c.store === name)).map((name) =>
        rows.find((r) => r.name === name)
      );
      const pushed = await notify(
        `${model.name} at ${hits.map((r) => r.name).join(", ")}`,
        hits.map((r) => `${r.name} (${r.city}): ${r.parts[model.part].quote || "Available"}`).join("\n"),
        { click: model.buy }
      );
      return pushed ? [] : mine;
    })
  );
  return failed.flat();
}

module.exports = { MODELS, STORES, PICKUP_URL, HEADERS, coverageOf, toRows, fetchRows, notify, pushClaims };
