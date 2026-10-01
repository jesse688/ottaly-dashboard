/**
 * Bounce classification.
 *
 * A bounce COUNT cannot tell you what to do. The same number can mean "our
 * tenant is over its sending limit" (lower the volume) or "that address does
 * not exist" (fix the data), and those need opposite responses. So bounces are
 * classified by the TEXT of the bounce message, and the action follows the
 * cause.
 *
 * Measured across 7,022 bounces from 21 clients on 2026-09-18:
 *   3,669 (52%) our sending  — content 2,716, sender rejected 539,
 *                              tenant 237, blocklisted 99, relay 68, DMARC 10
 *   3,353 (48%) NOT ours     — bad address 1,908, recipient-side 910,
 *                              inactive 183, unclassified 352
 *
 * Nearly half of all bounces say nothing about our sending. A raw bounce rate
 * counts them identically to real faults, which is how three healthy mailboxes
 * came to be paused on a ">2% bounce" rule when their only bounces were dead
 * recipient addresses.
 *
 * WHY TEXT AND NOTHING ELSE, measured rather than assumed:
 *
 *   - Provider fields lie. 16 of 68 `5.7.233` bounces were labelled
 *     GOOGLE_WORKSPACE. That code is Exchange Online only, so Google cannot
 *     have emitted them.
 *   - bounce_type is too coarse. SENDER covers tenant limit, blocklisting and
 *     DMARC failure, which need three different responses, and `5.0.350`
 *     appeared as both SENDER and RECIPIENT in one page of results.
 *   - Every bounced lead carried a message, so text has full coverage and no
 *     fallback path is needed.
 *
 * Source: email_events rows where event_type = 'bounce', message in
 * raw->>'msg' (raw->>'reason' on older rows).
 */

/** What a bounce of this kind means we should DO. */
export type BounceAction =
  | 'reduce_volume'   // our sending rate is the problem
  | 'retire_domain'   // the domain itself is burned
  | 'fix_dns'         // an auth/config fault; volume is irrelevant
  | 'fix_content'     // copy or reputation
  | 'suppress_lead'   // bad data, not a mailbox fault
  | 'none'            // the recipient's own situation, nothing to do

export interface BounceCause {
  key: string
  label: string
  action: BounceAction
  explain: string
}

interface Rule extends BounceCause {
  match: (m: string) => boolean
}

/**
 * Causes, in the order they are tested. Order matters: the first match wins,
 * so specific codes sit above general ones.
 */
