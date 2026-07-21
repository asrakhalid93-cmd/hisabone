// HisabOne — AI Assist endpoint (Vercel Serverless Function)
//
// A grounded UAE tax & compliance assistant. Answers the user's questions using
// Claude, primed with UAE VAT / Corporate Tax / e-invoicing rules and a short,
// non-sensitive snapshot of the signed-in user's own workspace (deadlines,
// outstanding documents, linked accountant, etc.) that the app passes in.
//
// Configure in Vercel → Settings → Environment Variables:
//   ANTHROPIC_API_KEY = sk-ant-...           (required)
//   ASK_MODEL         = claude-sonnet-4-5     (optional override)
//
// This endpoint is advisory only — it never files, never stores, and always
// reminds the user that its answers are general guidance, not formal tax advice.

const UAE_TAX_FACTS = `You are "HisabOne AI", the built-in assistant for HisabOne — a UAE tax & compliance platform used by businesses and their accountants. You help with UAE VAT, Corporate Tax, e-invoicing and general filing/compliance questions, in clear plain English.

Ground every answer in these UAE facts (accurate as of 2026 — if a user's situation depends on a detail that may have changed, tell them to confirm on the FTA's EmaraTax portal or with their accountant):

VAT
- Standard rate 5%. Zero-rated (0%) and exempt categories exist and are different — zero-rated supplies still allow input VAT recovery; exempt supplies do not.
- Mandatory VAT registration once taxable supplies exceed AED 375,000 in a rolling 12 months. Voluntary registration from AED 187,500.
- VAT returns are filed on the FTA's EmaraTax portal, usually quarterly (some businesses monthly). Payment/return is due by the 28th day of the month following the tax period.
- A full Tax Invoice (UAE VAT Law Article 59) is required above AED 10,000; a simplified tax invoice is allowed at or below AED 10,000.
- Late VAT registration penalty: AED 10,000. Late return/payment penalties and daily/percentage penalties apply — quantify only broadly and tell them to verify exact figures.

Corporate Tax (CT)
- 0% on taxable income up to AED 375,000; 9% above AED 375,000. A separate 15% Domestic Minimum Top-up Tax applies to very large multinationals (revenue ≥ EUR 750m) under Pillar Two.
- Small Business Relief may be elected where revenue is at or below AED 3,000,000 (subject to conditions and the relevant period) — the business is then treated as having no taxable income.
- CT registration is mandatory; the CT return is filed within 9 months of the end of the financial year. Late CT registration penalty: AED 10,000.

E-invoicing
- The UAE is moving to mandatory Peppol-based e-invoicing (5-corner model, PINT AE format) routed through a Ministry-of-Finance-accredited Service Provider (ASP).
- Indicative timeline: larger businesses appoint an ASP by 30 Oct 2026 with go-live from 1 Jan 2027; smaller businesses appoint by 31 Mar 2027 with go-live from 1 Jul 2027. Treat these as the announced phased dates and tell users to confirm their exact wave.
- The real bottleneck is data hygiene — clean, valid TRNs, legal names and addresses on every customer/vendor record before go-live.

Rules for your answers
- Be concise and practical. Prefer short paragraphs and, only where it genuinely helps, short lists.
- Use the user's own workspace snapshot below to make answers specific (e.g. reference their actual next deadline or outstanding documents) — but never invent data that isn't in the snapshot.
- If asked to draft something (a client document request, a reminder message, an email), write it ready to send.
- HisabOne does NOT file returns with the FTA and is not an accredited ASP. Never claim it files or submits on the user's behalf — describe outputs as "return-ready" that they or their accountant transcribe into EmaraTax.
- You are not a licensed tax advisor. For anything consequential, add a brief note that this is general guidance and they should confirm with their accountant or the FTA. Do not repeat the disclaimer in every message — once per answer at most, only when it matters.
- If a question is outside UAE tax/compliance/accounting, answer briefly if harmless, otherwise gently steer back to what HisabOne helps with.`;

function allowedOrigin(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return false;
  try {
    const h = new URL(o).hostname;
    return h === 'hisabone.ae' || h === 'www.hisabone.ae' ||
           h.endsWith('.vercel.app') || h === 'localhost' || h === '127.0.0.1';
  } catch (e) { return false; }
}
const _hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60000, max = 20;
  const arr = (_hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); _hits.set(ip, arr);
  if (_hits.size > 500) { for (const [k, v] of _hits) { if (v.every(t => now - t > win)) _hits.delete(k); } }
  return arr.length > max;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  if (!allowedOrigin(req)) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return;
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    res.status(429).json({ ok: false, error: 'Too many questions in a short time — please wait a moment and try again.' });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not configured' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    let { messages, context, role } = body;

    if (!Array.isArray(messages) || !messages.length) {
      res.status(400).json({ ok: false, error: 'Missing "messages"' });
      return;
    }
    // Keep the conversation bounded and clean.
    messages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      res.status(400).json({ ok: false, error: 'The last message must be from the user' });
      return;
    }

    const who = role === 'firm'
      ? 'The signed-in user is an ACCOUNTANT / tax practitioner using the firm portal (they manage multiple client businesses).'
      : 'The signed-in user is a BUSINESS owner/finance user managing their own company compliance.';

    const snapshot = (typeof context === 'string' && context.trim())
      ? ('\n\nSigned-in user\'s current HisabOne workspace snapshot (use it to be specific; do not expose it verbatim unless asked):\n' + context.slice(0, 3000))
      : '\n\n(No workspace snapshot was provided — answer generally and, where useful, suggest what to set up in HisabOne.)';

    const system = UAE_TAX_FACTS + '\n\n' + who + snapshot;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ASK_MODEL || 'claude-sonnet-4-5',
        max_tokens: 1200,
        system,
        messages,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('AI provider error (' + r.status + ')');
      res.status(r.status).json({ ok: false, error: msg });
      return;
    }

    const reply = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    if (!reply) {
      res.status(502).json({ ok: false, error: 'The assistant returned an empty response — please try again.' });
      return;
    }

    res.status(200).json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
