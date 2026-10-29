// /api/keepalive.js  —  HisabOne daily Supabase keep-alive + orphaned-file sweep
//
// 1. Keep-alive: a few real database reads every day so Supabase's free-tier
//    inactivity pause (7 days without "sufficient user activity") never fires.
// 2. Vault sweep: deletes files in the `vault` bucket that belong to accounts
//    which no longer exist. Account deletion erases every database row, but a
//    browser can only reach its OWN storage folder (RLS: vault_files_own), so
//    an admin deletion — or a failed clean-up during self-deletion — can leave
//    documents behind. Those are personal data with no owner, so they go.
//
// Vercel cron calls this once a day (see vercel.json). If CRON_SECRET is set in
// Vercel env vars, the request must carry it — Vercel adds that header itself.
//
// Query flags (handy when testing by hand):
//   ?dry=1     report what the sweep would delete, delete nothing
//   ?sweep=0   keep-alive only, skip the sweep

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phpbzlrvdnollbzrqrhh.supabase.co';
const BUCKET = 'vault';
const MAX_FOLDERS_PER_RUN = 25;    // a runaway sweep is worse than a slow one
const MAX_FILES_PER_RUN = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Every folder in the bucket is named after the account that owns it. Anything
   whose name is not a live profile id is an orphan. The guards matter more than
   the deletion: if we cannot prove the owner list is complete, we delete nothing. */
async function sweepOrphanVaultFiles(headers, dryRun) {
  const out = { ran: false, folders: 0, files: 0, deleted: [], skipped: null };

  // 1. the authoritative list of live accounts
  let liveIds;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id`, { headers });
    if (!r.ok) { out.skipped = `profiles HTTP ${r.status}`; return out; }
    const rows = await r.json();
    if (!Array.isArray(rows)) { out.skipped = 'profiles: unexpected payload'; return out; }
    // An empty profile table would mark every folder an orphan. That is far more
    // likely to be a broken request than a genuinely empty product, so stop.
    if (rows.length === 0) { out.skipped = 'profiles returned 0 rows — refusing to sweep'; return out; }
    liveIds = new Set(rows.map((x) => String(x.id)));
  } catch (e) {
    out.skipped = `profiles: ${e.message || 'fetch failed'}`;
    return out;
  }

  // 2. top-level folders in the bucket (one per account)
  let folders;
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!r.ok) { out.skipped = `list HTTP ${r.status}`; return out; }
    const rows = await r.json();
    if (!Array.isArray(rows)) { out.skipped = 'list: unexpected payload'; return out; }
    folders = rows.filter((x) => x && x.name && x.id === null).map((x) => x.name);
  } catch (e) {
    out.skipped = `list: ${e.message || 'fetch failed'}`;
    return out;
  }

  const orphans = folders.filter((f) => UUID_RE.test(f) && !liveIds.has(f)).slice(0, MAX_FOLDERS_PER_RUN);
  out.ran = true;
  out.folders = orphans.length;
  if (!orphans.length) return out;

  // 3. delete through the Storage API, not SQL: removing a storage.objects row
  //    by hand leaves the actual file sitting in the bucket, unreachable.
  const prefixes = [];
  for (const folder of orphans) {
    try {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 }),
      });
      if (!r.ok) continue;
      const files = await r.json();
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        if (f && f.name && f.id !== null) prefixes.push(`${folder}/${f.name}`);
        if (prefixes.length >= MAX_FILES_PER_RUN) break;
      }
    } catch (e) { /* next folder */ }
    if (prefixes.length >= MAX_FILES_PER_RUN) break;
  }

  out.files = prefixes.length;
  out.deleted = orphans;
  if (!prefixes.length || dryRun) return out;

  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes }),
    });
    if (!r.ok) { out.skipped = `delete HTTP ${r.status}`; out.files = 0; }
  } catch (e) {
    out.skipped = `delete: ${e.message || 'fetch failed'}`;
    out.files = 0;
  }
  return out;
}

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

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const q = (req.query || {});

  // A handful of cheap, read-only requests across real tables = "user activity"
  const tables = ['profiles', 'site_events', 'returns'];
  const results = {};
  for (const t of tables) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=id&limit=1`, {
        method: 'HEAD',
        headers: { ...headers, Prefer: 'count=exact' },
      });
      // content-range looks like "0-0/123"; we only keep the status, never the data
      results[t] = r.status;
    } catch (e) {
      results[t] = 'error';
    }
  }

  // Housekeeping: documents whose owner no longer exists
  let sweep = { ran: false, skipped: 'disabled by query' };
  if (String(q.sweep || '') !== '0') {
    sweep = await sweepOrphanVaultFiles(headers, String(q.dry || '') === '1');
  }

  const allOk = Object.values(results).every((s) => s === 200 || s === 206);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(allOk ? 200 : 502).json({
    ok: allOk,
    ts: new Date().toISOString(),
    results,
    sweep,
    dryRun: String(q.dry || '') === '1',
  });
};
