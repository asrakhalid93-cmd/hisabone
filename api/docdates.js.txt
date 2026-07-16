// HisabOne — company-document date reader (Vercel Serverless Function)
//
// Reads a company document (trade licence, VAT/CT certificate, Emirates ID,
// passport, etc.) with Claude's vision model and returns its issue and expiry
// dates in ISO form for the document vault. Configure in Vercel:
//   Project → Settings → Environment Variables
//     ANTHROPIC_API_KEY = sk-ant-...        (required)
//     OCR_MODEL         = claude-sonnet-4-5 (optional override)

const PROMPT = `You are a precise reader of UAE business and identity documents (trade licences, certificates of incorporation, VAT/corporate-tax registration certificates, establishment cards, Emirates IDs, passports, chamber-of-commerce certificates, memoranda of association, etc.).

Read the attached document and extract only its dates.

Return ONLY a minified JSON object (no markdown, no code fences, no commentary) with exactly these keys:
{"issueDate":string|null,"expiryDate":string|null,"docType":string|null,"registrationDate":string|null,"taxPeriodEnd":string|null,"taxPeriod":string|null,"financialYearEnd":string|null}

Rules:
- issueDate = the date the document was issued / from which it is valid.
- expiryDate = the date the document expires / is valid until. If the document has no expiry (e.g. a certificate of incorporation or an MOA), use null.
- registrationDate = for a VAT or Corporate Tax registration certificate, the effective date of tax registration / the date registration takes effect. Otherwise null.
- taxPeriodEnd = for a VAT (VAT/TRN) registration certificate, the END date of the FIRST VAT return period / first tax period, if the certificate states it. Otherwise null.
- taxPeriod = for a VAT certificate, the length of the tax period if stated: return exactly "monthly" or "quarterly", otherwise null.
- financialYearEnd = for a Corporate Tax registration certificate, the financial-year end date or the end of the first tax period if stated. If only a day and month are shown (e.g. "31 December"), return it as "MM-DD" (e.g. "12-31"). If a full date is shown, return ISO "YYYY-MM-DD". Otherwise null.
- Format all full dates strictly as ISO "YYYY-MM-DD". Convert any format you see (e.g. "15/03/2024", "15 Mar 2024") to ISO.
- docType = a short label for what the document is (e.g. "Trade License", "VAT Certificate", "Corporate Tax Certificate", "Emirates ID"), or null if unclear.
- Use null for anything genuinely not present. Do not guess or infer dates that are not printed on the document.`;

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
  const now = Date.now(), win = 60000, max = 25;
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
    res.status(429).json({ ok: false, error: 'Too many requests — please wait a moment and try again.' });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not configured' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { mediaType, dataBase64 } = body;

    if (!dataBase64 || !mediaType) {
      res.status(400).json({ ok: false, error: 'Missing "mediaType" or "dataBase64"' });
      return;
    }
    if (typeof dataBase64 !== 'string' || dataBase64.length > 10000000) {
      res.status(413).json({ ok: false, error: 'File too large — please keep uploads under ~7 MB.' });
      return;
    }

    const fileBlock = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataBase64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataBase64 } };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OCR_MODEL || 'claude-sonnet-4-5',
        max_tokens: 512,
        messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: PROMPT }] }],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('OCR provider error (' + r.status + ')');
      res.status(r.status).json({ ok: false, error: msg });
      return;
    }

    const text = ((data.content || []).find(b => b.type === 'text') || {}).text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(502).json({ ok: false, error: 'Could not read dates from the document' });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch (e) {
      res.status(502).json({ ok: false, error: 'Document reader returned invalid JSON' });
      return;
    }

    res.status(200).json({
      ok: true,
      issueDate: parsed.issueDate || null,
      expiryDate: parsed.expiryDate || null,
      docType: parsed.docType || null,
      registrationDate: parsed.registrationDate || null,
      taxPeriodEnd: parsed.taxPeriodEnd || null,
      taxPeriod: parsed.taxPeriod || null,
      financialYearEnd: parsed.financialYearEnd || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
