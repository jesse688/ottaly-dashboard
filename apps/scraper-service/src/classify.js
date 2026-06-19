// LLM classifier for the fuzzy fields (business_type, industry, keywords).
// Only invoked when at least one AI-backed field is selected. Degrades to {}
// (leaves fields blank) if ANTHROPIC_API_KEY is missing or the call fails.

const API_KEY = process.env.ANTHROPIC_API_KEY || ''
const MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export const classifierAvailable = Boolean(API_KEY)

function parseJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

/**
 * @param {{name?:string, textSample?:string, hints?:object}} subject
 * @param {string[]} wantKeys subset of ['business_type','industry','keywords']
 * @returns {Promise<{business_type?:string, industry?:string, keywords?:string[]}>}
 */
export async function classifyBusiness(subject, wantKeys) {
  if (!API_KEY || wantKeys.length === 0) return {}
  if (!subject.textSample && !subject.name) return {}

  const asks = []
  if (wantKeys.includes('business_type')) asks.push('"business_type": a 2-4 word label for what the business does (e.g. "Care home operator", "Plumbing contractor")')
  if (wantKeys.includes('industry')) asks.push('"industry": the broad industry/sector (e.g. "Healthcare", "Construction", "Hospitality")')
  if (wantKeys.includes('keywords')) asks.push('"keywords": an array of 5-10 short topical keywords describing the business and its services')

  const hintLines = []
  if (subject.hints?.sic_codes) hintLines.push(`Companies House SIC codes: ${subject.hints.sic_codes}`)
  if (subject.hints?.company_type) hintLines.push(`Company type: ${subject.hints.company_type}`)

  const prompt = [
    `Classify this UK business from the information below. Respond with ONLY a JSON object containing exactly these keys: ${wantKeys.join(', ')}.`,
    asks.map(a => `- ${a}`).join('\n'),
    `If something is unknown, use an empty string (or empty array for keywords). Do not invent specifics.`,
    '',
    subject.name ? `Business name: ${subject.name}` : '',
    hintLines.join('\n'),
    subject.textSample ? `\nWebsite content:\n${subject.textSample}` : '',
  ].filter(Boolean).join('\n')

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      console.warn(`classify: API ${res.status}`)
      return {}
    }
    const data = await res.json()
    const text = (data.content || []).map(c => c.text || '').join('')
    const parsed = parseJson(text)
    if (!parsed) return {}

    const out = {}
    if (wantKeys.includes('business_type') && typeof parsed.business_type === 'string') out.business_type = parsed.business_type.trim() || null
    if (wantKeys.includes('industry') && typeof parsed.industry === 'string') out.industry = parsed.industry.trim() || null
    if (wantKeys.includes('keywords')) {
      const kw = Array.isArray(parsed.keywords) ? parsed.keywords : []
      out.keywords = kw.map(k => String(k).trim()).filter(Boolean).slice(0, 12)
    }
    return out
  } catch (err) {
    console.warn('classify: error', err.message)
    return {}
  }
}
