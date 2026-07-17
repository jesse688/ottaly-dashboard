import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Assign a unibox reply to an EXISTING lead (by email) in the same workspace.
//
// Why: a colleague often replies on a thread from a DIFFERENT address than the
// original lead (e.g. Lee Fletcher replies to Bubble's outreach to Rebecca
// Gardiner — same company, different person). The reply gets ingested under
// the colleague's email, so it threads under nobody: it shows in the Master
// Unibox but NOT on the client dashboard (which keys threads on lead_email).
//
// This re-keys the reply (and its seeded portal_emails rows) onto the target
// lead's email so it threads under that lead on the client dashboard, and files
// it in Lead Replies.
//
// GET  → list candidate leads in this reply's workspace (for the picker).
// POST → { targetEmail } re-key the reply + thread onto that lead.

interface ReplyRow {
  id: string
  workspace_id: string | null
  lead_email: string | null
  matched_lead_email: string | null
  subject: string | null
  body_preview: string | null
  received_at: string | null
  reply_html: string | null
  reply_text: string | null
}

async function loadReply(id: string): Promise<ReplyRow | null> {
  const r = await pool.query(
    `SELECT id, workspace_id, lead_email, matched_lead_email, subject, body_preview, received_at,
            COALESCE(NULLIF(raw->'body'->>'html',''), NULLIF(raw->>'html_body','')) AS reply_html,
            COALESCE(NULLIF(raw->'body'->>'text',''), NULLIF(raw->>'text_body','')) AS reply_text
       FROM unibox_replies WHERE id = $1`,
    [id]
  )
  return (r.rows[0] as ReplyRow) ?? null
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const secretOk = !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!secretOk && !await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params

  // One-shot fix path: GET ?secret=...&targetEmail=foo@bar.com does the assign
  // directly (browser-addressable, no UI needed). Without targetEmail it just
  // lists candidate leads for the picker.
  const directTarget = url.searchParams.get('targetEmail')
  if (secretOk && directTarget) {
    return assign(id, directTarget)
  }

  const reply = await loadReply(id)
  if (!reply) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
  if (!reply.workspace_id) return NextResponse.json({ error: 'Reply has no workspace', leads: [] }, { status: 409 })

  // Candidate leads in this workspace. Surface same-domain leads first (the
  // common "colleague replied" case), then the rest, newest first.
  //
  // Optional ?q= filters server-side across email/name/company (ILIKE) so the
  // operator can TYPE to find a lead instead of hunting a capped top-N list —
  // the previous fixed top-50 silently hid any lead past position 50 (e.g. a
  // valid lead in a large workspace whose domain differs from the sender's).
  //
  // We search BOTH esp_leads AND contacts: many campaign recipients live only in
  // the master `contacts` DB and were never synced into esp_leads (e.g. Laura
  // Holmes — emailed via a campaign but absent from esp_leads), so an
  // esp_leads-only picker can't surface them. contacts is scoped by the same
  // workspace_id. Results are unioned and de-duped by email (esp_leads wins).
  const domain = (reply.lead_email ?? '').split('@')[1]?.toLowerCase() ?? ''
  const q = (url.searchParams.get('q') ?? '').trim()
  const like = q ? `%${q.replace(/[\\%_]/g, m => '\\' + m)}%` : null
  // Escape LIKE metacharacters so a typed % or _ is matched literally.
  const espFilter = q
    ? ` AND (email ILIKE $3 OR first_name ILIKE $3 OR last_name ILIKE $3 OR company_name ILIKE $3
             OR (coalesce(first_name,'') || ' ' || coalesce(last_name,'')) ILIKE $3)`
    : ''
  const queryParams: (string | null)[] = like
    ? [reply.workspace_id, domain, like]
    : [reply.workspace_id, domain]

  const [espRes, contactRes] = await Promise.all([
    pool.query(
      `SELECT id, email, first_name, last_name, company_name, label
         FROM esp_leads
        WHERE workspace_id = $1 AND email IS NOT NULL AND email <> ''${espFilter}
        ORDER BY (split_part(lower(email),'@',2) = $2) DESC, updated_at DESC NULLS LAST
        LIMIT 50`,
      queryParams
    ),
    pool.query(
      `SELECT id::text AS id, email, first_name, last_name, company_name, NULL::text AS label
         FROM contacts
        WHERE workspace_id = $1 AND email IS NOT NULL AND email <> ''${espFilter}
        ORDER BY (split_part(lower(email),'@',2) = $2) DESC, last_engaged_at DESC NULLS LAST
        LIMIT 50`,
      queryParams
    ),
  ])
  type Lead = { id: string; email: string; first_name?: string; last_name?: string; company_name?: string }
  // De-dupe by lowercased email; esp_leads rows take precedence over contacts.
  const byEmail = new Map<string, Lead>()
  for (const r of contactRes.rows as Lead[]) byEmail.set(r.email.toLowerCase(), r)
  for (const r of espRes.rows as Lead[]) byEmail.set(r.email.toLowerCase(), r)
  // Same-domain first, then keep insertion (recency) order within each group.
  const all = [...byEmail.values()]
  const leads = all
    .sort((a, b) => {
      const ad = (a.email.split('@')[1] ?? '').toLowerCase() === domain ? 0 : 1
      const bd = (b.email.split('@')[1] ?? '').toLowerCase() === domain ? 0 : 1
      return ad - bd
    })
    .slice(0, 50)

  // RECOMMENDATION: the lead we matched at ingest (matched_lead_email, set by the
  // same-company domain match) — else the top same-domain candidate. The operator
  // just reviews + accepts instead of hunting the list.
  let suggested: string | null = null
  let suggestedReason = ''
  const matched = (reply.matched_lead_email ?? '').toLowerCase()
  if (matched && leads.some(l => l.email.toLowerCase() === matched)) {
    suggested = matched
    suggestedReason = `same company as ${reply.lead_email} (matched on ingest)`
  } else if (domain) {
    const dm = leads.find(l => (l.email.split('@')[1] ?? '').toLowerCase() === domain && l.email.toLowerCase() !== (reply.lead_email ?? '').toLowerCase())
    if (dm) { suggested = dm.email; suggestedReason = `same company domain (${domain})` }
  }

  return NextResponse.json({ ok: true, currentEmail: reply.lead_email, sameDomain: domain, suggested, suggestedReason, leads })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { targetEmail?: string }
  return assign(id, body.targetEmail ?? '')
}

