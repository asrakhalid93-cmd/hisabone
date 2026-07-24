// HisabOne — invoice OCR endpoint (Vercel Serverless Function)
//
// Reads a tax invoice (image or PDF) with Claude's vision model and returns
// structured fields for the VAT calculator. Configure in Vercel:
//   Project → Settings → Environment Variables
//     ANTHROPIC_API_KEY = sk-ant-...        (required)
//     OCR_MODEL         = claude-sonnet-4-5 (optional override)

const PROMPT = `You are a precise OCR engine for UAE tax invoices. Read the attached invoice carefully and extract its details.

Return ONLY a minified JSON object (no markdown, no code fences, no commentary) with exactly these keys:
{"vendor":string|null,"customer":string|null,"invoiceNumber":string|null,"date":string|null,"trn":string|null,"currency":string|null,"netAmount":number|null,"vatAmount":number|null,"grossAmount":number|null,"vatRatePercent":number|null,"description":string|null,"category":string|null}

Rules:
- vendor = the supplier/seller issuing the invoice; customer = the buyer.
- trn = the supplier's UAE Tax Registration Number (15 digits) if shown.
- netAmount = total excluding VAT; vatAmount = total VAT; grossAmount = total including VAT. Use the invoice's grand totals, not a single line item.
- Numbers must be plain JSON numbers with no thousands separators or currency symbols.
- If VAT is shown as 5% or amounts imply ~5%, vatRatePercent = 5. If the invoice is zero-rated or shows no VAT, vatRatePercent = 0.
- If the totals are inconsistent, trust gross and VAT, and compute net = gross - VAT.
- category = the expense category this invoice most likely belongs to, judged from the vendor and line items. It MUST be exactly one of: "Goods & inventory", "Rent & office", "Utilities & telecom", "Professional services", "Marketing & advertising", "Travel & transport", "Entertainment", "Equipment & IT", "Insurance", "Bank & finance", "Other". Use "Entertainment" for hospitality/meals/events (input VAT on entertainment is generally blocked in the UAE). If unsure, use "Other".
- Use null for anything genuinely not present. Do not guess values that are not on the invoice.`;

// --- lightweight abuse protection so the API key can't be freely reused off-site ---
function allowedOrigin(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return false; // browser POSTs always send Origin; missing == not from our app
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
        max_tokens: 1024,
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
    // Robustly pull the JSON object out of the response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(502).json({ ok: false, error: 'Could not parse invoice data from the OCR response' });
      return;
    }
    let invoice;
    try { invoice = JSON.parse(match[0]); }
    catch (e) {
      res.status(502).json({ ok: false, error: 'OCR returned invalid JSON' });
      return;
    }

    res.status(200).json({ ok: true, invoice });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
