/**
 * Bounce classification.
 *
 * A bounce COUNT cannot tell you what to do. The same number can mean "our
 * tenant is over its sending limit" (lower the volume) or "that address does
 * not exist" (fix the data), and those need opposite responses. So bounces are
 * classified by the text of `bounce_msg`, and the action follows the cause.
 *
 * WHY TEXT AND NOTHING ELSE. Measured on 100 bounced Shire leads, 2026-09-18:
 *
 *   - `mx` lies. 16 of 68 `5.7.233` bounces were labelled GOOGLE_WORKSPACE.
 *     That code is Exchange Online only, so Google cannot have emitted them.
 *   - `bounce_type` is too coarse. SENDER covers tenant limit, blocklisting
 *     and DMARC failure, which need three different responses. `5.0.350` even
 *     appears as both SENDER and RECIPIENT in one page of results.
 *   - Every bounced lead carried a `bounce_msg`, so text covers 100% of cases
 *     and no fallback path is needed.
 *
 * Source: list_all_leads with status=BOUNCED returns bounce_msg and
 * bounce_type. The bulk stats endpoint returns counts only.
 */

/**
 * Causes, in the order they are tested. Order matters: the first match wins,
 * so the specific codes sit above the general ones.
 *
 *   action: what a bounce of this kind means we should DO
 *     reduce_volume  our sending rate is the problem
 *     retire_domain  the domain itself is burned
 *     fix_dns        an auth/config fault, volume is irrelevant
 *     fix_content    copy or reputation
 *     suppress_lead  bad data, not a mailbox fault
 *     none           the recipient's own situation, nothing to do
 */
const CAUSES = [
  {
    key: 'tenant_rate_limit',
    label: 'Tenant rate limit',
    action: 'reduce_volume',
    match: (m) => m.includes('5.7.233'),
    explain: 'The whole Microsoft tenant is over its daily limit for sending to '
      + 'external recipients. Shared across clients, so it is not this mailbox '
      + 'misbehaving — the fix is less volume, not a pause.',
  },
  {
    key: 'blocklisted',
    label: 'Domain blocklisted',
    action: 'retire_domain',
    match: (m) => m.includes('surbl.org') || m.includes('spamhaus')
      || m.includes('barracudacentral') || m.includes('spamcop'),
    // The message names the LISTED domain, which is a URL inside the email
    // rather than necessarily the envelope sender. Measured across 91 of 99
    // blocklist bounces on 2026-09-18, it was the sending domain every time —
    // these are our own domains listed, not third-party links. Use
    // listedDomain() rather than assuming, so a link-target listing is not
    // blamed on a healthy sending domain.
    explain: 'The domain named in the bounce is on a public blocklist (SURBL or '
      + 'Spamhaus DBL). Volume changes will not help; it has to come out of '
      + 'rotation.',
  },
  {
    key: 'dmarc_fail',
    label: 'DMARC / auth failure',
    action: 'fix_dns',
    match: (m) => m.includes('5.7.509') || m.includes('does not pass DMARC')
      || m.includes('5.7.26') || m.includes('DMARC policy of reject')
      || m.includes('SPF check failed') || m.includes('5.7.1 Unauthenticated'),
    explain: 'The domain fails its own published auth policy, so every send '
      + 'bounces regardless of volume. A DNS fix, not a sending fix.',
  },
  {
    key: 'spam_content',
    label: 'Content / reputation',
    action: 'fix_content',
    match: (m) => m.includes('5.7.350') || m.includes('High probability of spam')
      || m.includes('No SPAM please') || m.includes('5.7.351')
      || m.includes('message content') || m.includes('Spam message rejected')
      // Mimecast and similar gateways reject on their own security policy.
      || m.includes('5.7.352') || m.includes('detected message as spam')
      || m.includes('security policies') || m.includes('Envelope blocked')
      // Gmail's "Message blocked", per-recipient blacklists, and content
      // filters are all judgements about the mail, not the send rate.
      || m.includes('Message blocked') || m.includes('Blacklisted')
      || m.includes('content filters') || m.includes('not allowed to send')
      || m.includes('high probability of spam') || m.includes('prohibited the mail'),
    explain: 'The receiving side judged the message itself. A copy or '
      + 'reputation problem rather than a rate problem.',
  },
  {
    key: 'sender_rejected',
    label: 'Sender rejected by recipient gateway',
    action: 'fix_content',
    // "Recipient address rejected: Access denied" from Exchange Online is the
    // receiving tenant refusing OUR sender, not a dead address — the address
    // resolved, the sender was turned away. 14 of 100 Shire bounces, the
    // largest single unclassified group before this rule existed.
    match: (m) => m.includes('Access denied')
      || m.includes('Recipient address rejected'),
    explain: 'The receiving organisation refused our sender. Their filtering or '
      + 'our reputation, not the address being wrong and not our send rate.',
  },
  {
    key: 'relay_denied',
    label: 'Relay not permitted',
    action: 'fix_dns',
    match: (m) => m.includes('5.7.367') || m.includes('not permitted to relay')
      || m.includes('Relaying from') || m.includes('Relay access denied')
      || m.includes('relay not permitted') || m.includes('Relaying denied')
      || m.includes('Open relay not allowed'),
    explain: 'The receiving server refused to relay for this sender. A routing '
      + 'or auth fault, and volume has no bearing on it.',
  },
  {
    key: 'bad_address',
    label: 'Address does not exist',
    action: 'suppress_lead',
    match: (m) => m.includes('RESOLVER.ADR.RecipientNotFound')
      || m.includes('NoSuchUser') || m.includes('5.1.1')
      || m.includes('Address not found') || m.includes('does not exist')
      || m.includes('Recipient not found') || m.includes('5.1.10')
      || m.includes('No Such User') || m.includes('5.1.351')
      || m.includes('Recipient unknown') || m.includes('unknown recipient')
      || m.includes('mailbox unavailable') || m.includes('User unknown')
      || m.includes('Invalid Recipient')
      || m.includes('unable to find the recipient domain')
      || m.includes('No mailbox by that name'),
    explain: 'The address is dead. A data-quality problem — it says nothing '
      + 'about the health of the mailbox that sent it.',
  },
  {
    key: 'inactive_mailbox',
    label: 'Recipient mailbox inactive',
    action: 'suppress_lead',
    match: (m) => m.includes('DisabledUser') || m.includes('5.2.1')
      || m.includes('is inactive') || m.includes('account is disabled'),
    explain: 'The recipient account exists but is switched off. Data quality.',
  },
  {
    key: 'recipient_side',
    label: 'Recipient-side, no action',
    action: 'none',
    match: (m) => m.includes('mailbox full') || m.includes('QuotaExceeded')
      || m.includes('TRANSPORT.RULES') || m.includes('5.7.520')
      || m.includes('SenderNotAuthenticatedForGroup')
      || m.includes('SenderNotAuthenticatedForMailbox')
      || m.includes('Hop count exceeded') || m.includes('5.4.300')
      || m.includes('5.2.2')
      // Their group membership rules, their forwarding setup, their admin
      // policy, or their server simply not answering.
      || m.includes('5.7.193') || m.includes('UnifiedGroupAgent')
      || m.includes("isn't a group member")
      || m.includes('5.7.360') || m.includes('administrative policy')
      || m.includes('Administrative prohibition')
      || m.includes("couldn't be forwarded")
      || m.includes('Connection timed out') || m.includes('Command rejected')
      // Temporary and capacity failures at their end, plus their own local
      // policies and geo restrictions.
      || m.includes('Delivery incomplete') || m.includes('temporary problem')
      || m.includes('out of storage space') || m.includes('OverQuota')
      || m.includes('Quota exceeded') || m.includes('mailbox for user is full')
      || m.includes('Delivery has failed to these recipients')
      || m.includes('no mail-enabled')
      || m.includes('local policy') || m.includes('geoip restriction')
      || m.includes('delivery requirements')
      || m.includes('RestrictedToRecipientsPermission')
      || m.includes('5.7.129') || m.includes(':blocked)'),
    explain: 'Their mailbox, their org policy, or their server not answering. '
      + 'Nothing on our side to change.',
  },
];