const RULES: Rule[] = [
  {
    key: 'tenant_rate_limit',
    label: 'Tenant rate limit',
    action: 'reduce_volume',
    match: m => m.includes('5.7.233'),
    explain: 'The whole Microsoft tenant is over its daily limit for sending to '
      + 'external recipients. Shared across clients, so it is not this mailbox '
      + 'misbehaving — the fix is less volume, not a pause.',
  },
  {
    // SURBL is deliberately NOT matched here -- it has its own low-priority
    // rule at the END of this list. Keep this rule ABOVE that one so a bounce
    // naming both a real blocklist and SURBL is judged on the real one.
    key: 'blocklisted',
    label: 'Domain blocklisted',
    action: 'retire_domain',
    match: m => m.includes('spamhaus')
      || m.includes('barracudacentral') || m.includes('spamcop'),
    explain: 'The domain named in the bounce is on a public blocklist '
      + '(Spamhaus DBL, Barracuda or SpamCop). Volume changes will not help; '
      + 'it has to come out of rotation.',
  },
  {
    key: 'dmarc_fail',
    label: 'DMARC / auth failure',
    action: 'fix_dns',
    match: m => m.includes('5.7.509') || m.includes('does not pass dmarc')
      || m.includes('5.7.26') || m.includes('dmarc policy of reject')
      || m.includes('spf check failed') || m.includes('5.7.1 unauthenticated'),
    explain: 'The domain fails its own published auth policy, so every send '
      + 'bounces regardless of volume. A DNS fix, not a sending fix.',
  },
  {
    key: 'spam_content',
    label: 'Content / reputation',
    action: 'fix_content',
    match: m => m.includes('5.7.350') || m.includes('high probability of spam')
      || m.includes('no spam please') || m.includes('5.7.351')
      || m.includes('message content') || m.includes('spam message rejected')
      // Mimecast and similar gateways reject on their own security policy.
      || m.includes('5.7.352') || m.includes('detected message as spam')
      || m.includes('security policies') || m.includes('envelope blocked')
      // Gmail's "Message blocked", per-recipient blacklists, content filters.
      || m.includes('message blocked') || m.includes('blacklisted')
      || m.includes('content filters') || m.includes('not allowed to send')
      || m.includes('prohibited the mail'),
    explain: 'The receiving side judged the message itself. A copy or '
      + 'reputation problem rather than a rate problem.',
  },
  {
    key: 'relay_denied',
    label: 'Relay not permitted',
    action: 'fix_dns',
    match: m => m.includes('5.7.367') || m.includes('not permitted to relay')
      || m.includes('relaying from') || m.includes('relay access denied')
      || m.includes('relay not permitted') || m.includes('relaying denied')
      || m.includes('open relay not allowed'),
    explain: 'The receiving server refused to relay for this sender. A routing '
      + 'or auth fault, and volume has no bearing on it.',
  },
  {
    key: 'sender_rejected',
    label: 'Sender rejected by recipient gateway',
    action: 'fix_content',
    // MUST stay below relay_denied: "Relay access denied" also contains
    // "access denied", and calling a relay fault a content problem sends you
    // to rewrite copy when the fix is DNS. 17 bounces hit this.
    // "Recipient address rejected: Access denied" from Exchange Online is the
    // receiving tenant refusing OUR sender, not a dead address — the address
    // resolved, the sender was turned away.
    match: m => m.includes('access denied') || m.includes('recipient address rejected'),
    explain: 'The receiving organisation refused our sender. Their filtering or '
      + 'our reputation, not the address being wrong and not our send rate.',
  },
  {
    key: 'bad_address',
    label: 'Address does not exist',
    action: 'suppress_lead',
    match: m => m.includes('resolver.adr.recipientnotfound')
      || m.includes('nosuchuser') || m.includes('5.1.1')
      || m.includes('address not found') || m.includes('does not exist')
      || m.includes('recipient not found') || m.includes('5.1.10')
      || m.includes('no such user') || m.includes('5.1.351')
      || m.includes('recipient unknown') || m.includes('unknown recipient')
      || m.includes('mailbox unavailable') || m.includes('user unknown')
      || m.includes('invalid recipient')
      || m.includes('unable to find the recipient domain')
      || m.includes('no mailbox by that name'),
    explain: 'The address is dead. A data-quality problem — it says nothing '
      + 'about the health of the mailbox that sent it.',
  },
  {
    key: 'inactive_mailbox',
    label: 'Recipient mailbox inactive',
    action: 'suppress_lead',
    match: m => m.includes('disableduser') || m.includes('5.2.1')
      || m.includes('is inactive') || m.includes('account is disabled'),
    explain: 'The recipient account exists but is switched off. Data quality.',
  },
  {
    key: 'recipient_side',
    label: 'Recipient-side, no action',
    action: 'none',
    match: m => m.includes('mailbox full') || m.includes('quotaexceeded')
      || m.includes('transport.rules') || m.includes('5.7.520')
      || m.includes('sendernotauthenticatedforgroup')
      || m.includes('sendernotauthenticatedformailbox')
      || m.includes('hop count exceeded') || m.includes('5.4.300')
      || m.includes('5.2.2')
      // Their group rules, forwarding setup, admin policy, or a dead server.
      || m.includes('5.7.193') || m.includes('unifiedgroupagent')
      || m.includes("isn't a group member")
      || m.includes('5.7.360') || m.includes('administrative policy')
      || m.includes('administrative prohibition')
      || m.includes("couldn't be forwarded")
      || m.includes('connection timed out') || m.includes('command rejected')
      || m.includes('delivery incomplete') || m.includes('temporary problem')
      || m.includes('out of storage space') || m.includes('overquota')
      || m.includes('quota exceeded') || m.includes('mailbox for user is full')
      || m.includes('delivery has failed to these recipients')
      || m.includes('no mail-enabled')
      || m.includes('local policy') || m.includes('geoip restriction')
      || m.includes('delivery requirements')
      || m.includes('restrictedtorecipientspermission')
      || m.includes('5.7.129') || m.includes(':blocked)'),
    explain: 'Their mailbox, their org policy, or their server not answering. '
      + 'Nothing on our side to change.',
  },
  {
    // LAST, deliberately. SURBL used to live in the `blocklisted` rule above
    // and therefore told us to RETIRE THE DOMAIN, which is the wrong call:
    //
    //   - SURBL lists URLs found in message BODIES, not sending domains or
    //     IPs. A hit says a link was listed, not that the mailbox is bad.
    //   - Its public zone (multi.surbl.org) is dead: every query returns
    //     SERVFAIL, so a listing cannot be verified without a paid DQS key.
    //     Checked 2026-09-21 against SURBL's own permanent test point.
    //   - It is a minority of bounce volume and only one receiver enforces it.
    //
    // Classified but action 'none', so it stays visible and counted without
    // proposing a domain retirement nobody can confirm is warranted.
    key: 'surbl_listed',
    label: 'SURBL (link in body listed)',
    action: 'none',
    match: m => m.includes('surbl'),
    explain: 'A URL in the message body is on SURBL. That lists LINKS, not '
      + 'sending domains, and SURBL\'s public lookup no longer answers, so a '
      + 'listing cannot be verified. Logged for visibility; no action taken.',
  },
]

