# Email Finder Local

Local Node app for dropping in a contacts CSV, generating likely company email patterns, optionally probing them through SMTP, and downloading an enriched CSV.

## Run

```bash
cd email-finder-local
npm start
```

Open `http://localhost:5050`.

## CSV workflow

1. Drop a `.csv` file into the upload box.
2. Leave "Verify with SMTP" on to try mailbox probing, or turn it off for fast permutation-only output.
3. Click "Add To Queue".
4. Wait for the job to complete.
5. Download the enriched CSV.

The output preserves every original column and appends:

- `FoundEmail`
- `BestGuessEmail`
- `EmailFinderStatus`
- `EmailFinderConfidence`

`FoundEmail` is filled when the selected address is usable for the selected mode. In SMTP mode, unknown or catch-all results leave `FoundEmail` blank and put the top generated permutation in `BestGuessEmail` instead.

Expected input columns:

- `FirstName`
- `LastName`
- `OrganizationWebsiteUrl`

## Settings

Environment variables:

```bash
PORT=5050
SMTP_SENDER=
SMTP_TIMEOUT_MS=10000
CHECK_DELAY_MS=0
MAX_CANDIDATES=12
MAX_CONTACTS=10000
VERIFY_CANDIDATES=12
ROW_CONCURRENCY=3
CANDIDATE_CONCURRENCY=2
SMTP_RETRIES=1
CHECK_CATCH_ALL=false
DEFAULT_VERIFIER=reacher
REACHER_URL=http://127.0.0.1:8080
REACHER_API_KEY=
REACHER_FROM_EMAIL=
REACHER_HELLO_NAME=
REACHER_TIMEOUT_MS=60000
REACHER_TEST_EMAIL=jesse@ottaly.co.uk
```

For SMTP runs, `VERIFY_CANDIDATES` controls how many generated email patterns are tested per contact. By default it matches `MAX_CANDIDATES`, so all 12 standard permutations are tested. `ROW_CONCURRENCY` controls how many contacts are processed at once, and `CANDIDATE_CONCURRENCY` controls how many permutations are tested at the same time for each contact.

The default profile follows the original email-finder/email-existence style more closely: all 12 permutations, candidate concurrency of 2, no catch-all pre-check, and the candidate email as the default SMTP sender. It uses up to roughly `3 x 2 = 6` active SMTP checks, with one retry for timeout/socket-close unknowns.

For production, Reacher is the preferred verifier. Set `REACHER_URL` to your Reacher instance and leave `DEFAULT_VERIFIER=reacher`. The app will generate all permutations, send them to Reacher, and fill `FoundEmail` only when Reacher returns `safe`.

The app uses the machine's current network route. If Surfshark is active system-wide, the SMTP checks and IP display should reflect that route.

Some networks block outbound port 25, and many mail providers use catch-all or anti-enumeration behavior, so SMTP results can be `unknown` even for real addresses.
