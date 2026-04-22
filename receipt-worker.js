// AC Recon — Receipt AI Worker (v2)
// ───────────────────────────────────
// Extracts auto parts from receipt images OR PDFs using Anthropic Claude.
//
// What's new in v2:
//   - Accepts PDFs directly (first page only, to save cost)
//   - Handles image AND pdf mediaType
//   - Better prompt tuned for vendor invoices & parts receipts
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → your receipt worker → Edit code
//   2. Replace all code with this file
//   3. Save and deploy
//   4. Make sure ANTHROPIC_API_KEY secret is still set (Settings → Variables)
//
// Endpoints:
//   POST /receipt
//     Body: { documentData: <base64>, mediaType: "image/jpeg"|"image/png"|"image/webp"|"image/gif"|"application/pdf" }
//     Or (legacy): { imageData: <base64>, mediaType: "image/..." }
//     Response: { items: "<JSON array string>", documentType: "image"|"pdf" }
//
//   GET /health → { ok: true, model: "..." }

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are an auto parts receipt/invoice extractor. Your ONLY job: find real physical auto parts that were purchased.

CRITICAL RULES:
1. Output ONLY a JSON array. No prose. No markdown fences. No explanation.
2. Shape: [{"description": "string", "cost": number, "partNumber": "string"}]
3. EXCLUDE everything that is NOT a physical part being purchased, including:
   - Sales tax, county tax, state tax, local tax, VAT, GST
   - Shipping, delivery, handling, freight fees
   - Labor charges, shop fees, diagnostic fees, disposal fees, hazmat fees
   - Core deposits, core charges, core refunds (CORE / CORE CHG / CORE DEP / CORE FEE) - these are a deposit on the OLD part, not a new purchase
   - Warranty fees, insurance, extended service plans, protection plans
   - Rounding adjustments, discounts, coupons, promos (show only the discounted line, not the discount)
   - Subtotals, totals, balance due, payments, change, tips
   - Restock fees, enviro fees, shop supplies
   - Customer info, vendor info, addresses, phone numbers, dates
4. For each part, use the cost BEFORE tax. If "each" and "qty" are shown, use each × qty.
5. Use the description exactly as written on the receipt, but trim receipt clutter (leading stars *, trailing SKU codes in parens, duplicate spaces).
6. partNumber: include ONLY if the receipt clearly shows one on that line. Otherwise empty string "".
7. If the document shows no identifiable parts (blurry, not a receipt, unreadable), return exactly [].

IMPORTANT for PDFs: Process ONLY the first page. Even if multi-page, extract only from page 1.

Example valid output for a receipt with 2 parts + tax + core:
[{"description":"BRAKE PAD SET FRONT","cost":89.99,"partNumber":"D1234"},{"description":"BRAKE ROTOR FRONT","cost":64.50,"partNumber":"BR9012"}]

Example valid output for a non-parts document:
[]`;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return json({ ok: true, model: MODEL, version: 'v2' });
    }

    if (url.pathname === '/receipt' && request.method === 'POST') {
      return handleReceipt(request, env);
    }

    return json({ error: 'Not found' }, 404);
  }
};

async function handleReceipt(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Worker missing ANTHROPIC_API_KEY secret' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Accept either new-style {documentData, mediaType} or legacy {imageData, mediaType}
  const docData = body.documentData || body.imageData;
  let mediaType = (body.mediaType || '').toLowerCase();

  if (!docData) {
    return json({ error: 'Missing documentData (or imageData)' }, 400);
  }

  const isPdf = mediaType === 'application/pdf' || mediaType === 'pdf';
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  let contentBlock;
  let docType;
  if (isPdf) {
    contentBlock = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: docData
      }
    };
    docType = 'pdf';
  } else {
    let mt = mediaType;
    if (!imageTypes.includes(mt)) mt = 'image/jpeg';
    contentBlock = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mt,
        data: docData
      }
    };
    docType = 'image';
  }

  const anthropicReq = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          contentBlock,
          {
            type: 'text',
            text: isPdf
              ? 'Extract auto parts from page 1 of this PDF invoice. Return ONLY the JSON array.'
              : 'Extract auto parts from this receipt image. Return ONLY the JSON array.'
          }
        ]
      }
    ]
  };

  let anthropicResp;
  try {
    anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthropicReq)
    });
  } catch (e) {
    return json({ error: 'Anthropic fetch failed: ' + e.message }, 502);
  }

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    console.error('Anthropic error:', anthropicResp.status, errText);
    return json({ error: `Anthropic API ${anthropicResp.status}: ${errText.slice(0, 300)}` }, 502);
  }

  let anthropicData;
  try {
    anthropicData = await anthropicResp.json();
  } catch (e) {
    return json({ error: 'Bad JSON from Anthropic' }, 502);
  }

  const textBlocks = (anthropicData.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text);
  const rawText = textBlocks.join('\n').trim();

  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Claude returned non-JSON:', rawText.slice(0, 500));
    return json({ items: '[]', documentType: docType, debug_raw: rawText.slice(0, 300) });
  }

  if (!Array.isArray(parsed)) {
    return json({ items: '[]', documentType: docType, debug_raw: 'Not an array' });
  }

  const items = parsed
    .filter(item => item && typeof item === 'object' && item.description)
    .map(item => ({
      description: String(item.description || '').trim(),
      cost: typeof item.cost === 'number' ? item.cost : parseFloat(item.cost) || 0,
      partNumber: String(item.partNumber || item.part_number || '').trim()
    }))
    .filter(item => item.description.length > 0);

  return json({ items: JSON.stringify(items), documentType: docType });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}
