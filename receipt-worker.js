// AC Recon — Receipt AI Worker
// ─────────────────────────────
// Extracts auto parts from receipt images using Anthropic Claude.
//
// Deploy:
//   1. In Cloudflare dashboard → Workers & Pages → "Create Worker"
//   2. Name it: ac-recon-receipt (or anything you like)
//   3. Paste this entire file into the editor
//   4. Click "Save and Deploy"
//   5. Go to the Worker → Settings → Variables → Add secret:
//        Name: ANTHROPIC_API_KEY
//        Value: <your Anthropic API key from console.anthropic.com>
//   6. Copy the Worker URL (e.g. https://ac-recon-receipt.your-subdomain.workers.dev)
//   7. Give that URL to Claude (the app assistant) and it'll update the app.
//
// Cost:
//   Cloudflare Workers: free up to 100,000 requests/day
//   Anthropic Claude Haiku: ~$0.003 per receipt (very cheap)
//
// Endpoints:
//   POST /receipt  { imageData: <base64>, mediaType: <mime> }
//     → { items: "<JSON array string>" }
//
//   GET /health
//     → { ok: true }

const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap + vision-capable

const SYSTEM_PROMPT = `You are an auto parts receipt extractor. Your ONLY job: find real physical auto parts that were purchased.

CRITICAL RULES:
1. Output ONLY a JSON array. No prose. No markdown fences. No explanation.
2. Shape: [{"description": "string", "cost": number, "partNumber": "string"}]
3. EXCLUDE everything that is not a physical part being purchased, including:
   - Sales tax, county tax, state tax, local tax
   - Shipping, delivery, handling, freight fees
   - Labor charges, shop fees, diagnostic fees, disposal fees
   - Core deposits, core charges, core refunds (even if listed as a line item)
   - Warranty fees, insurance, extended service plans
   - Rounding adjustments, discounts (show the discounted final line only)
   - Subtotals, totals, balance due, payments, change
   - Customer info, addresses, phone numbers
4. For each part, use the cost BEFORE tax. If only "each" and "qty" are shown, compute description-level cost = each × qty.
5. Use the description exactly as written on the receipt, but trimmed of receipt clutter (stars, trailing codes).
6. partNumber: only include if the receipt clearly shows one. If no part number, use empty string "".
7. If the image shows no identifiable parts (blurry, not a receipt, unreadable), return exactly [].

COMMON PITFALLS — do NOT fall for these:
- "CORE" or "CORE CHG" or "CORE DEP" → EXCLUDE (this is a deposit on the old part, not a new purchase)
- "RESTOCK FEE" → EXCLUDE
- "ENVIRO FEE" or "SHOP SUPPLIES" → EXCLUDE
- If a line says "-" or has a negative cost, it's likely a refund/discount; skip it unless it represents an actual purchase
- Don't invent items you can't clearly see
- Don't merge multiple line items into one

Example valid output for a receipt with 2 parts + tax + core:
[{"description":"BRAKE PAD SET FRONT","cost":89.99,"partNumber":"D1234"},{"description":"BRAKE ROTOR FRONT","cost":64.50,"partNumber":"BR9012"}]

Example valid output for a non-part image:
[]`;

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return json({ ok: true, model: MODEL });
    }

    // Main endpoint
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

  const { imageData, mediaType } = body;
  if (!imageData) {
    return json({ error: 'Missing imageData' }, 400);
  }

  // Normalize mediaType — Anthropic needs specific values
  let mt = (mediaType || 'image/jpeg').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mt)) {
    mt = 'image/jpeg';
  }

  // Build Anthropic request
  const anthropicReq = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mt,
              data: imageData
            }
          },
          {
            type: 'text',
            text: 'Extract the auto parts from this receipt. Return ONLY the JSON array.'
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

  // Extract the text content from Claude's response
  const textBlocks = (anthropicData.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text);
  const rawText = textBlocks.join('\n').trim();

  // Strip markdown fences if Claude wrapped anything
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Validate it's parseable JSON + an array
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Claude returned non-JSON:', rawText.slice(0, 500));
    // Return empty array so the app doesn't crash, but include the raw for debugging
    return json({ items: '[]', debug_raw: rawText.slice(0, 300) });
  }

  if (!Array.isArray(parsed)) {
    return json({ items: '[]', debug_raw: 'Not an array' });
  }

  // Normalize each item — defensive
  const items = parsed
    .filter(item => item && typeof item === 'object' && item.description)
    .map(item => ({
      description: String(item.description || '').trim(),
      cost: typeof item.cost === 'number' ? item.cost : parseFloat(item.cost) || 0,
      partNumber: String(item.partNumber || item.part_number || '').trim()
    }))
    .filter(item => item.description.length > 0);

  // Return items as a JSON-encoded STRING to match the existing app contract
  return json({ items: JSON.stringify(items) });
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
