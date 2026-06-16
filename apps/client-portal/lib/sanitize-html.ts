// Minimal, dependency-free HTML sanitizer for rendering INBOUND email bodies
// (lead replies + their signatures, logos, photos) in our admin Unibox and the
// client inbox. Inbound mail is untrusted, so we must strip anything that can run
// code or exfiltrate. This is an allowlist sanitizer: anything not explicitly
// permitted is dropped.
//
// Scope note: this is intentionally conservative and tuned for email signatures —
// not a general-purpose HTML5 sanitizer. It removes <script>/<style>/<iframe>/etc.
// wholesale (tag + contents), strips event handlers and javascript:/data: URLs,
// and keeps a safe subset of formatting + images + links.

// Tags whose ENTIRE contents are removed (not just the tag).
const DROP_WITH_CONTENT = /<\s*(script|style|iframe|object|embed|noscript|template|svg|math|link|meta|title|head)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi
// Self-closing / unclosed variants of the same dangerous tags.
const DROP_VOID = /<\s*\/?\s*(script|style|iframe|object|embed|noscript|template|svg|math|link|meta|base)\b[^>]*>/gi

// Tags we allow to remain (everything else is unwrapped — content kept, tag removed).
const ALLOWED_TAGS = new Set([
  'a', 'b', 'i', 'u', 'em', 'strong', 'span', 'p', 'br', 'div', 'hr',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'font', 'small', 'sub', 'sup', 'center',
])

// Attributes allowed per tag (others stripped). 'style' is allowed but scrubbed.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel', 'style']),
  img: new Set(['src', 'alt', 'width', 'height', 'style']),
  font: new Set(['color', 'face', 'size', 'style']),
  td: new Set(['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'style']),
  th: new Set(['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'style']),
  table: new Set(['width', 'cellpadding', 'cellspacing', 'border', 'align', 'style']),
  col: new Set(['span', 'width', 'style']),
  // Default for any other allowed tag: only class + style.
}
const DEFAULT_ATTRS = new Set(['style', 'class', 'align'])

// A URL is safe only if http(s), mailto, tel, or a relative path. Blocks
// javascript:, data:, vbscript:, etc.
function safeUrl(v: string): string | null {
  const t = v.trim()
  if (/^(https?:|mailto:|tel:)/i.test(t)) return t
  if (/^(javascript|data|vbscript|file):/i.test(t)) return null
  if (/^[#/.]/.test(t) || /^[\w.-]+@/.test(t)) return t
  // Bare domain like www.einhell.co.uk → make it absolute so the link works.
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(t)) return `https://${t}`
  return null
}

// Scrub a style attribute: drop expression()/url(javascript:)/behaviors. Keep the
// common, harmless declarations email clients emit.
function safeStyle(v: string): string {
  if (/expression\s*\(|javascript:|vbscript:|@import|behavior\s*:/i.test(v)) return ''
  // Block url() pointing at non-http(s) schemes.
  if (/url\(\s*['"]?\s*(?!https?:)[^)]*:/i.test(v)) return ''
  return v.replace(/"/g, "'").slice(0, 600)
}

interface Options {
  // Images load by default so signatures (logos, social icons) render properly.
  // Set true to block remote <img> instead — src is moved to data-blocked-src so a
  // UI could offer "load images" (prevents tracking pixels). Off by default.
  blockRemoteImages?: boolean
}

// Sanitize one tag's attributes, returning a safe attribute string.
function cleanAttrs(tag: string, attrStr: string, opts: Options): string {
  const allowed = ALLOWED_ATTRS[tag] ?? DEFAULT_ATTRS
  const out: string[] = []
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(attrStr))) {
    const name = m[1].toLowerCase()
    const raw = m[3] ?? m[4] ?? m[5] ?? ''
    if (name.startsWith('on')) continue           // event handlers
    if (!allowed.has(name)) continue
    if (name === 'href' || name === 'src') {
      const u = safeUrl(raw)
      if (!u) continue
      if (name === 'src' && tag === 'img' && opts.blockRemoteImages === true && /^https?:/i.test(u)) {
        out.push(`data-blocked-src="${u.replace(/"/g, '&quot;')}"`)
        continue
      }
      out.push(`${name}="${u.replace(/"/g, '&quot;')}"`)
      continue
    }
    if (name === 'style') {
      const s = safeStyle(raw)
      if (s) out.push(`style="${s.replace(/"/g, '&quot;')}"`)
      continue
    }
    out.push(`${name}="${raw.replace(/"/g, '&quot;')}"`)
  }
  // Force safe link behaviour: external links open in a new tab without referrer.
  if (tag === 'a') out.push('target="_blank"', 'rel="noopener noreferrer nofollow"')
  return out.length ? ' ' + out.join(' ') : ''
}

export function sanitizeEmailHtml(html: string | null | undefined, opts: Options = {}): string {
  if (!html) return ''
  let s = html
  // 1) Remove dangerous tags + their contents.
  s = s.replace(DROP_WITH_CONTENT, '')
  s = s.replace(DROP_VOID, '')
  // 2) Strip HTML comments (can hide conditional/script payloads).
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // 3) Walk every remaining tag: keep allowed tags (with cleaned attrs), unwrap others.
  s = s.replace(/<\s*(\/?)\s*([a-zA-Z][\w-]*)\b([^>]*)>/g, (_full, slash: string, tagRaw: string, attrs: string) => {
    const tag = tagRaw.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''        // unwrap: drop tag, keep inner text
    if (slash) return `</${tag}>`
    const selfClose = /\/\s*$/.test(attrs) || tag === 'br' || tag === 'img' || tag === 'hr' || tag === 'col'
    return `<${tag}${cleanAttrs(tag, attrs, opts)}${selfClose ? ' /' : ''}>`
  })
  return s
}
