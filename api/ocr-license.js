// api/ocr-license.js — reads a UAE trade licence (PDF or photo) with Claude
// and returns the fields the Add-client form needs.
//
// Upload this file to the GitHub repo as:  api/ocr-license.js
// (same folder as api/ocr.js — it reuses the same ANTHROPIC_API_KEY env var)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set' });
  }

  try {
    const { mediaType, dataBase64 } = req.body || {};
    if (!mediaType || !dataBase64) {
      return res.status(400).json({ ok: false, error: 'mediaType and dataBase64 are required' });
    }

    const block =
      mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataBase64 } };

    const prompt = [
      'This is a UAE trade licence (or commercial licence) document.',
      'Extract the following and answer with ONLY a JSON object — no markdown, no commentary:',
      '{',
      '  "legalName": "the licensee / company legal name as printed",',
      '  "licenseNumber": "the licence number",',
      '  "licensingAuthority": "the issuing authority, e.g. Dubai Economy, DMCC, DED Abu Dhabi",',
      '  "jurisdiction": "Mainland" or "Free Zone",',
      '  "legalForm": "e.g. LLC, FZ-LLC, FZE, Sole Establishment, Branch, Civil Company",',
      '  "emirate": "e.g. Dubai, Abu Dhabi, Sharjah",',
      '  "issueDate": "YYYY-MM-DD",',
      '  "expiryDate": "YYYY-MM-DD",',
      '  "activities": "the licensed business activities, comma-separated"',
      '}',
      'Use null for anything not printed on the document. Dates must be ISO YYYY-MM-DD.',
      'If this is clearly not a trade licence, answer {"notALicense": true}.',
    ].join('\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 700,
        messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: (data && data.error && data.error.message) || 'AI request failed' });
    }

    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    // tolerate a fenced or prefixed answer — take the first {...} block
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(422).json({ ok: false, error: 'Could not read the licence' });

    let lic;
    try {
      lic = JSON.parse(m[0]);
    } catch (e) {
      return res.status(422).json({ ok: false, error: 'Could not read the licence' });
    }
    if (lic.notALicense) {
      return res.status(200).json({ ok: false, error: 'This does not look like a trade licence — please check the file.' });
    }
    return res.status(200).json({ ok: true, license: lic });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'OCR failed' });
  }
}