export const UNKNOWN: BounceCause = {
  key: 'unknown',
  label: 'Unclassified',
  action: 'none',
  explain: 'No rule matched this bounce text. Worth reading — an unclassified '
    + 'bounce that recurs is a missing rule, not a non-event.',
}

/** Classify one bounce message. Matching is case-insensitive. */
export function classify(bounceMsg: string | null | undefined): BounceCause {
  const m = String(bounceMsg ?? '').toLowerCase()
  if (!m.trim()) return UNKNOWN
  for (const r of RULES) if (r.match(m)) return r
  return UNKNOWN
}

/** The leading SMTP enhanced status code, for grouping. */
export function statusCode(bounceMsg: string | null | undefined): string | null {
  const m = String(bounceMsg ?? '').match(/[45]\.\d\.\d+/)
  return m ? m[0] : null
}

/**
 * The domain a blocklist bounce names.
 *
 * Blocklist rejections quote the LISTED domain, which is a URL inside the
 * email and not necessarily the envelope sender — attributing it to the sender
 * could retire a healthy domain. Measured on 2026-09-18, all 91 extractable
 * listings WERE the sending domain, but reading the message keeps that an
 * observation rather than an assumption.
 *
 * Providers space the domain out to stop it being clickable
 * ("shirebusinessrecovery . co . uk"), so spaces are stripped back.
 */
export function listedDomain(bounceMsg: string | null | undefined): string | null {
  const m = String(bounceMsg ?? '')
  const patterns = [
    /URL in this email \(([^)]+)\)/i,      // SURBL / Spamhaus wording
    /([a-z0-9.\- ]+?)\s+blocked using/i,   // "x.co.uk blocked using Spamhaus DBL"
  ]
  for (const re of patterns) {
    const hit = m.match(re)
    if (hit) {
      const d = hit[1].replace(/\s+/g, '').toLowerCase()
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return d
    }
  }
  return null
}

/**
 * Actions meaning "our sending is the problem". ONLY these may change a
 * mailbox's volume.
 *
 * This matters concretely: a volume rule keyed on total bounce rate paused
 * three mailboxes whose only bounces were dead recipient addresses. Splitting
 * on cause excludes them automatically.
 */
const SENDING_FAULTS = new Set<BounceAction>([
  'reduce_volume', 'retire_domain', 'fix_dns', 'fix_content',
])

export function isSendingFault(cause: BounceCause): boolean {
  return SENDING_FAULTS.has(cause.action)
}

/**
 * Classification happens HERE, in TypeScript, and nowhere else.
 *
 * A SQL `CASE` mirroring these rules was written first, to classify inside the
 * query the way app/api/bounces/route.ts does. Run over the real 7,024-bounce
 * corpus the two versions disagreed on 96 rows — a third of the unclassified
 * ones, plus 17 relay failures the SQL called content problems. Two expressions
 * of the same logic drift, and the drift is silent.
 *
 * So the SQL version is gone. Routes fetch bounce rows and classify them in JS,
 * which costs nothing measurable: 7,024 rows classify in well under a second,
 * and those rows are already being fetched to display. If the corpus ever grows
 * enough for that to matter, the fix is a stored `cause` column written by the
 * ingest — still one rule set, not two.
 */

/** Rows a route fetches from email_events, before classification. */
export interface RawBounce {
  msg: string | null
  sender_email: string | null
  lead_email: string | null
  workspace_id: string | null
  event_at: string | Date
}

/** A bounce with its cause worked out. */
export interface ClassifiedBounce extends RawBounce {
  cause: string
  action: BounceAction
  status_code: string | null
  sending_fault: boolean
}

/** Classify a batch of rows. The one entry point routes should use. */
export function classifyAll(rows: RawBounce[]): ClassifiedBounce[] {
  return rows.map(r => {
    const c = classify(r.msg)
    return {
      ...r,
      cause: c.key,
      action: c.action,
      status_code: statusCode(r.msg),
      sending_fault: isSendingFault(c),
    }
  })
}
