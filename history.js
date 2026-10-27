// Turns the shared record into what the page's History tab shows. Pure: no
// I/O. All wall-clock times are Pacific; durations use real UTC milliseconds.

const { restockStart, restockEnd } = require("./record");
const { STORES, MODELS } = require("./duo");

const WINDOWS = ["12-6a", "6-9a", "9a-12", "12-5p", "5p-12"];
const WINDOW_STARTS = [0, 360, 540, 720, 1020];
const WINDOW_PHRASES = ["midnight to 6 AM", "6 to 9 AM", "9 AM to noon", "noon to 5 PM", "5 PM to midnight"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIN_FOR_BEST = 3;

const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h12",
});

function pacific(iso) {
  const p = Object.fromEntries(PACIFIC.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const hour24 = (Number(p.hour) % 12) + (p.dayPeriod === "PM" ? 12 : 0);
  const day = `${p.month} ${p.day}`;
  // Joined by hand: ICU may put U+202F before AM/PM.
  const time = `${p.hour}:${p.minute} ${p.dayPeriod}`;
  return {
    weekday: DAYS.indexOf(p.weekday),
    minutes: hour24 * 60 + Number(p.minute),
    day,
    label: `${p.weekday} ${day}, ${time}`,
  };
}

// "Mon-Thu, Sun" -> day numbers (ranges may wrap past Sat). null if unreadable.
function parseDays(text) {
  const days = [];
  for (const part of String(text).split(", ")) {
    const m = /^([A-Z][a-z]{2})(?:-([A-Z][a-z]{2}))?$/.exec(part.trim());
    if (!m || !DAYS.includes(m[1]) || (m[2] && !DAYS.includes(m[2]))) return null;
    const from = DAYS.indexOf(m[1]);
    const to = m[2] ? DAYS.indexOf(m[2]) : from;
    for (let d = from; ; d = (d + 1) % 7) {
      days.push(d);
      if (d === to) break;
    }
  }
  return days;
}

function parseOpening(text) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)\s*-/.exec(String(text).trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
  return (Number(m[1]) % 12) * 60 + Number(m[2]) + (m[3] === "PM" ? 720 : 0);
}

// The opening minute for each weekday (Sun = 0), null where unknown.
function parseHours(storeHours) {
  const opens = Array(7).fill(null);
  for (const entry of Array.isArray(storeHours) ? storeHours : []) {
    const days = parseDays(entry?.storeDays);
    const open = parseOpening(entry?.storeTimings);
    if (!days || open === null) continue;
    for (const d of days) opens[d] = open;
  }
  return opens;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  return `${Math.round(minutes / 30) / 2} hr`;
}

const formatClock = (m) => {
  const hour = m >= 720 ? "PM" : "AM";
  const h = Math.floor(m / 60) % 12 || 12;
  return `${h}${m % 60 ? `:${String(m % 60).padStart(2, "0")}` : ""} ${hour}`;
};

const windowOf = (minutes) => WINDOW_STARTS.findLastIndex((s) => minutes >= s);

function minutesBetween(restock) {
  const end = restockEnd(restock);
  if (end === null) return null;
  return Math.max(0, (Date.parse(end) - Date.parse(restockStart(restock))) / 60000);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildGrid(restocks) {
  const grid = STORES.map((store) => ({ store, counts: Array(5).fill(0), total: 0 }));
  for (const r of restocks) {
    const row = grid.find((g) => g.store === r.store);
    if (!row) continue;
    row.counts[windowOf(pacific(restockStart(r)).minutes)]++;
    row.total++;
  }
  return grid.sort((a, b) => b.total - a.total); // stable: ties keep STORES order
}

// "3 of its 5 restocks showed up before it opens[ at 10 AM]", or null.
function beforeOpening(restocks, storeHours) {
  const opens = parseHours(storeHours);
  const starts = restocks.map((r) => pacific(restockStart(r)));
  if (starts.some((p) => opens[p.weekday] === null)) return null;
  const early = starts.filter((p) => p.minutes < opens[p.weekday]);
  if (!early.length) return null;
  const times = new Set(early.map((p) => opens[p.weekday]));
  const at = times.size === 1 ? ` at ${formatClock([...times][0])}` : "";
  return `${early.length} of its ${restocks.length} restocks showed up before it opens${at}`;
}

function bestBet(record, topRow) {
  const mine = record.restocks.filter((r) => r.store === topRow.store);
  const window = topRow.counts.indexOf(Math.max(...topRow.counts));
  const before = beforeOpening(mine, record.hours?.[topRow.store]);
  const lengths = mine.map(minutesBetween).filter((m) => m !== null);
  const usual = lengths.length ? formatDuration(median(lengths)) : null;
  let detail = "";
  if (before && usual) detail = `${before}, and they usually last about ${usual}.`;
  else if (before) detail = `${before}.`;
  else if (usual) detail = `Its restocks usually last about ${usual}.`;
  return { title: `Best bet: ${topRow.store}, ${WINDOW_PHRASES[window]}`, detail };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function learningNote(count, grid) {
  if (count === 0) return "No restocks seen yet. This fills in as the checker spots them.";
  if (grid[0].total < MIN_FOR_BEST) return `Still learning: ${plural(count, "restock")} seen so far.`;
  const tied = grid.filter((g) => g.total === grid[0].total).map((g) => g.store);
  return `No clear favorite yet: ${tied.slice(0, -1).join(", ")} and ${tied.at(-1)} have ${grid[0].total} restocks each.`;
}

function logEntry(r) {
  const minutes = minutesBetween(r);
  const names = MODELS.filter((m) => r.parts[m.part]).map((m) => m.name);
  return {
    store: r.store,
    when: pacific(restockStart(r)).label,
    models: names.join(", "),
    open: minutes === null,
    minutes,
    lasted: minutes === null ? "still in stock" : `lasted ~${formatDuration(minutes)}`,
  };
}

// The record keeps parts of models no longer in MODELS; History shows only watched ones.
function watchedOnly(restocks) {
  const watched = new Set(MODELS.map((m) => m.part));
  return restocks
    .map((r) => ({ ...r, parts: Object.fromEntries(Object.entries(r.parts).filter(([part]) => watched.has(part))) }))
    .filter((r) => STORES.includes(r.store) && Object.keys(r.parts).length);
}

function summarize(full) {
  const record = { ...full, restocks: watchedOnly(full.restocks) };
  const restocks = record.restocks;
  const count = restocks.length;
  // Array order is not start order: an offline sighting is appended late.
  const byStart = restocks.map((r) => ({ r, start: restockStart(r) })).sort((a, b) => a.start.localeCompare(b.start));
  const grid = buildGrid(restocks);
  const clear = grid.length > 0 && grid[0].total >= MIN_FOR_BEST && grid[0].total > (grid[1]?.total ?? 0);
  return {
    count,
    basis: count ? `Based on ${plural(count, "restock")} seen since ${pacific(byStart[0].start).day}.` : null,
    best: clear ? bestBet(record, grid[0]) : null,
    grid,
    learning: clear ? null : learningNote(count, grid),
    log: byStart.map((x) => logEntry(x.r)).reverse(),
  };
}

module.exports = { WINDOWS, pacific, parseHours, formatDuration, summarize };
