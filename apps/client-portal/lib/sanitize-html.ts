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

// A URL is safe only if http(s), mailto, tel, a base64 IMAGE data URI, or a
// relative path. Blocks javascript:, vbscript:, file:, and non-image data: URIs.
function safeUrl(v: string): string | null {
  const t = v.trim()
  if (/^(https?:|mailto:|tel:)/i.test(t)) return t
  // Allow inline base64 images (data:image/png;base64,…) — standard in email
  // signatures (e.g. an embedded logo). RASTER formats only; SVG is excluded
  // because data:image/svg+xml can embed <script> (XSS). data:text/html and
  // other data: payloads are still blocked below.
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(t)) return t
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

// Sanitize one tag's attributes. Returns the safe attribute string, or null to
// signal the whole tag should be dropped (e.g. an <img> with no usable src).
function cleanAttrs(tag: string, attrStr: string, opts: Options): string | null {
  const allowed = ALLOWED_ATTRS[tag] ?? DEFAULT_ATTRS
  const out: string[] = []
  let imgHasSrc = false
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
      if (name === 'src' && tag === 'img') imgHasSrc = true
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
  // An <img> we couldn't give a usable src (e.g. cid: inline attachment whose bytes
  // we never received) would render as a broken-image icon + alt text — drop it
  // entirely so the signature stays clean. (Unless it was deliberately blocked,
  // which keeps data-blocked-src for a future "load images" toggle.)
  if (tag === 'img' && !imgHasSrc && opts.blockRemoteImages !== true) return null
  // Force safe link behaviour: external links open in a new tab without referrer.
  if (tag === 'a') out.push('target="_blank"', 'rel="noopener noreferrer nofollow"')
  // Hide any image that DOES have a src but fails to load (dead/auth-walled URL) so
  // it doesn't leave a broken-image icon. This onerror is the ONLY inline handler we
  // allow — it's our own fixed string, never sourced from the inbound HTML.
  if (tag === 'img') out.push(`onerror="this.style.display='none'"`)
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
    const cleaned = cleanAttrs(tag, attrs, opts)
    if (cleaned === null) return ''              // tag dropped entirely (e.g. srcless img)
    const selfClose = /\/\s*$/.test(attrs) || tag === 'br' || tag === 'img' || tag === 'hr' || tag === 'col'
    return `<${tag}${cleaned}${selfClose ? ' /' : ''}>`
  })
  return s
}
