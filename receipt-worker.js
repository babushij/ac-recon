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
1. Output ONLY a JSON object with two keys. No prose. No markdown fences. No explanation.
2. Shape: {"items": [{"description": "string", "eachCost": number, "quantity": number, "partNumber": "string"}], "tax": number}
3. For each line item:
   - eachCost: the PER-UNIT price BEFORE tax (if receipt shows "each" and "qty", use each; if receipt only shows a line total, compute each = line_total / quantity)
   - quantity: the quantity for that line (default 1 if not shown)
   - partNumber: include ONLY if clearly shown on that line, otherwise ""
   - description: exactly as written on the receipt, trimmed of clutter (leading stars, SKU codes in parens, duplicate spaces)
4. tax: total sales tax amount on the receipt (sum of all tax lines). Use 0 if no tax shown.
5. EXCLUDE from items[] everything that is NOT a physical part being purchased:
   - Sales tax (capture in the separate tax field instead)
   - Shipping, delivery, handling, freight fees
   - Labor charges, shop fees, diagnostic fees, disposal fees, hazmat fees
   - Core deposits, core charges, core refunds (CORE / CORE CHG / CORE DEP / CORE FEE) - these are a deposit on the OLD part, not a new purchase
   - Warranty fees, insurance, extended service plans, protection plans
   - Subtotals, totals, balance due, payments, change, tips
   - Restock fees, enviro fees, shop supplies
   - Customer info, vendor info, addresses, phone numbers, dates
6. If the document shows no identifiable parts, return {"items": [], "tax": 0}.

IMPORTANT for PDFs: Process ONLY the first page. Even if multi-page, extract only from page 1.

Example — receipt with 2 parts (qty 1 each), shipping, tax:
  BRAKE PAD SET FRONT  qty 1  $89.99
  BRAKE ROTOR FRONT    qty 2  $64.50 each (line total $129.00)
  Shipping:            $5.00
  Tax:                 $14.85
Output:
{"items":[{"description":"BRAKE PAD SET FRONT","eachCost":89.99,"quantity":1,"partNumber":"D1234"},{"description":"BRAKE ROTOR FRONT","eachCost":64.50,"quantity":2,"partNumber":"BR9012"}],"tax":14.85}

Example — non-parts document: {"items": [], "tax": 0}`;

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
              ? 'Extract auto parts from page 1 of this PDF invoice. Return ONLY a JSON object with {"items": [...], "tax": number}.'
              : 'Extract auto parts from this receipt image. Return ONLY a JSON object with {"items": [...], "tax": number}.'
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
    return json({ items: '[]', tax: 0, documentType: docType, debug_raw: rawText.slice(0, 300) });
  }

  // New shape: {items: [...], tax: N}. Fall back to legacy if Claude returned bare array.
  let itemsRaw, tax;
  if (Array.isArray(parsed)) {
    // Legacy response — Claude gave a bare array
    itemsRaw = parsed;
    tax = 0;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
    itemsRaw = parsed.items;
    tax = typeof parsed.tax === 'number' ? parsed.tax : parseFloat(parsed.tax) || 0;
  } else {
    return json({ items: '[]', tax: 0, documentType: docType, debug_raw: 'Unexpected shape' });
  }

  const items = itemsRaw
    .filter(item => item && typeof item === 'object' && item.description)
    .map(item => {
      // Support both new shape (eachCost+quantity) and legacy (cost only)
      const qty = typeof item.quantity === 'number' ? item.quantity : parseInt(item.quantity) || 1;
      const eachCost = typeof item.eachCost === 'number'
        ? item.eachCost
        : parseFloat(item.eachCost) ||
          (typeof item.cost === 'number' ? item.cost : parseFloat(item.cost) || 0);
      return {
        description: String(item.description || '').trim(),
        eachCost,
        quantity: qty > 0 ? qty : 1,
        partNumber: String(item.partNumber || item.part_number || '').trim()
      };
    })
    .filter(item => item.description.length > 0);

  return json({
    items: JSON.stringify(items),
    tax: tax || 0,
    documentType: docType
  });
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
