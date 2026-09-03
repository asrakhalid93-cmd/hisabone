// api/admin-digest.js — HisabOne weekly owner digest
// Runs every Monday 09:00 UAE via the cron in vercel.json, or on demand from
// the Command Centre. Reads account stats through the service-role-only
// admin_digest() RPC and emails the summary to the owner via Resend.
//
// Required Vercel environment variables:
//   SUPABASE_SERVICE_ROLE_KEY  — Supabase Dashboard → Project Settings → API → service_role
//   RESEND_API_KEY             — already set (used by send-email)

const SUPABASE_URL = 'https://phpbzlrvdnollbzrqrhh.supabase.co';
const TO = 'asra@hisabone.ae';
const FROM = 'HisabOne <info@hisabone.ae>';

export default async function handler(req, res) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resend = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ ok:false, error:'SUPABASE_SERVICE_ROLE_KEY is not set in Vercel' });
  if (!resend) return res.status(500).json({ ok:false, error:'RESEND_API_KEY is not set in Vercel' });

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/admin_digest', {
      method: 'POST',
      headers: { apikey:key, Authorization:'Bearer '+key, 'Content-Type':'application/json' },
      body: '{}'
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));

    const t = d.totals || {};
    const li = (arr, fmt, empty) => (arr && arr.length)
      ? arr.map(fmt).join('')
      : '<li style="color:#8a8aa0">' + empty + '</li>';
    const pill = role => role === 'firm'
      ? '<span style="background:#ede7ff;color:#4326c9;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700">Accountant</span>'
      : '<span style="background:#e0f7ff;color:#0b6b80;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700">Business</span>';

    const html =
      '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#232336">'
      + '<div style="background:linear-gradient(128deg,#17132b,#221b46 52%,#2b2160);border-radius:14px;padding:22px 26px;color:#fff">'
      +   '<div style="font-size:20px;font-weight:800">Hisab<span style="color:#8a75ff">One</span> — weekly digest</div>'
      +   '<div style="font-size:12.5px;color:#c7b9ff;margin-top:4px">' + new Date().toDateString() + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;margin:16px 0">'
      +   [['Businesses', t.businesses], ['Firms', t.firms], ['Linked pairs', t.links], ['Returns filed', t.returns_approved]]
          .map(x => '<div style="flex:1;border:1px solid #e8e5f4;border-radius:10px;padding:10px;text-align:center"><div style="font-size:20px;font-weight:800;color:#5a3fff">' + (x[1] ?? 0) + '</div><div style="font-size:11px;color:#6e6e85">' + x[0] + '</div></div>').join('')
      + '</div>'
      + '<h3 style="font-size:14px;margin:18px 0 6px">🆕 New this week</h3><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8">'
      +   li(d.new_7d, x => '<li><b>' + x.name + '</b> (' + x.email + ') ' + pill(x.role) + ' · ' + x.at + '</li>', 'No new sign-ups this week.')
      + '</ul>'
      + '<h3 style="font-size:14px;margin:18px 0 6px">✅ Active in the last 7 days</h3><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8">'
      +   li(d.active_7d, x => '<li><b>' + x.name + '</b> (' + x.email + ') ' + pill(x.role) + '</li>', 'Nobody signed in this week.')
      + '</ul>'
      + '<h3 style="font-size:14px;margin:18px 0 6px">💤 Gone quiet (14+ days)</h3><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8">'
      +   li(d.quiet_14d, x => '<li><b>' + x.name + '</b> (' + x.email + ') ' + pill(x.role) + ' · ' + x.days + ' days — worth a nudge</li>', 'Nobody has gone quiet. 🎉')
      + '</ul>'
      + '<div style="margin-top:20px;font-size:11.5px;color:#8a8aa0">Full detail in the <a href="https://hisabone.ae/admin" style="color:#5a3fff">Command Centre</a>. Sent automatically every Monday morning.</div>'
      + '</div>';

    const er = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization:'Bearer '+resend, 'Content-Type':'application/json' },
      body: JSON.stringify({ from:FROM, to:[TO], subject:'HisabOne weekly digest — '
        + (d.new_7d?.length || 0) + ' new, ' + (d.active_7d?.length || 0) + ' active, '
        + (d.quiet_14d?.length || 0) + ' quiet', html })
    });
    const ej = await er.json();
    if (!er.ok) throw new Error(JSON.stringify(ej));

    return res.status(200).json({ ok:true, sent:TO, new_7d:d.new_7d?.length || 0 });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
}
