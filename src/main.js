import { setupDownload } from "./video.js";

// Indian cities: every CPCB station in India, aggregated hourly into cpcb.json by
// scripts/fetch-cpcb.js (GitHub Action). Foreign city: live PM2.5 from Open-Meteo.
const CPCB_JSON = "./cpcb.json";
const API = "https://air-quality-api.open-meteo.com/v1/air-quality";

// Clean-air pool for the foreign "Good" city. Pakistan is intentionally excluded.
const WORLD = [
  ["Reykjavik", 64.1466, -21.9426], ["Wellington", -41.2866, 174.7756], ["Hobart", -42.8821, 147.3272],
  ["Honolulu", 21.3069, -157.8583], ["Helsinki", 60.1699, 24.9384], ["Oslo", 59.9139, 10.7522],
  ["Stockholm", 59.3293, 18.0686], ["Zurich", 47.3769, 8.5417], ["Vancouver", 49.2827, -123.1207],
  ["Canberra", -35.2809, 149.13], ["Copenhagen", 55.6761, 12.5683], ["Dublin", 53.3498, -6.2603],
];

// India CPCB AQI from PM2.5 (µg/m³), piecewise linear.
const BANDS = [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 380, 400, 500]];
const aqiOf = (c) => {
  for (const [cl, ch, il, ih] of BANDS) if (c <= ch) return Math.round(il + ((c - cl) * (ih - il)) / (ch - cl));
  return 500;
};
const CATS = [
  [50, "Good", "#20c95a"], [100, "Satisfactory", "#a6e04a"], [200, "Moderate", "#ffff1a"],
  [300, "Poor", "#ff9a1f"], [400, "Very Poor", "#e60000"], [Infinity, "Severe", "#8b1a1a"],
];
const catOf = (aqi) => CATS.find(([max]) => aqi <= max);

async function fetchPm(list) {
  const lat = list.map((c) => c[1]).join(",");
  const lon = list.map((c) => c[2]).join(",");
  const res = await fetch(`${API}?latitude=${lat}&longitude=${lon}&current=pm2_5&timezone=auto`);
  if (!res.ok) throw new Error(`Air quality API ${res.status}`);
  const json = await res.json();
  return (Array.isArray(json) ? json : [json])
    .map((r, i) => ({ name: list[i][0], ug: r.current?.pm2_5, time: r.current?.time }))
    .filter((c) => typeof c.ug === "number")
    .map((c) => ({ ...c, ug: Math.round(c.ug), aqi: aqiOf(Math.round(c.ug)) }));
}

async function fetchCpcb() {
  const res = await fetch(CPCB_JSON, { cache: "no-store" });
  if (!res.ok) throw new Error(`CPCB data ${res.status}`);
  const data = await res.json();
  return data.cities.filter((c) => c.ug > 0).map((c) => ({ ...c, time: data.updated, source: "CPCB" }));
}

// AQI shown while the dots count up; ends exactly on the city's AQI.
const aqiAt = (city, shown) => (city.ug ? Math.round((city.aqi * shown) / city.ug) : city.aqi);

// Worst two Indian cities, then the worst Indian city in a cleaner category, then the cleanest foreign city.
function pickCities(india, world) {
  const ranked = [...india].sort((a, b) => b.aqi - a.aqi);
  const [first, second] = ranked;
  const secondCat = catOf(second.aqi)[1];
  const third = ranked.slice(2).find((c) => catOf(c.aqi)[1] !== secondCat) ?? ranked[ranked.length - 1];
  const foreign = [...world].sort((a, b) => a.aqi - b.aqi)[0];
  return [first, second, third, foreign];
}

// Google Fonts is injected here instead of in index.html: Bun's dev HMR runtime
// throws "Invalid URL" on external <link> tags in some browsers.
const font = document.createElement("link");
font.rel = "stylesheet";
font.href = "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap";
document.head.appendChild(font);

// ---------- layout ----------
const screen = document.getElementById("screen");
function fit() {
  const s = Math.min(innerWidth / 1080, innerHeight / 1920);
  screen.style.transform = `translate(-50%, -50%) scale(${s})`;
}
addEventListener("resize", fit);
fit();

document.getElementById("date").textContent = new Date()
  .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
  .replace("Sept", "Sep")
  .toUpperCase();

// ---------- rows ----------
const BOX_W = 547, BOX_H = 156, R = 4.4, FADE_MS = 420, DROP = 16;

