import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getLockedLeadIds, reconcileLeadCharges } from '@/lib/balance'

// Fields hidden on a locked lead (delivered while out of credit) — everything
// identifying stays server-side until the client tops up. first/last name remain
// so we can show a "New lead from Ken — top up to unlock" teaser.
const LOCKED_SUPPRESS = ['email', 'company_name', 'company_website', 'phone_number', 'mobile_phone', 'office_phone',
  'job_title', 'department', 'industry', 'city', 'state', 'country', 'address_line',
  'linkedin_url', 'linkedin_company_url', 'campaign_name']

// Map a hidden_fields key -> which output fields it suppresses (server-side, so
// hidden data never reaches the browser).
const FIELD_SUPPRESS: Record<string, string[]> = {
  email: ['email'],
  phone: ['phone_number', 'mobile_phone', 'office_phone'],
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
      // ── ONE ROW PER PERSON ─────────────────────────────────────────────────
      // The inner query can return the SAME person twice. The PV-vs-Bison rule
      // below only drops a `plusvibe` row when a `bison` row exists, so two rows
      // of the SAME source survive it — and marking one reply as a lead twice in
      // the admin unibox mints a fresh synthetic `manual_<uuid>` id each time
      // (e.g. piers@ / matt@ for FirstVehicleFinance: two `bison` rows, 9 min
      // apart, identical but for the id). The paginated /api/portal/leads route
      // already de-dupes with DISTINCT ON; this one never did, so the client's
      // list and its "Your Leads (N)" count showed the duplicate.
      //
      // De-dupe on the OUTSIDE so the inner SQL (name fallbacks, locks, disputes)
      // is untouched. Survivor priority — keep the row the client has actually
      // interacted with, because portal_lead_data / portal_lead_disputes join on
      // l.id and picking the other row would silently drop a deal value, note or
      // open dispute:
      //   1. has deal data (value/notes/stage) or a dispute
      //   2. has been replied to / has unread mail
      //   3. newest by first_replied_at, then created_at
      `SELECT * FROM (
       SELECT DISTINCT ON (lower(d.email)) d.* FROM (
       SELECT l.id, l.email,
              -- ── Name resolution with a FALLBACK CHAIN ──────────────────────
              -- A lead's name may be missing on its own row, so we try, in order:
              --   1. the row's own first/last name
              --   2. a sibling row's name (SAME email — matched on email ONLY, since
              --      a PV→Bison-migrated lead keeps its old PV workspace_id)
              --   3. the LinkedIn URL slug: /in/danny-attwater-a182b1296 →
              --      "Danny Attwater" (strip the trailing random id segment, split
              --      the rest on '-'). Gives BOTH first and last name.
              --   4. the email local-part (danny@… → "Danny") — first name only.
              --
              -- NOTE on 3: the slug only splits when it HAS hyphens. Plenty don't
              -- (/in/pierschadwick, /in/matthodkinson), which rendered as a single
              -- run-together word with a blank surname ("Pierschadwick"). So when
              -- the slug is one word we re-split it using the properly spaced name
              -- from the lead's own reply (sig_name.full) — that text is authored by
              -- the lead, so "Piers Chadwick" / "Matt Hodkinson" come out right.
              COALESCE(
                NULLIF(btrim(l.first_name),''),
                (SELECT NULLIF(btrim(s.first_name),'') FROM esp_leads s
                  WHERE lower(s.email)=lower(l.email) AND NULLIF(btrim(s.first_name),'') IS NOT NULL
                  ORDER BY s.updated_at DESC LIMIT 1),
                -- prefer a spaced name over a one-word slug
                CASE WHEN li_name.full IS NULL OR strpos(btrim(li_name.full),' ') = 0
                     THEN NULLIF(split_part(sig_name.full,' ',1),'') END,
                NULLIF(split_part(li_name.full,' ',1),''),
                NULLIF(initcap(split_part(regexp_replace(split_part(l.email,'@',1),'[._-]+',' ','g'),' ',1)),'')
              ) AS first_name,
              COALESCE(
                NULLIF(btrim(l.last_name),''),
                (SELECT NULLIF(btrim(s.last_name),'') FROM esp_leads s
                  WHERE lower(s.email)=lower(l.email) AND NULLIF(btrim(s.last_name),'') IS NOT NULL
                  ORDER BY s.updated_at DESC LIMIT 1),
                -- everything after the first word of the LinkedIn-derived name
                NULLIF(btrim(substr(li_name.full, strpos(li_name.full,' ')+1)), li_name.full),
                -- ...and if the slug was one word, the surname from the reply
                NULLIF(btrim(substr(sig_name.full, strpos(sig_name.full,' ')+1)), sig_name.full)
              ) AS last_name,
              -- ── COMPANY NAME ──────────────────────────────────────────────
              -- company_name is often just the email domain with the TLD chopped
              -- off and title-cased ("Klcemploymentlaw", "Tylt"), which is what the
              -- client sees. Companies House gives the real name, but CH matching is
              -- fuzzy and a blanket swap DEGRADES some rows (cake-architecture.com
              -- matched "CAKE LTD"; rpm.ltd matched "RIVERSIDE PRECISION MATERIALS").
              --
              -- So only take the CH name when the DOMAIN corroborates it: strip the
              -- legal suffix and punctuation from both, and require one to be a
              -- prefix of the other. "KLC EMPLOYMENT LAW CONSULTANTS LLP" ->
              -- klcemploymentlaw matches the domain, so it wins; "CAKE LTD" -> cake
              -- does not match cakearchitecture, so we keep what we had. Conservative
              -- by design: better a plain name than a confidently wrong one.
              COALESCE(ch_co.name, l.company_name) AS company_name,
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
              l.raw->>'mobile_phone'         AS mobile_phone,
              l.raw->>'office_phone'         AS office_phone,
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
       -- Properly SPACED name for this lead, used to split a one-word LinkedIn slug
       -- (see the name chain above). Source is the reply envelope's display name
       -- (raw->'from_address_json' = [{"name":"Matt Hodkinson","address":"matt@…"}]),
       -- NOT a scan of the body: the display name is authored by the lead and tied
       -- to their address, so quoted text (which contains OUR sender's name) can
       -- never leak in. Guarded to a two-word "First Last" shape, and only used
       -- when the slug is a single run-together word.
       LEFT JOIN LATERAL (
         SELECT (
           SELECT btrim(a->>'name')
             FROM unibox_replies u
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(u.raw->'from_address_json') = 'array'
                    THEN u.raw->'from_address_json' ELSE '[]'::jsonb END
             ) AS a
            WHERE lower(u.lead_email) = lower(l.email)
              AND lower(a->>'address') = lower(l.email)
              AND btrim(a->>'name') ~ '^[A-Za-z][A-Za-z''-]* [A-Za-z][A-Za-z''-]*$'
            ORDER BY u.received_at DESC
            LIMIT 1
         ) AS full
       ) sig_name ON TRUE
       -- Real Companies House name for this lead, but ONLY when the email domain
       -- corroborates it (see the company_name comment above).
       LEFT JOIN LATERAL (
         SELECT ch.nm AS name FROM (
           SELECT btrim(u.ch_data->>'company_name') AS nm,
                  -- domain, first label only, letters+digits
                  regexp_replace(lower(split_part(split_part(l.email,'@',2),'.',1)),'[^a-z0-9]','','g') AS dom,
                  -- CH name minus a trailing legal suffix, letters+digits
                  regexp_replace(lower(regexp_replace(btrim(u.ch_data->>'company_name'),
                    '\s*(LIMITED|LTD|LLP|PLC|COMPANY|L\.?T\.?D\.?)\b.*$','','gi')),'[^a-z0-9]','','g') AS chl
             FROM unibox_replies u
            WHERE lower(u.lead_email) = lower(l.email)
              AND NULLIF(btrim(u.ch_data->>'company_name'),'') IS NOT NULL
            ORDER BY u.received_at DESC
            LIMIT 1
         ) ch
          WHERE ch.chl <> '' AND ch.dom <> ''
            AND (ch.dom LIKE ch.chl || '%' OR ch.chl LIKE ch.dom || '%')
       ) ch_co ON TRUE
       LEFT JOIN portal_lead_data ld     ON ld.lead_id = l.id AND ld.client_id = $3
       LEFT JOIN portal_lead_disputes pd ON pd.lead_id = l.id AND pd.client_id = $3
       WHERE l.workspace_id = $1
         AND l.source IN ('plusvibe', 'bison')
         -- INTERESTED = billable leads; INFO = near-leads shown but never charged
         -- (label='INFO' keeps them out of reconcileLeadCharges). ALSO surface
         -- MEETING_BOOKED leads (the hottest type) — they carry status, not label,
         -- so the label-only filter hid them from the inbox while the dashboard
         -- tiles (which count by status) still showed them → an unreachable lead.
         AND (l.label IN ('INTERESTED', 'INFO') OR l.status = 'MEETING_BOOKED')
         -- ...but never a lead whose non-lead dispute was approved. The label
         -- branch already excludes those; the MEETING_BOOKED branch is status-
         -- based and would let a rejected-and-credited lead back in.
         AND l.label IS DISTINCT FROM 'NOT_INTERESTED'
         AND ($2::text[] = '{}' OR l.label IS NULL OR l.label != ALL($2::text[]))
         -- Dedup PV/Bison: drop a frozen PV row when a Bison row exists for the
         -- same email (Bison wins), so migrated clients aren't double-counted.
         AND NOT (l.source = 'plusvibe' AND EXISTS (
           SELECT 1 FROM esp_leads b
           WHERE b.workspace_id = l.workspace_id
             AND lower(b.email) = lower(l.email)
             AND b.source = 'bison' AND b.label IN ('INTERESTED', 'INFO')
         ))
       ORDER BY l.first_replied_at DESC NULLS LAST, l.created_at DESC
       ) d
       -- Survivor per person: client-touched row first, then newest. Must lead
       -- with lower(email) to match DISTINCT ON.
       ORDER BY lower(d.email),
                (d.deal_value IS NOT NULL OR d.deal_notes IS NOT NULL
                 OR d.client_label IS NOT NULL OR d.dispute_status IS NOT NULL) DESC,
                (d.has_unread OR d.replied_off) DESC,
                d.first_replied_at DESC NULLS LAST, d.created_at DESC
       ) uniq
       -- Restore the list order the UI expects (newest reply first).
       ORDER BY uniq.first_replied_at DESC NULLS LAST, uniq.created_at DESC`,
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
