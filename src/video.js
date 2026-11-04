// Offline MP4 export: redraws the whole story frame-by-frame on a 1080x1920 canvas
// (same layout, data and timings as the live page), encodes it to H.264 with the
// browser's WebCodecs VideoEncoder, and muxes it into an .mp4 with mp4-muxer.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

const W = 1080, H = 1920, FPS = 30, HOLD_MS = 2000;
const CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42002a"];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeOutBack = (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
const prog = (t, start, dur) => clamp01((t - start) / dur);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, k) => {
  const [x, y] = [hex(a), hex(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(",")})`;
};

// Element boxes in 1080x1920 frame coordinates, read from the finished live page.
function measure(screen) {
  const s = screen.getBoundingClientRect();
  const k = s.width / W;
  return (el) => {
    const r = el.getBoundingClientRect();
    return { x: (r.left - s.left) / k, y: (r.top - s.top) / k, w: r.width / k, h: r.height / k };
  };
}

// Places text in its CSS line box the way the browser does (half-leading).
function text(ctx, str, x, top, boxH, font, color, spacing = 0, align = "left") {
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(str);
  const base = top + (boxH + m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  ctx.fillStyle = color;
  ctx.fillText(str, x, base);
  return m.width;
}

// Word-wraps text with "PM|2.5" style subscripts.
function paragraph(ctx, words, x, top, width, size, lineH, color, spacing) {
  const main = `400 ${size}px Outfit, system-ui, sans-serif`, sub = `400 ${size * 0.55}px Outfit, system-ui, sans-serif`;
  ctx.letterSpacing = `${spacing}px`;
  const parts = (w) => w.split("|");
  const widthOf = (w) => {
    const [a, b] = parts(w);
    ctx.font = main; let n = ctx.measureText(a).width;
    if (b) { ctx.font = sub; n += ctx.measureText(b).width; }
    return n;
  };
  ctx.font = main;
  const space = ctx.measureText(" ").width;
  let cx = x, line = 0;
  for (const w of words) {
    const ww = widthOf(w);
    if (cx > x && cx + ww > x + width) { cx = x; line++; }
    const [a, b] = parts(w);
    const y = top + line * lineH;
    cx += text(ctx, a, cx, y, lineH, main, color, spacing);
    if (b) {
      ctx.font = sub;
      ctx.fillText(b, cx, y + (lineH + size * 0.75) / 2 + size * 0.17);
      cx += ctx.measureText(b).width;
    }
    cx += space;
  }
}

const SUB_WORDS = "PM|2.5 is too fine to see, so we draw it. Each dot is 1 µg of PM|2.5 in a cubic metre of air.".split(" ");

export function setupDownload(opts) {
  const btn = document.createElement("button");
  btn.className = "download";
  btn.textContent = "Download video (MP4)";
  document.body.appendChild(btn);
  requestAnimationFrame(() => btn.classList.add("show"));

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const blob = await renderMp4(opts, (p) => (btn.textContent = `Rendering video… ${Math.round(p * 100)}%`));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `tafco-air-${new Date().toISOString().slice(0, 10)}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      btn.textContent = "Download video (MP4)";
    } catch (err) {
      console.error(err);
      btn.textContent = "Video export not supported in this browser";
      setTimeout(() => (btn.textContent = "Download video (MP4)"), 4000);
    } finally {
      btn.disabled = false;
    }
  });
}

async function pickCodec() {
  if (typeof VideoEncoder === "undefined") throw new Error("WebCodecs VideoEncoder unavailable");
  for (const codec of CODECS) {
    const config = { codec, width: W, height: H, bitrate: 8_000_000, framerate: FPS, avc: { format: "avc" } };
    if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
  }
  throw new Error("No supported H.264 encoder config");
}

async function renderMp4(opts, onProgress) {
  await document.fonts.ready;
  const config = await pickCodec();
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    fastStart: "in-memory",
  });
  let failure;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(config);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const scene = buildScene(opts);
  const total = Math.ceil(((scene.end + HOLD_MS) / 1000) * FPS);

  for (let i = 0; i < total; i++) {
    if (failure) throw failure;
    scene.draw(ctx, (i * 1000) / FPS);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    if (i % 10 === 0) { onProgress(i / total); await new Promise((r) => setTimeout(r, 0)); }
  }
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
  muxer.finalize();
  onProgress(1);
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

