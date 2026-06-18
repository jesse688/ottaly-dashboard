import { getAdminSession } from '@/lib/auth'
import { redirect } from 'next/navigation'

// Internal, admin-only review of the multi-agent UX/feature audit (2026-06-14).
// A place to look over every proposed change BEFORE building it live.
export default async function SuggestionsPage() {
  if (!await getAdminSession()) redirect('/admin/login')

  const Card = ({ tag, color, children }: { tag: string; color: string; children: React.ReactNode }) => (
    <div className="rounded-xl border border-gray-200 bg-white p-4 mb-3">
      <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full mb-2 ${color}`}>{tag}</span>
      <div className="text-sm text-gray-700 leading-relaxed">{children}</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="h-12 bg-[#1a2332] flex items-center px-6">
        <span className="text-white font-bold text-sm">Ottaly</span>
        <span className="text-slate-500 text-xs mx-2">|</span>
        <span className="text-slate-300 text-sm">Portal — UX & Feature Suggestions (internal)</span>
        <a href="/admin/clients" className="ml-auto text-slate-300 hover:text-white text-sm">← Back to admin</a>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Client portal — what we could improve</h1>
        <p className="text-sm text-gray-500 mb-2">Output of a 6-perspective UX review + a ship-fast vs. visionary debate (9 agents, 28 ideas). Nothing here is live yet — this is the shortlist to decide from.</p>
        <p className="text-xs text-gray-400 mb-8">Status legend: <span className="text-emerald-600 font-medium">Shipped</span> = already built · <span className="text-indigo-600 font-medium">Do now</span> = quick win · <span className="text-amber-600 font-medium">Worth building</span> = bigger bet · <span className="text-gray-400 font-medium">Skip</span> = decided against.</p>

        <h2 className="text-lg font-semibold text-gray-900 mb-3">⭐ Highest-leverage first move</h2>
        <Card tag="Do now" color="bg-indigo-100 text-indigo-700">
          <strong>Show ROI / spend / cost-per-lead on the Billing card.</strong> The backend already returns <code className="bg-gray-100 px-1 rounded text-xs">roi</code>, <code className="bg-gray-100 px-1 rounded text-xs">spent</code>, <code className="bg-gray-100 px-1 rounded text-xs">costPerLead</code> — the page currently throws them away and shows only deals-won + leads-delivered. Rendering them (gated by the existing <code className="bg-gray-100 px-1 rounded text-xs">showSpend</code> flag) turns the page clients visit to spend money into a renewal-justifying proof-of-value dashboard. Render-only change.
        </Card>

        <h2 className="text-lg font-semibold text-gray-900 mb-3 mt-8">✅ Already shipped this session</h2>
        {[
          'Logo renders everywhere (login / welcome / header)',
          'Reply composer collapses to a slim bar; cleaner ~68ch email body, no big gaps',
          'Bullet & numbered-list reply buttons fixed',
          'HTML-only message bodies now display (no false "no content")',
          'Canonical /leads URL (was /unibox); welcome splash shows once per session',
          'Signature auto-extract (phone / website / LinkedIn / title) into contact panel',
          'Multi-workspace logins + switcher; self-serve forgot-code via email',
          'Warmup progress bar (warming up → campaign live), admin-configurable',
        ].map(t => <Card key={t} tag="Shipped" color="bg-emerald-100 text-emerald-700">{t}</Card>)}

        <h2 className="text-lg font-semibold text-gray-900 mb-3 mt-8">🚀 Do now — quick wins</h2>
        {[
          ['Promote value cards to top of Billing', 'Reorder so Delivered / Deals won / ROI sit above the balance — the first thing seen where clients decide to spend.'],
          ['Invoice line-item math', '"N leads @ £X = total" on each invoice row instead of a bare amount. Biggest trust win for non-technical clients checking they weren’t overcharged.'],
          ['Mobile tap-target fix', 'Back buttons / modal closes to 44×44 (iOS standard); list rows min 56px; active:scale feedback. Many clients are 50+ on phones between jobs.'],
          ['Dispute reassurance copy', '"We refund leads that aren’t real prospects — reviewed within 24h, no charge." Removes the "will I get charged for complaining?" fear.'],
          ['Low-balance banner that knows unpaid invoices', 'When balance is low AND an invoice is unpaid, show "Complete your pending payment to resume lead delivery" in the inbox. Closes the "why did my leads stop?" loop.'],
        ].map(([t, d]) => <Card key={t} tag="Do now" color="bg-indigo-100 text-indigo-700"><strong>{t}.</strong> {d}</Card>)}

        <h2 className="text-lg font-semibold text-gray-900 mb-3 mt-8">🏗️ Worth building — bigger bets</h2>
        {[
          ['Deal-value capture → pipeline → renewal proof', 'Capture £ value when a lead moves to Won/Quote Sent, feed the already-wired pipeline/ROI on Billing. The moat: every renewal chat becomes "£15k pipeline from £1k spent". Half the plumbing exists.'],
          ['Live lead delivery (polling/SSE + unread badge)', 'Everything is fetch-on-mount; a client never learns a hot lead landed until they reload. Speed-to-lead IS the product — protect it. (Preferred over manual pull-to-refresh.)'],
          ['First-week warmup empty state', 'Done via the warmup bar — keep it copy/visual only, never promise a lead date we can’t know.'],
        ].map(([t, d]) => <Card key={t} tag="Worth building" color="bg-amber-100 text-amber-700"><strong>{t}.</strong> {d}</Card>)}

        <h2 className="text-lg font-semibold text-gray-900 mb-3 mt-8">🗑️ Skip — decided against (with reason)</h2>
        {[
          ['Keyboard shortcuts (j/k/r/a)', 'Power-user feature for non-technical clients mostly on mobile. Zero retention impact.'],
          ['Bulk actions / multi-select', 'Clients get a trickle of warm leads, not a queue of thousands. Adds complexity for an agency-side need.'],
          ['Reply templates / snippets', 'Canned replies undercut the personal tone warm replies depend on.'],
          ['Bottom-sheet drag composer', 'Re-engineers a composer that already collapses cleanly.'],
          ['Swipe-back / pull-to-refresh gestures', 'Custom touch code that fights native browser behaviour; real fix is bigger back button + live polling.'],
          ['Locked-lead "unlock" modal w/ auto-unlock', 'A free unlock contradicts the pay-per-lead model; current Top-up CTA is better.'],
          ['QR/Stripe links, digest emails, invoice timeline', 'Each needs a new integration / cron / event history not yet modelled. Out of scope for this pass.'],
        ].map(([t, d]) => <Card key={t} tag="Skip" color="bg-gray-100 text-gray-500"><strong>{t}.</strong> {d}</Card>)}

        <p className="text-xs text-gray-400 mt-8">Generated from the portal-ux-debate workflow, 2026-06-14. Edit this page to re-prioritise.</p>
      </div>
    </div>
  )
}
