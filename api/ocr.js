// HisabOne — invoice OCR endpoint (Vercel Serverless Function)
//
// Reads a tax invoice (image or PDF) with Claude's vision model and returns
// structured fields for the VAT calculator. Configure in Vercel:
//   Project → Settings → Environment Variables
//     ANTHROPIC_API_KEY = sk-ant-...        (required)
//     OCR_MODEL         = claude-sonnet-4-5 (optional override)

const PROMPT = `You are a precise OCR engine for UAE tax invoices. Read the attached invoice carefully and extract its details.

Return ONLY a minified JSON object (no markdown, no code fences, no commentary) with exactly these keys:
{"vendor":string|null,"customer":string|null,"invoiceNumber":string|null,"date":string|null,"trn":string|null,"currency":string|null,"netAmount":number|null,"vatAmount":number|null,"grossAmount":number|null,"vatRatePercent":number|null,"description":string|null}

Rules:
- vendor = the supplier/seller issuing the invoice; customer = the buyer.
- trn = the supplier's UAE Tax Registration Number (15 digits) if shown.
- netAmount = total excluding VAT; vatAmount = total VAT; grossAmount = total including VAT. Use the invoice's grand totals, not a single line item.
- Numbers must be plain JSON numbers with no thousands separators or currency symbols.
- If VAT is shown as 5% or amounts imply ~5%, vatRatePercent = 5. If the invoice is zero-rated or shows no VAT, vatRatePercent = 0.
- If the totals are inconsistent, trust gross and VAT, and compute net = gross - VAT.
- Use null for anything genuinely not present. Do not guess values that are not on the invoice.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
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