const UNKNOWN = {
  key: 'unknown', label: 'Unclassified', action: 'none',
  explain: 'No rule matched this bounce text. Worth reading — an unclassified '
    + 'bounce that recurs is a missing rule, not a non-event.',
};

/** Classify one bounce message. Returns a CAUSES entry, or UNKNOWN. */
function classify(bounceMsg) {
  const m = String(bounceMsg || '');
  if (!m.trim()) return UNKNOWN;
  for (const c of CAUSES) if (c.match(m)) return c;
  return UNKNOWN;
}

/** The leading SMTP enhanced status code, for grouping. */
function statusCode(bounceMsg) {
  const m = String(bounceMsg || '').match(/[45]\.\d\.\d+/);
  return m ? m[0] : null;
}

/**
 * The domain a blocklist bounce names.
 *
 * Blocklist rejections quote the LISTED domain, which is not always the
 * mailbox's own domain — the listing is on a URL inside the email, so it is
 * usually the link target. Attributing it to the sending domain would blame
 * the wrong thing and retire a healthy domain.
 *
 * Providers space the domain out to stop it being clickable
 * ("shirebusinessrecovery . co . uk"), so the spaces are stripped back.
 */
function listedDomain(bounceMsg) {
  const m = String(bounceMsg || '');
  const patterns = [
    /URL in this email \(([^)]+)\)/i,          // SURBL / Spamhaus wording
    /([a-z0-9.\- ]+?)\s+blocked using/i,       // "x.co.uk blocked using Spamhaus DBL"
  ];
  for (const re of patterns) {
    const hit = m.match(re);
    if (hit) {
      const d = hit[1].replace(/\s+/g, '').toLowerCase();
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return d;
    }
  }
  return null;
}

/**
 * Actions that mean "our sending is the problem". Only these should ever
 * change a mailbox's volume.
 *
 * This matters concretely: an earlier volume rule keyed on total bounce rate
 * paused three mailboxes whose only bounces were dead recipient addresses.
 * Splitting on cause excludes them automatically.
 */
const SENDING_FAULTS = new Set(['reduce_volume', 'retire_domain', 'fix_dns', 'fix_content']);

function isSendingFault(cause) {
  return SENDING_FAULTS.has(cause.action);
}

module.exports = { classify, statusCode, listedDomain, isSendingFault, CAUSES, UNKNOWN };
