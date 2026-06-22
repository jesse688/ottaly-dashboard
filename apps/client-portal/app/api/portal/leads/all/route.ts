import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLockedLeadIds, reconcileLeadCharges } from '@/lib/balance'

// Fields hidden on a locked lead (delivered while out of credit) — everything
// identifying stays server-side until the client tops up. first/last name remain
// so we can show a "New lead from Ken — top up to unlock" teaser.
const LOCKED_SUPPRESS = ['email', 'company_name', 'company_website', 'phone_number',
  'job_title', 'department', 'industry', 'city', 'state', 'country', 'address_line',
  'linkedin_url', 'linkedin_company_url', 'campaign_name']

// Map a hidden_fields key -> which output fields it suppresses (server-side, so
// hidden data never reaches the browser).
const FIELD_SUPPRESS: Record<string, string[]> = {
  email: ['email'],
  phone: ['phone_number'],
  job_title: ['job_title'],
  department: ['department'],
  industry: ['industry'],
  location: ['city', 'state', 'country', 'address_line'],
  linkedin: ['linkedin_url', 'linkedin_company_url'],
  company: ['company_name', 'company_website'],
  first_name: ['first_name'],
  last_name: ['last_name'],
  deal_value: ['deal_value', 'deal_notes'],
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const cfg = await pool.query(
      'SELECT hidden_labels, hidden_fields FROM portal_clients WHERE id = $1',
      [session.clientId]
    )
    const hiddenLabels: string[] = cfg.rows[0]?.hidden_labels ?? []
    const hiddenFields: string[] = cfg.rows[0]?.hidden_fields ?? []

    const res = await pool.query(
      `SELECT l.id, l.email,
              -- ── Name resolution with a FALLBACK CHAIN ──────────────────────
              -- A lead's name may be missing on its own row, so we try, in order:
              --   1. the row's own first/last name
              --   2. a sibling row's name (SAME email — matched on email ONLY, since
              --      a PV→Bison-migrated lead keeps its old PV workspace_id)
              --   3. the LinkedIn URL slug: /in/danny-attwater-a182b1296 →
              --      "Danny Attwater" (strip the trailing random id segment, split
              --      the rest on '-'). Gives BOTH first and last name.
              --   4. the email local-part (danny@… → "Danny") — first name only.
              COALESCE(
                NULLIF(btrim(l.first_name),''),
                (SELECT NULLIF(btrim(s.first_name),'') FROM esp_leads s
                  WHERE lower(s.email)=lower(l.email) AND NULLIF(btrim(s.first_name),'') IS NOT NULL
                  ORDER BY s.updated_at DESC LIMIT 1),
                NULLIF(split_part(li_name.full,' ',1),''),
                NULLIF(initcap(split_part(regexp_replace(split_part(l.email,'@',1),'[._-]+',' ','g'),' ',1)),'')
              ) AS first_name,
              COALESCE(
                NULLIF(btrim(l.last_name),''),
                (SELECT NULLIF(btrim(s.last_name),'') FROM esp_leads s
                  WHERE lower(s.email)=lower(l.email) AND NULLIF(btrim(s.last_name),'') IS NOT NULL
                  ORDER BY s.updated_at DESC LIMIT 1),
                -- everything after the first word of the LinkedIn-derived name
                NULLIF(btrim(substr(li_name.full, strpos(li_name.full,' ')+1)), li_name.full)
              ) AS last_name,
              l.company_name,
              l.status, l.label, l.first_replied_at, l.created_at,
              l.raw->>'camp_name'            AS campaign_name,
              l.raw->>'job_title'            AS job_title,
              l.raw->>'department'           AS department,
              l.raw->>'industry'             AS industry,
              l.raw->>'city'                 AS city,
              l.raw->>'state'                AS state,
              l.raw->>'country'              AS country,
              COALESCE(l.raw->>'address_line', l.raw->>'address') AS address_line,
              l.raw->>'company_website'      AS company_website,
              l.raw->>'linkedin_person_url'  AS linkedin_url,
              l.raw->>'linkedin_company_url' AS linkedin_company_url,
              l.raw->>'phone_number'         AS phone_number,
              l.raw->>'ch_company_number'    AS ch_company_number,
              l.raw->>'ch_company_status'    AS ch_company_status,
              l.raw->>'ch_company_type'      AS ch_company_type,
              l.raw->>'ch_incorporated_on'   AS ch_incorporated_on,
              l.raw->>'ch_registered_address' AS ch_registered_address,
              l.raw->>'ch_sic_codes'         AS ch_sic_codes,
              l.raw->>'ch_companies_house_url' AS ch_companies_house_url,
              l.raw->>'ch_endole_url'        AS ch_endole_url,
              l.raw->'custom_fields'         AS custom_fields,
              -- Most-recent INBOUND reply from the lead, for the list timestamp.
              (
                SELECT max(ein.timestamp_created) FROM portal_emails ein
                 WHERE ein.workspace_id = l.workspace_id
                   AND lower(ein.lead_email) = lower(l.email)
                   AND ein.direction = 'IN'
              ) AS last_reply_at,
              ld.deal_value, ld.notes AS deal_notes, ld.client_label, ld.first_responded_at,
              pd.status AS dispute_status, pd.reason AS dispute_reason, pd.admin_note AS dispute_admin_note,
              EXISTS (
                SELECT 1 FROM portal_emails e
                WHERE e.workspace_id = l.workspace_id
                  AND lower(e.lead_email) = lower(l.email)
                  AND e.direction = 'IN' AND e.is_unread = 1
              ) AS has_unread,
              (
                EXTRACT(EPOCH FROM (NOW() - COALESCE(l.first_replied_at, l.created_at))) >= 7*86400
                OR EXISTS (
                  SELECT 1 FROM portal_emails e2
                  WHERE e2.workspace_id = l.workspace_id
                    AND lower(e2.lead_email) = lower(l.email)
                    AND (e2.direction = 'OUT' OR e2.sent_via_portal = TRUE)
                )
              ) AS dispute_eligible,
              COALESCE(ld.archived, FALSE) AS archived,
              COALESCE(ld.replied_off, FALSE) AS replied_off,
              EXISTS (
                SELECT 1 FROM portal_emails e3
                WHERE e3.workspace_id = l.workspace_id
                  AND lower(e3.lead_email) = lower(l.email)
                  AND e3.sent_via_portal = TRUE
              ) AS has_sent,
              -- Has the lead been RESPONDED TO since their LATEST reply? Compares the
              -- most-recent genuine OUT (a reply composed in our portal OR an OUT dated
              -- after the prospect's first reply — NOT the original cold outreach) to
              -- the most-recent INBOUND. If the prospect's latest inbound is newer than
              -- our latest reply, the lead is back in "Needs reply" — so a SECOND
              -- prospect reply after we already answered re-surfaces it (the bug fix).
              (
                GREATEST(
                  ld.first_responded_at,
                  (
                    SELECT max(e4.timestamp_created) FROM portal_emails e4
                     WHERE e4.workspace_id = l.workspace_id
                       AND lower(e4.lead_email) = lower(l.email)
                       AND (
                         e4.sent_via_portal = TRUE
                         OR (e4.direction = 'OUT'
                             AND l.first_replied_at IS NOT NULL
                             AND e4.timestamp_created > l.first_replied_at)
                       )
                  )
                ) >= COALESCE(
                  (
                    SELECT max(e5.timestamp_created) FROM portal_emails e5
                     WHERE e5.workspace_id = l.workspace_id
                       AND lower(e5.lead_email) = lower(l.email)
                       AND e5.direction = 'IN'
                  ),
                  l.first_replied_at
                )
              ) AS has_outbound
       FROM esp_leads l
       -- Derive a name from the LinkedIn person URL slug as a name fallback.
       -- /in/danny-attwater-a182b1296 → strip the trailing -<alnum id>, split the
       -- rest on '-', initcap each word → "Danny Attwater". Sourced from the lead's
       -- own row or a sibling row (same email). NULL when there's no usable slug.
       LEFT JOIN LATERAL (
         SELECT (
           SELECT btrim(regexp_replace(
                    initcap(replace(
                      -- slug = path after /in/, minus a trailing -<id> segment and any trailing slash
                      regexp_replace(
                        regexp_replace(lower(split_part(split_part(s.raw->>'linkedin_person_url','/in/',2),'?',1)), '/+$',''),
                        -- strip a trailing LinkedIn id segment ONLY when it contains a
                        -- digit (e.g. -a182b1296), so an all-letter surname is kept.
                        '-[a-z0-9]*[0-9][a-z0-9]*$',''),
                      '-',' ')),
                    '\s+',' ','g'))
             FROM esp_leads s
            WHERE lower(s.email)=lower(l.email)
              AND s.raw->>'linkedin_person_url' ILIKE '%/in/%'
            ORDER BY s.updated_at DESC LIMIT 1
         ) AS full
       ) li_name ON TRUE
       LEFT JOIN portal_lead_data ld     ON ld.lead_id = l.id AND ld.client_id = $3
       LEFT JOIN portal_lead_disputes pd ON pd.lead_id = l.id AND pd.client_id = $3
       WHERE l.workspace_id = $1
         AND l.source IN ('plusvibe', 'bison')
         -- INTERESTED = billable leads; INFO = near-leads shown to the client but
         -- never charged (label='INFO' keeps them out of reconcileLeadCharges).
         AND l.label IN ('INTERESTED', 'INFO')
         AND ($2::text[] = '{}' OR l.label != ALL($2::text[]))
         -- Dedup PV/Bison: drop a frozen PV row when a Bison row exists for the
         -- same email (Bison wins), so migrated clients aren't double-counted.
         AND NOT (l.source = 'plusvibe' AND EXISTS (
           SELECT 1 FROM esp_leads b
           WHERE b.workspace_id = l.workspace_id
             AND lower(b.email) = lower(l.email)
             AND b.source = 'bison' AND b.label IN ('INTERESTED', 'INFO')
         ))
       ORDER BY l.first_replied_at DESC NULLS LAST, l.created_at DESC`,
      [session.workspaceId, hiddenLabels, session.clientId]
    )

    // Make sure lead charges are up to date, then work out which leads are locked
    // (delivered while the client was out of credit).
    await reconcileLeadCharges(session.clientId)
    const lockedIds = await getLockedLeadIds(session.clientId)

    // Suppress hidden fields server-side
    const suppress: string[] = []
    for (const key of hiddenFields) for (const f of FIELD_SUPPRESS[key] ?? []) if (!suppress.includes(f)) suppress.push(f)
    const rows = res.rows.map(r => {
      const out = { ...r }
      for (const f of suppress) out[f] = null
      // Info leads are free — they never count against credit, so they never lock.
      const isInfo = r.label === 'INFO'
      out.is_info = isInfo
      const locked = !isInfo && lockedIds.has(r.id)
      if (locked) for (const f of LOCKED_SUPPRESS) out[f] = null
      out.locked = locked
      return out
    })

    return NextResponse.json(rows)
  } catch (err) {
    console.error('[portal/leads/all]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
