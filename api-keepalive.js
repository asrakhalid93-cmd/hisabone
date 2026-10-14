// /api/keepalive.js  —  HisabOne daily Supabase keep-alive
// Purpose: generate a few real database requests every day so Supabase's
// free-tier inactivity pause (7 days without "sufficient user activity") never
// triggers again. Reads only; writes nothing; returns no data.
//
// Vercel cron calls this once a day (see vercel.json). If CRON_SECRET is set in
// Vercel env vars, the request must carry it — Vercel adds that header itself.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phpbzlrvdnollbzrqrhh.supabase.co';

module.exports = async (req, res) => {
  // Optional auth (only enforced if CRON_SECRET exists)
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set' });

  const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' };
  // A handful of cheap, read-only requests across real tables = "user activity"
  const tables = ['profiles', 'site_events', 'businesses'];
  const results = {};

  for (const t of tables) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=id&limit=1`, { method: 'HEAD', headers });
      // content-range looks like "0-0/123"; we only keep the status, never the data
      results[t] = r.status;
    } catch (e) {
      results[t] = 'error';
    }
  }

  const allOk = Object.values(results).every((s) => s === 200 || s === 206);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(allOk ? 200 : 502).json({ ok: allOk, ts: new Date().toISOString(), results });
};
