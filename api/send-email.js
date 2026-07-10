// HisabOne — transactional email endpoint (Vercel Serverless Function)
//
// Sends email via Resend (https://resend.com). Configure in Vercel:
//   Project → Settings → Environment Variables
//     RESEND_API_KEY = re_xxxxxxxx        (required)
//     EMAIL_FROM     = HisabOne <hello@yourdomain.com>   (optional)
//
// Until a domain is verified in Resend, use the built-in sender
// "onboarding@resend.dev" — note Resend test mode only delivers to the
// email address that owns the Resend account.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    res.status(500).json({ ok: false, error: 'RESEND_API_KEY is not configured' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { to, subject, text, html } = body;

    if (!to || !subject) {
      res.status(400).json({ ok: false, error: 'Missing "to" or "subject"' });
      return;
    }

    const from = process.env.EMAIL_FROM || 'HisabOne <onboarding@resend.dev>';

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        text: text || undefined,
        html: html || undefined,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(r.status).json({ ok: false, error: data });
      return;
    }

    res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