// Timeline mirrors style.css (intro) and main.js (rows, counting) on an ideal clock from 0 ms.
function buildScene({ rows, rate, max, timing, aqiAt, BOX_W, BOX_H, FADE_MS, DROP }) {
  const screen = document.getElementById("screen");
  const box = measure(screen);
  const logo = box(screen.querySelector(".logo"));
  const logoDot = box(screen.querySelector(".logo-dot"));
  const date = box(screen.querySelector(".date"));
  const dateText = screen.querySelector(".date").textContent;
  const head = box(screen.querySelector(".headline"));
  const sub = box(screen.querySelector(".sub"));
  const statusEl = document.getElementById("status");
  const status = box(statusEl);
  const L = rows.map((r) => ({
    r,
    city: box(r.row.querySelector(".city")),
    label: box(r.row.querySelector(".aqi-label")),
    num: box(r.row.querySelector(".aqi-num")),
    badge: box(r.badge),
    box: box(r.row.querySelector(".box")),
    ug: box(r.ug),
  }));

  const { T_ROWS, ROW_GAP, COUNT_DELAY } = timing;
  const start = T_ROWS + rows.length * ROW_GAP + COUNT_DELAY;
  const countEnd = start + max / rate;
  const end = countEnd + FADE_MS + 600 + 500;

  function draw(ctx, t) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);

    // Logo: 0.15s + 0.9s, fade in then grey -> black; red dot pops at 1.1s.
    const kl = prog(t, 150, 900);
    if (kl > 0) {
      ctx.globalAlpha = clamp01(kl * 2);
      const color = kl < 0.5 ? mix("#e6e6e6", "#bdbdbd", easeOut(kl * 2)) : mix("#bdbdbd", "#111111", easeOut((kl - 0.5) * 2));
      text(ctx, "TΛFCO", logo.x, logo.y, logo.h, "500 64px Outfit, system-ui, sans-serif", color, 1);
    }
    const kd = prog(t, 1100, 380);
    if (kd > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#d8443a";
      ctx.beginPath();
      ctx.arc(logoDot.x + logoDot.w / 2, logoDot.y + logoDot.h / 2, 6.5 * Math.max(0, easeOutBack(kd)), 0, Math.PI * 2);
      ctx.fill();
    }

    // Date and headline at 0.8s, sub copy at 1.5s.
    ctx.globalAlpha = easeOut(prog(t, 800, 500));
    text(ctx, dateText, date.x, date.y, date.h, "600 23px Outfit, system-ui, sans-serif", "#555555", 2);
    const kh = easeOut(prog(t, 800, 750));
    if (kh > 0) {
      ctx.globalAlpha = kh;
      const c = mix("#cfcfcf", "#111111", kh);
      text(ctx, "Today's air,", head.x, head.y, 75, "600 75px Outfit, system-ui, sans-serif", c, -2.5);
      const w = text(ctx, "dot by dot", head.x, head.y + 75, 75, "600 75px Outfit, system-ui, sans-serif", c, -2.5);
      text(ctx, ".", head.x + w, head.y + 75, 75, "600 75px Outfit, system-ui, sans-serif", "#d8443a", -2.5);
    }
    ctx.globalAlpha = easeOut(prog(t, 1500, 650));
    paragraph(ctx, SUB_WORDS, sub.x, sub.y, sub.w, 30, 41, "#6f6f6f", -0.3);

    // Rows.
    const u = Math.max(0, (t - start) * rate);
    L.forEach((l, i) => {
      const a = easeOut(prog(t, T_ROWS + i * ROW_GAP, 500));
      if (a <= 0) return;
      const { r } = l;
      const shown = Math.min(u, r.city.ug);
      ctx.globalAlpha = a;
      text(ctx, r.city.name, l.city.x, l.city.y, l.city.h, "600 56px Outfit, system-ui, sans-serif", "#111111", -1);
      text(ctx, "AQI", l.label.x, l.label.y, l.label.h, "500 20px Outfit, system-ui, sans-serif", "#6f6f6f", 2);
      const nw = text(ctx, String(aqiAt(r.city, Math.floor(shown))), l.num.x, l.num.y, l.num.h, "600 60px Outfit, system-ui, sans-serif", "#111111", -1.5);

      const kb = easeOut(prog(t, start + r.city.ug / rate, 400));
      if (kb > 0) {
        const bx = l.num.x + nw + 14;
        ctx.font = "500 21px Outfit, system-ui, sans-serif"; ctx.letterSpacing = "0px";
        const bw = ctx.measureText(r.badge.textContent).width + 26;
        ctx.globalAlpha = a * kb;
        ctx.fillStyle = mix("#f2f2f2", r.badge.style.background.startsWith("rgb") ? rgbToHex(r.badge.style.background) : r.badge.style.background, kb);
        ctx.beginPath();
        ctx.roundRect(bx, l.badge.y, bw, l.badge.h, l.badge.h / 2);
        ctx.fill();
        text(ctx, r.badge.textContent, bx + 13, l.badge.y, l.badge.h, "500 21px Outfit, system-ui, sans-serif", r.badge.style.color || "#111111");
      }

      // Box, dots and µg label.
      ctx.globalAlpha = a;
      ctx.strokeStyle = "#dcdcdc"; ctx.lineWidth = 2;
      ctx.strokeRect(l.box.x + 1, l.box.y + 1, l.box.w - 2, l.box.h - 2);
      ctx.save();
      ctx.translate(l.box.x + 2, l.box.y + 2);
      ctx.beginPath(); ctx.rect(0, 0, BOX_W, BOX_H); ctx.clip();
      const visible = Math.floor(shown);
      for (let j = 0; j < visible; j++) {
        const d = r.dots[j];
        const e = easeOut(prog(t, start + (j + 1) / rate, FADE_MS));
        const g = Math.round(190 * (1 - e));
        ctx.globalAlpha = a * e;
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.beginPath();
        ctx.arc(d.x, Math.max(d.r + 1, d.y - DROP * (1 - e)), d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = a;
      text(ctx, `≈ ${Math.floor(shown)} µg/m³`, l.ug.x + l.ug.w - 2, l.ug.y, l.ug.h, "400 20px Outfit, system-ui, sans-serif", "#6f6f6f", 0, "right");
    });

    // Source line.
    ctx.globalAlpha = easeOut(prog(t, countEnd + 600, 500));
    if (ctx.globalAlpha > 0) paragraph(ctx, statusEl.textContent.split(" "), status.x, status.y, status.w, 22, 22 * 1.3, "#9a9a9a", 0);
    ctx.globalAlpha = 1;
  }

  return { draw, end };
}

function rgbToHex(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
