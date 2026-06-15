import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { CATEGORIES, CLASSIFIER_VERSION } from '@/lib/classify'

// Where a human-corrected category routes the reply. Mirrors the classify cron's
// routing so a correction lands the reply in the right place — but NEVER moves a
// row out of unmapped/rejected (those are deliberate end-states); only inbox/review
// rows get re-filed. interested + question → review (a question is a hot lead).
function folderForCategory(cat: string): 'review' | 'warmup' | 'done' | null {
  if (cat === 'interested' || cat === 'question') return 'review'
  if (cat === 'warmup') return 'warmup'      // visible warmup folder (Phase 2)
  if (cat === 'unsubscribe') return 'done'   // actioned end-state
  return 'done'                              // not_interested / ooo / other → done
}

// Admin overrides the AI classification by setting admin_label. Stored ALONGSIDE
// (not over) the AI category so the model's original call is preserved — and that
// preserved pair is exactly what makes corrections minable as training signal.
// Captures a classifier_feedback row in the same transaction.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()
  const { id } = await params

  const body = await req.json().catch(() => ({})) as { admin_label?: string }
  const adminLabel = body.admin_label
  if (typeof adminLabel !== 'string' || !CATEGORIES.includes(adminLabel as typeof CATEGORIES[number])) {
    return NextResponse.json({ error: `admin_label must be one of: ${CATEGORIES.join(', ')}` }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock the row and read the AI's call + the full body (from raw, not the
    // truncated preview) so the feedback example matches what the classifier saw.
    const sel = await client.query(
      `SELECT id, category, confidence, classifier_version, folder, subject,
              admin_label AS prev_admin_label,
              raw->>'text_body' AS body_text,
              (raw ? 'lead_id') AS had_lead_fields
         FROM unibox_replies WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (!sel.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }
    const row = sel.rows[0] as {
      category: string | null; confidence: number | null; classifier_version: string | null
      folder: string; subject: string | null; body_text: string | null; had_lead_fields: boolean
    }

    // Re-file the row — but only out of inbox/review (never incinerate a
    // deliberate unmapped/rejected end-state).
    const target = folderForCategory(adminLabel)
    const newFolder = (target && (row.folder === 'inbox' || row.folder === 'review')) ? target : row.folder

    await client.query(
      `UPDATE unibox_replies
          SET admin_label = $2, admin_label_by = 'admin', folder = $3, updated_at = NOW()
        WHERE id = $1`,
      [id, adminLabel, newFolder]
    )

    // Record the feedback signal. is_correction = the human disagreed with the AI.
    // Confirmations (agreement) are positive signal too, so we log both — but only
    // corrections are eligible to become few-shot examples (filtered at build time).
    const isCorrection = (row.category ?? null) !== adminLabel
    await client.query(
      `INSERT INTO classifier_feedback
         (reply_id, subject, body_text, had_lead_fields, ai_category, ai_confidence,
          human_category, is_correction, signal_type, classifier_version, corrected_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'label_correction',$9,'admin','admin_override')
       ON CONFLICT (reply_id, human_category) DO UPDATE SET
         is_correction = EXCLUDED.is_correction,
         created_at = NOW()`,
      [id, row.subject, row.body_text, row.had_lead_fields, row.category, row.confidence,
       adminLabel, isCorrection, row.classifier_version ?? CLASSIFIER_VERSION]
    )

    await client.query('COMMIT')
    return NextResponse.json({ ok: true, admin_label: adminLabel, folder: newFolder, is_correction: isCorrection })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[admin/unibox/[id]] PATCH error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    client.release()
  }
}
