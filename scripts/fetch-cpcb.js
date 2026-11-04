// Writes city-level CPCB AQI to a JSON file, for running the site locally.
// The live site reads the same data from the Vercel function in cpcb-api/.
// Usage: bun scripts/fetch-cpcb.js [outfile]   (reads CPCB_API_KEY from .env)
import { buildCpcb } from "../cpcb-api/lib/cpcb.js";

const OUT = process.argv[2] ?? "dist/cpcb.json";

try {
  const data = await buildCpcb(process.env.CPCB_API_KEY);
  await Bun.write(OUT, JSON.stringify(data));
  console.log(`Wrote ${data.cities.length} cities from ${data.stationCount} stations to ${OUT}`);
  console.log(data.cities.slice(0, 5).map((c) => `${c.name}: AQI ${c.aqi} (PM2.5 ${c.ug})`).join("\n"));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
