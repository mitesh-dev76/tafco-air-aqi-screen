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

// CPCB National AQI breakpoints (24-hour average, µg/m³), linear within each band.
const PM25 = [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 380, 400, 500]];
const PM10 = [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 510, 400, 500]];
const subIndex = (bands, c) => {
  for (const [cl, ch, il, ih] of bands) if (c <= ch) return il + ((c - cl) * (ih - il)) / (ch - cl);
  return 500;
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
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(url);
      if (res.ok || attempt === 4) break;
      await Bun.sleep(attempt * 5000);
    }
    if (!res.ok) throw new Error(`data.gov.in ${res.status}: ${await res.text()}`);
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
  const s = stations.get(key) ?? { state: r.state, city: r.city, station: r.station, time: parseTime(r.last_update) };
  const v = Number(r.avg_value);
  if (Number.isFinite(v)) {
    if (r.pollutant_id === "PM2.5") s.pm25 = v;
    if (r.pollutant_id === "PM10") s.pm10 = v;
  }
  stations.set(key, s);
}

// Drop stations that stopped reporting; station AQI = worst of PM2.5 / PM10 sub-index.
const newest = Math.max(...[...stations.values()].map((s) => s.time?.getTime() ?? 0));
const fresh = [...stations.values()].filter(
  (s) => s.time && newest - s.time.getTime() <= STALE_HOURS * 3600e3 && s.pm25 !== undefined,
);
for (const s of fresh) {
  s.aqi = Math.max(subIndex(PM25, s.pm25), s.pm10 !== undefined ? subIndex(PM10, s.pm10) : 0);
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