// Jittered grid: one dot per random cell, so dots never overlap each other
// or the "≈ µg/m³" label in the top-right corner.
const PAD = 6, LABEL = { x: BOX_W - 150, y: 0, w: 150, h: 38 };
function placeDots(n) {
  const W = BOX_W - 2 * PAD, H = BOX_H - 2 * PAD;
  let cell = Math.sqrt((W * H) / (n * 1.25 + 20));
  let cols, rows, cells;
  for (;;) {
    cols = Math.max(1, Math.floor(W / cell));
    rows = Math.max(1, Math.floor(H / cell));
    cells = [];
    for (let cy = 0; cy < rows; cy++)
      for (let cx = 0; cx < cols; cx++) {
        const x0 = PAD + cx * (W / cols), y0 = PAD + cy * (H / rows);
        const hitsLabel = x0 + W / cols > LABEL.x && y0 < LABEL.y + LABEL.h;
        if (!hitsLabel) cells.push([x0, y0]);
      }
    if (cells.length >= n || cell < 4) break;
    cell *= 0.92;
  }
  const cw = W / cols, ch = H / rows;
  const r = Math.min(R, (Math.min(cw, ch) - 1.5) / 2);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, n).map(([x0, y0]) => ({
    x: x0 + r + Math.random() * Math.max(0, cw - 2 * r),
    y: y0 + r + Math.random() * Math.max(0, ch - 2 * r),
    r,
  }));
}

function buildRow(city) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <div class="city"></div>
    <div class="aqi-line"><span class="aqi-label">AQI</span><span class="aqi-num">0</span><span class="badge"></span></div>
    <div class="box"><canvas></canvas><span class="ug">≈ 0 µg/m³</span></div>`;
  row.querySelector(".city").textContent = city.name;
  const [, label, color] = catOf(city.aqi);
  const badge = row.querySelector(".badge");
  badge.textContent = label;
  badge.style.background = color;
  if (label === "Severe") badge.style.color = "#fff";

  const canvas = row.querySelector("canvas");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = BOX_W * dpr;
  canvas.height = BOX_H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const dots = placeDots(city.ug);

  return {
    city, row, ctx, dots, badge, done: false,
    num: row.querySelector(".aqi-num"),
    ug: row.querySelector(".ug"),
  };
}

function draw(r, u, now) {
  const shown = Math.min(u, r.city.ug);
  r.num.textContent = aqiAt(r.city, Math.floor(shown));
  r.ug.textContent = `≈ ${Math.floor(shown)} µg/m³`;
  const { ctx } = r;
  ctx.clearRect(0, 0, BOX_W, BOX_H);
  const visible = Math.floor(shown);
  for (let i = 0; i < visible; i++) {
    const d = r.dots[i];
    d.born ??= now;
    const k = Math.min(1, (now - d.born) / FADE_MS);
    const e = 1 - (1 - k) ** 3; // ease-out
    const g = Math.round(190 * (1 - e));
    ctx.fillStyle = `rgba(${g},${g},${g},${e})`; // fade in grey -> black
    // Drop in from above, clamped so the dot never leaves the box.
    const y = Math.max(d.r + 1, d.y - DROP * (1 - e));
    ctx.beginPath();
    ctx.arc(d.x, y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!r.done && u >= r.city.ug) {
    r.done = true;
    r.badge.classList.add("show");
  }
}

// ---------- timeline ----------
const T_ROWS = 1900, ROW_GAP = 220, COUNT_DELAY = 700, COUNT_SECONDS = 6.5;
const t0 = performance.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const status = document.getElementById("status");
  let cities;
  try {
    const [india, world] = await Promise.all([fetchCpcb(), fetchPm(WORLD)]);
    cities = pickCities(india, world);
  } catch (err) {
    status.textContent = "Live air quality data is unavailable right now. Please try again shortly.";
    status.classList.add("show");
    console.error(err);
    return;
  }

  const rowsEl = document.getElementById("rows");
  const rows = cities.map(buildRow);
  rows.forEach((r) => rowsEl.appendChild(r.row));

  await wait(Math.max(0, T_ROWS - (performance.now() - t0)));
  for (const r of rows) { r.row.classList.add("show"); await wait(ROW_GAP); }
  await wait(COUNT_DELAY);

  const max = Math.max(...cities.map((c) => c.ug));
  const rate = Math.max(max / COUNT_SECONDS, 10) / 1000; // µg per ms, shared by all rows like the video
  const start = performance.now();
  const frame = (now) => {
    const u = (now - start) * rate;
    rows.forEach((r) => draw(r, u, now));
    const fading = rows.some((r) => r.dots.some((d) => d.born && now - d.born < FADE_MS));
    if (u < max || fading) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const ist = new Date(cities[0].time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const updated = ` · CPCB updated ${ist} IST`;
  status.textContent = `India: CPCB stations (data.gov.in) · ${cities[3].name}: Open-Meteo / CAMS · AQI: CPCB scale${updated}`;
  setTimeout(() => {
    status.classList.add("show");
    setupDownload({
      rows, rate, max, aqiAt, BOX_W, BOX_H, FADE_MS, DROP,
      timing: { T_ROWS, ROW_GAP, COUNT_DELAY },
    });
  }, (max / rate) + 600);
}

run();