// Shared assign logic — used by POST (UI) and GET?secret=&targetEmail= (one-shot).
async function assign(id: string, rawTarget: string) {
  const targetEmail = (rawTarget ?? '').trim().toLowerCase()
  if (!targetEmail || !targetEmail.includes('@')) {
    return NextResponse.json({ error: 'targetEmail is required' }, { status: 400 })
  }

  const reply = await loadReply(id)
  if (!reply) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
  const ws = reply.workspace_id
  if (!ws) return NextResponse.json({ error: 'Reply has no workspace' }, { status: 409 })

  // Confirm the target exists in this workspace (don't silently invent one).
  // Accept a match in EITHER esp_leads OR the master contacts DB — many campaign
  // recipients live only in contacts and were never synced to esp_leads, so an
  // esp_leads-only check would 404 a perfectly valid lead the picker just showed.
  const lead = await pool.query(
    `SELECT email FROM esp_leads WHERE workspace_id = $1 AND lower(email) = lower($2)
     UNION ALL
     SELECT email FROM contacts   WHERE workspace_id = $1 AND lower(email) = lower($2)
     LIMIT 1`,
    [ws, targetEmail]
  )
  if (!lead.rows.length) {
    return NextResponse.json({ error: `No lead or contact with email ${targetEmail} in this workspace` }, { status: 404 })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. Re-key the reply onto the target lead + move it into REVIEW so it
    //    re-enters normal triage (the operator then Marks-as-lead / categorises
    //    it). Assigning only fixes WHO the reply belongs to; it is not itself a
    //    lead decision, so it should not skip straight to Lead Replies. Clearing
    //    classify_state to 'done' would hide it from Review, so leave it actionable.
    await client.query(
      `UPDATE unibox_replies
          SET lead_email = $2, folder = 'review', classify_state = 'done', updated_at = NOW()
        WHERE id = $1`,
      [id, targetEmail]
    )

    // 2. Seed the client thread UNDER THE TARGET so it threads with that lead.
    //    Keyed on a stable synthetic id; idempotent. The thread route reads
    //    portal_emails WHERE lower(lead_email)=lower(<lead.email>).
    const msgId = `assign_${id}`
    await client.query(
      `INSERT INTO portal_emails
         (id, workspace_id, lead_email, direction, subject,
          body_html, body_text, content_preview, from_email, is_unread, timestamp_created, raw)
       VALUES ($1,$2,$3,'IN',$4,$5,$6,$7,$8,1,$9,'{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         lead_email      = EXCLUDED.lead_email,
         body_html       = COALESCE(EXCLUDED.body_html, portal_emails.body_html),
         body_text       = COALESCE(EXCLUDED.body_text, portal_emails.body_text),
         content_preview = COALESCE(EXCLUDED.content_preview, portal_emails.content_preview),
         subject         = COALESCE(portal_emails.subject, EXCLUDED.subject)`,
      [
        msgId, ws, targetEmail, reply.subject,
        reply.reply_html, reply.reply_text ?? reply.body_preview,
        (reply.reply_text ?? reply.body_preview)?.slice(0, 200) ?? null,
        // from_email = the ACTUAL author (the colleague), so the thread shows who
        // really wrote it even though it's filed under the target lead.
        reply.lead_email ?? targetEmail,
        reply.received_at ?? new Date().toISOString(),
      ]
    )

    // 3. Move any portal_emails rows already seeded under the colleague's address
    //    onto the target lead too (so the whole sub-thread threads correctly).
    if (reply.lead_email && reply.lead_email.toLowerCase() !== targetEmail) {
      await client.query(
        `UPDATE portal_emails SET lead_email = $3
          WHERE workspace_id = $1 AND lower(lead_email) = lower($2)`,
        [ws, reply.lead_email, targetEmail]
      )
    }

    // 4. If the target lives ONLY in contacts (no esp_leads row yet), seed one
    //    from the contact so the lead panel + client dashboard show full data
    //    (name/company/title/website/phone/LinkedIn) instead of a bare email.
    //    Same id/source/raw shape as the "Edit lead details" endpoint, so the
    //    dashboard reads it identically. COALESCE-on-conflict never clobbers an
    //    existing richer row.
    const espExists = await client.query(
      `SELECT 1 FROM esp_leads WHERE workspace_id = $1 AND lower(email) = lower($2) LIMIT 1`,
      [ws, targetEmail]
    )
    if (!espExists.rows.length) {
      const c = await client.query(
        `SELECT first_name, last_name, company_name, company_domain,
                job_title, phone, linkedin_url, company_linkedin_url,
                industry, city, state, country, company_address
           FROM contacts
          WHERE workspace_id = $1 AND lower(email) = lower($2)
          ORDER BY last_engaged_at DESC NULLS LAST LIMIT 1`,
        [ws, targetEmail]
      )
      if (c.rows.length) {
        const ct = c.rows[0] as {
          first_name?: string; last_name?: string; company_name?: string
          company_domain?: string; job_title?: string
          phone?: string; linkedin_url?: string; company_linkedin_url?: string
          industry?: string; city?: string; state?: string; country?: string
          company_address?: string
        }
        // Keys match exactly what the unibox list route reads out of esp_leads.raw
        // (job_title/industry/address/city/state/country/company_website/…), so the
        // lead panel's Title/Industry/Location/Company rows all populate.
        const raw = {
          job_title: ct.job_title ?? null,
          company_website: ct.company_domain ? `https://${ct.company_domain}` : null,
          phone_number: ct.phone ?? null,
          linkedin_person_url: ct.linkedin_url ?? null,
          linkedin_company_url: ct.company_linkedin_url ?? null,
          industry: ct.industry ?? null,
          address: ct.company_address ?? null,
          city: ct.city ?? null,
          state: ct.state ?? null,
          country: ct.country ?? null,
        }
        await client.query(
          `INSERT INTO esp_leads
             (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name,
              status, label, raw, created_at, updated_at)
           VALUES ($1,$2,NULL,'bison',$3,$4,$5,$6,NULL,NULL,$7::jsonb,NOW(),NOW())
           ON CONFLICT (id, source) DO UPDATE SET
             first_name   = COALESCE(esp_leads.first_name, EXCLUDED.first_name),
             last_name    = COALESCE(esp_leads.last_name, EXCLUDED.last_name),
             company_name = COALESCE(esp_leads.company_name, EXCLUDED.company_name),
             raw          = EXCLUDED.raw || COALESCE(esp_leads.raw, '{}'::jsonb),
             updated_at   = NOW()`,
          [`assign_${id}`, ws, targetEmail,
           ct.first_name ?? null, ct.last_name ?? null, ct.company_name ?? null,
           JSON.stringify(raw)]
        )
      }
    }

    await client.query('COMMIT')
    return NextResponse.json({ ok: true, assignedTo: targetEmail })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[unibox/assign-to-lead]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    client.release()
  }
}
