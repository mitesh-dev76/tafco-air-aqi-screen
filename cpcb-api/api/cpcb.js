// GET /api/cpcb -> city-level CPCB AQI for India as JSON.
// Runs in Vercel's Mumbai region (see vercel.json) because data.gov.in doesn't answer
// requests from outside India. Vercel's CDN caches the response, so data.gov.in is
// called at most a few times an hour no matter how many people open the page.
import { buildCpcb } from "../lib/cpcb.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  try {
    // Vercel functions have a time limit, so retry less and fail faster than the local script.
    const data = await buildCpcb(process.env.CPCB_API_KEY, { attempts: 2, timeoutMs: 20_000 });
    return Response.json(data, {
      headers: {
        ...CORS,
        // Fresh for 30 min on the CDN; if CPCB is down, keep serving the last good copy for 6 h.
        "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=21600, stale-if-error=21600",
      },
    });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message }, { status: 502, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
}
