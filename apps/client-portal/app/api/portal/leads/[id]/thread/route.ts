import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLockedLeadIds } from '@/lib/balance'
import { extractSignatureFields, ALL_SIGNATURE_FIELDS, isJunkCompanyName, type SignatureField } from '@/lib/signature'
import { sanitizeEmailHtml } from '@/lib/sanitize-html'

// Pull contact details out of the lead's latest inbound email and OVERRIDE the
// stored values in esp_leads.raw (their own email is the freshest source). Which
// fields are scanned is the global 'signature_extract_fields' setting. Best-effort.
async function applySignatureExtraction(leadId: string, workspaceId: string, rows: Array<Record<string, unknown>>, leadEmail: string) {
  try {
    // Nothing to extract from unless there's at least one inbound message with a
    // body — skip the settings SELECT and all UPDATEs in that (common) case.
    const hasInboundBody = rows.some(r => r.direction === 'IN' && (r.body_html || r.body_text))
    if (!hasInboundBody) return
    const cfg = await pool.query(`SELECT value FROM portal_settings WHERE key = 'signature_extract_fields'`)
    const raw = cfg.rows[0]?.value
    // Default to all fields when unset; empty string = feature disabled.
    const fields: SignatureField[] = raw === undefined
      ? ALL_SIGNATURE_FIELDS
      : String(raw).split(',').map(s => s.trim()).filter(Boolean) as SignatureField[]
    if (!fields.length) return
    // company_name was added to the extractor AFTER this setting was first saved, so a
    // pre-existing setting string lists only the original 5 fields and would never
    // extract company_name (→ the panel keeps the wrong agency name). Always include it.
    if (!fields.includes('company_name')) fields.push('company_name')

    const inbound = rows.filter(r => r.direction === 'IN')
    const latest = inbound[inbound.length - 1]
    if (!latest) return
    const body = String(latest.body_html || latest.body_text || '')
    const found = extractSignatureFields(body, fields, leadEmail)
    if (!Object.keys(found).length) return

    // company_name is a TOP-LEVEL esp_leads column (the others live in raw). Split it
    // out and write it to the column — overriding the stored value, which is often the
    // AGENCY's name from import rather than the lead's real company. The rest merge
    // into raw (right-wins, so fresh signature values override stale ones).
    const { company_name, ...rawFields } = found as Record<string, string>
    if (Object.keys(rawFields).length) {
      await pool.query(
        `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(rawFields), leadId, workspaceId]
      )
    }
    if (company_name) {
      // Only overwrite when the stored name is junk, or the extracted one is a
      // high-confidence "<Name> Ltd/…". Never downgrade a good name (e.g.
      // "Cheese Riot" → domain-squash "Cheeseriot") every time the thread opens.
      const cur = await pool.query(
        `SELECT company_name FROM esp_leads WHERE id = $1 AND workspace_id = $2`,
        [leadId, workspaceId]
      ).catch(() => ({ rows: [] as { company_name: string | null }[] }))
      const stored = cur.rows[0]?.company_name ?? null
      const hasSuffix = /\b(?:Ltd\.?|Limited|LLC|Inc\.?|PLC|GmbH|Pty|Corp\.?|Corporation|Holdings)\b/i.test(company_name)
      if (isJunkCompanyName(stored) || hasSuffix) {
        await pool.query(
          `UPDATE esp_leads SET company_name = $1, updated_at = NOW()
            WHERE id = $2 AND workspace_id = $3`,
          [company_name, leadId, workspaceId]
        )
      }
    }
  } catch (err) {
    console.error('[thread] signature extraction failed:', err)
  }
}

// GET — the real email conversation for a lead, newest-last.
// Reads cached portal_emails first; if empty, pulls live from PlusVibe and caches.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const leadRes = await pool.query(
    'SELECT id, email FROM esp_leads WHERE id = $1 AND workspace_id = $2',
    [id, session.workspaceId]
  )
  if (!leadRes.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Locked lead (delivered while out of credit) — the conversation stays hidden
  // until the client tops up. Never return its emails.
  const lockedIds = await getLockedLeadIds(session.clientId)
  if (lockedIds.has(id)) return NextResponse.json({ locked: true, messages: [] }, { status: 403 })

  const leadEmail: string = leadRes.rows[0].email

  async function readCache() {
    const r = await pool.query(
      `SELECT id, direction, subject, body_html, body_text, content_preview,
              from_email, to_email, eaccount, pv_label, message_id, sent_via_portal,
              timestamp_created, raw->'attachments' AS attachments,
              -- CC recipients. PlusVibe exposes cc under DIFFERENT keys depending on
              -- which endpoint fed the row into raw:
              --   * /unibox/emails LIST feed (what the reconcile cron ingests):
              --       cc_address_email_list  (string, e.g. "Jada-Rae <j@x.com>")
              --       cc_address_json        (array of {name,address})  <- cleanest
              --   * /unibox/emails thread-DETAIL feed: cc  (array of formatted strings)
              --   * our own OUTBOUND portal replies: cc  (plain string)
              -- Try them in order of cleanliness; the first non-empty wins.
              COALESCE(
                -- structured list-endpoint form: join "Name <addr>" (or bare addr)
                NULLIF((SELECT string_agg(
                          CASE WHEN COALESCE(x->>'name','') <> ''
                               THEN (x->>'name') || ' <' || (x->>'address') || '>'
                               ELSE x->>'address' END, ', ')
                        FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(raw->'cc_address_json') = 'array'
                               THEN raw->'cc_address_json' ELSE '[]'::jsonb END) AS x), ''),
                -- string list-endpoint form
                NULLIF(raw->>'cc_address_email_list',''),
                -- thread-detail array form
                NULLIF((SELECT string_agg(v, ', ') FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(raw->'cc') = 'array' THEN raw->'cc' ELSE '[]'::jsonb END) AS v), ''),
                -- outbound plain-string form (skip if cc is actually an array)
                CASE WHEN jsonb_typeof(raw->'cc') = 'array' THEN NULL ELSE NULLIF(raw->>'cc','') END
              ) AS cc
         FROM portal_emails
        WHERE workspace_id = $1 AND lower(lead_email) = lower($2)
        ORDER BY timestamp_created ASC NULLS FIRST`,
      [session!.workspaceId, leadEmail]
    )
    // Dedup the SAME message stored twice: mark-as-lead seeds a row id
    // `unibox_<replyId>` while the live Bison sync stores it as `<replyId>` — same
    // message, different id. Collapse on a content key (direction + minute-rounded
    // timestamp + a normalized text prefix), keeping the richer (HTML) row.
    const contentKey = (row: typeof r.rows[number]) => {
      const t = String(row.body_text || row.content_preview || row.body_html || '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
      const ts = row.timestamp_created ? new Date(row.timestamp_created).toISOString().slice(0, 16) : ''
      return `${row.direction}|${ts}|${t}`
    }
    const byContent = new Map<string, typeof r.rows[number]>()
    for (const row of r.rows) {
      const key = contentKey(row)
      const existing = byContent.get(key)
      if (!existing) { byContent.set(key, row); continue }
      // Two stored rows for the SAME message (e.g. an old ingest without cc + a
      // healed backfill row with cc). Keep the richer HTML body, but never let the
      // collapse DROP a field the loser has and the winner lacks — merge cc (and
      // attachments) across so a healed cc still surfaces even if the other row
      // owns the body_html we keep.
      const winner = (!existing.body_html && row.body_html) ? row : existing
      const loser = winner === existing ? row : existing
      winner.cc = winner.cc || loser.cc
      winner.attachments = winner.attachments || loser.attachments
      byContent.set(key, winner)
    }
    return Array.from(byContent.values()).sort((a, b) => {
      const ta = a.timestamp_created ? new Date(a.timestamp_created).getTime() : 0
      const tb = b.timestamp_created ? new Date(b.timestamp_created).getTime() : 0
      return ta - tb
    })
  }

  // The thread is served entirely from portal_emails (seeded by the PlusVibe
  // reconcile cron + portal replies). The old "fetch live from Bison when empty"
  // fallback is gone — Bison is retired.
  const rows = await readCache()

  // Side effects of opening a thread — marking read, refreshing the contact
  // signature, stamping "responded". NONE of these change the JSON we return, so
  // they must NOT block the response: previously each open awaited a SELECT + up
  // to two esp_leads UPDATEs (signature) + an upsert, so every click paid that
  // round-trip latency. We fire them after the response is built and let them run
  // in the background. Each already swallows its own errors.
  const runOpenSideEffects = async () => {
    // Mark inbound as read now the client has opened the thread.
    await pool.query(
      `UPDATE portal_emails SET is_unread = 0
        WHERE workspace_id = $1 AND lower(lead_email) = lower($2) AND is_unread = 1`,
      [session!.workspaceId, leadEmail]
    ).catch(() => {})

    // Refresh contact details from the latest inbound email signature (skips fast
    // internally when there's no inbound body to read).
    await applySignatureExtraction(id, session!.workspaceId, rows, leadEmail)

    // Auto-mark "responded" if the synced thread shows an OUTBOUND message after
    // the prospect's first inbound (i.e. someone — client or agency — replied,
    // whether in our portal OR in Bison). This moves the lead off "Needs reply"
    // without the client clicking anything. Stamp first_responded_at once.
    try {
      const firstInbound = rows.find(r => r.direction === 'IN')?.timestamp_created
      const respondedOut = rows.some(r =>
        r.direction === 'OUT' &&
        (r.sent_via_portal ||
          (firstInbound && r.timestamp_created && new Date(r.timestamp_created) > new Date(firstInbound)))
      )
      if (respondedOut) {
        await pool.query(
          `INSERT INTO portal_lead_data (lead_id, client_id, first_responded_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (lead_id, client_id) DO UPDATE
             SET first_responded_at = COALESCE(portal_lead_data.first_responded_at, NOW())`,
          [id, session!.clientId]
        )
      }
    } catch (err) {
      console.error('[thread] responded-stamp failed:', err)
    }
  }
  // Kick it off but don't await — the thread renders from `rows` regardless.
  void runOpenSideEffects()

  // Sanitize body_html for rendering. Messages WE composed in the portal are
  // already trusted; INBOUND mail is untrusted, so scrub it (strip scripts, neutralise
  // remote tracking images — the client can opt to load them). The full signature
  // (logos/photos/contact table) survives sanitization.
  const safeRows = rows.map(r => ({
    ...r,
    body_html_safe: r.body_html
      ? (r.sent_via_portal
          ? sanitizeEmailHtml(String(r.body_html), { blockRemoteImages: false })
          : sanitizeEmailHtml(String(r.body_html)))
      : null,
  }))

  return NextResponse.json(safeRows)
}
