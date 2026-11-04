// Fetches CPCB real-time station data for all of India from data.gov.in and writes
// city-level CPCB AQI to dist/cpcb.json. Run by the GitHub Action every hour.
// Usage: CPCB_API_KEY=... bun scripts/fetch-cpcb.js [outfile]   (Bun also reads .env)
const KEY = process.env.CPCB_API_KEY;
const OUT = process.argv[2] ?? "dist/cpcb.json";
const RESOURCE = "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";
const PAGE = 1000;
const STALE_HOURS = 6;

if (!KEY) {
  console.error("CPCB_API_KEY is not set (data.gov.in -> My Account -> Generate API Key).");
  process.exit(1);
}

// This dataset's min/avg/max values are CPCB AQI *sub-indices* (0-500) per pollutant,
// not concentrations: every pollutant is capped at 500 and CO runs 1-200.
// CPCB rule: station AQI = highest sub-index, needs >= 3 pollutants incl. PM2.5 or PM10.
const MIN_POLLUTANTS = 3;

// CPCB PM2.5 breakpoints (24-hour, µg/m³), used to turn the PM2.5 sub-index back into
// µg/m³ for the dots ("each dot is 1 µg of PM2.5").
const PM25 = [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 380, 400, 500]];
const pm25FromIndex = (i) => {
  for (const [cl, ch, il, ih] of PM25) if (i <= ih) return cl + ((i - il) * (ch - cl)) / (ih - il);
  return 380;
};

// "04-11-2026 16:00:00" (IST) -> Date
const parseTime = (s) => {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s ?? "");
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`) : null;
};

async function fetchAll() {
  const records = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${RESOURCE}?api-key=${KEY}&format=json&limit=${PAGE}&offset=${offset}`;
    // data.gov.in is often slow or drops connections: retry timeouts, network errors and 5xx/429.
    let res, lastError;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
        if (res.ok) break;
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      } catch (err) {
        res = undefined;
        lastError = `${err.name}: ${err.message}`;
      }
      console.warn(`data.gov.in offset ${offset}, attempt ${attempt} failed (${lastError})`);
      await Bun.sleep(attempt * 10_000);
    }
    if (!res?.ok) throw new Error(`data.gov.in unreachable after retries: ${lastError}`);
    const json = await res.json();
    const page = json.records ?? [];
    records.push(...page);
    if (page.length < PAGE || records.length >= Number(json.total ?? 0)) break;
  }
  return records;
}

const records = await fetchAll();
if (!records.length) throw new Error("data.gov.in returned no records");

// Group pollutant readings by station.
const stations = new Map();
for (const r of records) {
  const key = `${r.state}|${r.city}|${r.station}`;
  const s = stations.get(key) ?? { state: r.state, city: r.city, station: r.station, time: parseTime(r.last_update), sub: {} };
  const v = Number(r.avg_value);
  if (r.avg_value !== "NA" && Number.isFinite(v)) s.sub[r.pollutant_id] = v;
  stations.set(key, s);
}

// Drop stations that stopped reporting or don't meet CPCB's AQI rule.
const newest = Math.max(...[...stations.values()].map((s) => s.time?.getTime() ?? 0));
const fresh = [...stations.values()].filter((s) => {
  const ids = Object.keys(s.sub);
  return s.time && newest - s.time.getTime() <= STALE_HOURS * 3600e3 &&
    ids.length >= MIN_POLLUTANTS && "PM2.5" in s.sub;
});
for (const s of fresh) {
  s.aqi = Math.max(...Object.values(s.sub));
  s.pm25 = pm25FromIndex(s.sub["PM2.5"]);
}

// City value = average of its stations (the way CPCB's city bulletin aggregates).
const cities = new Map();
for (const s of fresh) {
  const c = cities.get(s.city) ?? { name: s.city, state: s.state, stations: [] };
  c.stations.push(s);
  cities.set(s.city, c);
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const out = [...cities.values()]
  .map((c) => ({
    name: c.name,
    state: c.state,
    ug: Math.round(avg(c.stations.map((s) => s.pm25))),
    aqi: Math.round(avg(c.stations.map((s) => s.aqi))),
    stations: c.stations.length,
  }))
  .sort((a, b) => b.aqi - a.aqi);

const data = {
  source: "CPCB real-time AQI via data.gov.in",
  updated: new Date(newest).toISOString(),
  fetched: new Date().toISOString(),
  cities: out,
};
await Bun.write(OUT, JSON.stringify(data));
console.log(`Wrote ${out.length} cities from ${fresh.length} stations to ${OUT}`);
console.log(out.slice(0, 5).map((c) => `${c.name}: AQI ${c.aqi} (PM2.5 ${c.ug})`).join("\n"));
