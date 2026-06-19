// LLM classifier for the fuzzy fields (business_type, industry, keywords).
// Only invoked when at least one AI-backed field is selected. Degrades to {}
// (leaves fields blank) if no API key is set or the call fails.
//
// Supports two providers, chosen by which key is present:
//   - GEMINI_API_KEY    → Google Gemini (matches the legacy CH pipeline)
//   - ANTHROPIC_API_KEY → Claude
// If both are set, Gemini wins (set CLASSIFY_PROVIDER=claude to force Claude).

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''
const FORCE = (process.env.CLASSIFY_PROVIDER || '').toLowerCase()

const CLAUDE_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001'
const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages'

// Gemini model fallback chain — first that responds wins.
const GEMINI_MODELS = [process.env.GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'].filter(Boolean)

// Decide the active provider once at module load.
const PROVIDER =
  FORCE === 'claude' ? (ANTHROPIC_KEY ? 'claude' : '')
  : FORCE === 'gemini' ? (GEMINI_KEY ? 'gemini' : '')
  : GEMINI_KEY ? 'gemini'
  : ANTHROPIC_KEY ? 'claude'
  : ''

export const classifierAvailable = Boolean(PROVIDER)
export const classifierProvider = PROVIDER || 'none'

function parseJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

// Normalise a raw parsed object to the requested keys.
function shape(parsed, wantKeys) {
  if (!parsed) return {}
  const out = {}
  if (wantKeys.includes('business_type') && typeof parsed.business_type === 'string') {
    out.business_type = parsed.business_type.trim() || null
  }
  if (wantKeys.includes('industry') && typeof parsed.industry === 'string') {
    out.industry = parsed.industry.trim() || null
  }
  if (wantKeys.includes('keywords')) {
    // Accept array OR comma-separated string (Gemini schema returns a string).
    let kw = parsed.keywords
    if (typeof kw === 'string') kw = kw.split(',')
    kw = Array.isArray(kw) ? kw : []
    out.keywords = kw.map(k => String(k).trim()).filter(Boolean).slice(0, 12)
  }
  return out
}

function buildPrompt(subject, wantKeys) {
  const asks = []
  if (wantKeys.includes('business_type')) asks.push('"business_type": a 2-4 word label for what the business does (e.g. "Care home operator", "Plumbing contractor")')
  if (wantKeys.includes('industry')) asks.push('"industry": the broad industry/sector (e.g. "Healthcare", "Construction", "Hospitality")')
  if (wantKeys.includes('keywords')) asks.push('"keywords": 5-10 short topical keywords describing the business and its services (comma-separated)')

  const hintLines = []
  if (subject.hints?.sic_codes) hintLines.push(`Companies House SIC codes: ${subject.hints.sic_codes}`)
  if (subject.hints?.company_type) hintLines.push(`Company type: ${subject.hints.company_type}`)

  return [
    `Classify this UK business from the information below. Respond with ONLY a JSON object containing exactly these keys: ${wantKeys.join(', ')}.`,
    asks.map(a => `- ${a}`).join('\n'),
    `If something is unknown, use an empty string. Do not invent specifics.`,
    '',
    subject.name ? `Business name: ${subject.name}` : '',
    hintLines.join('\n'),
    subject.textSample ? `\nWebsite content:\n${subject.textSample}` : '',
  ].filter(Boolean).join('\n')
}

async function classifyClaude(prompt) {
  const res = await fetch(CLAUDE_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) { console.warn(`classify(claude): API ${res.status}`); return null }
  const data = await res.json()
  return (data.content || []).map(c => c.text || '').join('')
}

async function classifyGemini(prompt, wantKeys) {
  // Build a responseSchema for just the requested keys (matches legacy CH pipeline).
  const props = {}
  if (wantKeys.includes('business_type')) props.business_type = { type: 'STRING', nullable: true }
  if (wantKeys.includes('industry')) props.industry = { type: 'STRING', nullable: true }
  if (wantKeys.includes('keywords')) props.keywords = { type: 'STRING', nullable: true }

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: props },
    },
  })

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      if (!r.ok) { if (r.status === 404) continue; console.warn(`classify(gemini): API ${r.status}`); return null }
      const j = await r.json()
      return j?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    } catch (err) {
      console.warn(`classify(gemini): ${model} ${err.message}`)
      continue
    }
  }
  return null
}

/**
 * @param {{name?:string, textSample?:string, hints?:object}} subject
 * @param {string[]} wantKeys subset of ['business_type','industry','keywords']
 * @returns {Promise<{business_type?:string, industry?:string, keywords?:string[]}>}
 */
export async function classifyBusiness(subject, wantKeys) {
  if (!PROVIDER || wantKeys.length === 0) return {}
  if (!subject.textSample && !subject.name) return {}

  const prompt = buildPrompt(subject, wantKeys)
  try {
    const text = PROVIDER === 'gemini'
      ? await classifyGemini(prompt, wantKeys)
      : await classifyClaude(prompt)
    return shape(parseJson(text), wantKeys)
  } catch (err) {
    console.warn('classify: error', err.message)
    return {}
  }
}
