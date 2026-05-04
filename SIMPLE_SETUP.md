# Ottaly Automation Setup

This adds an Apollo to verification to PlusVibe automation runner without changing the existing dashboard pages.

## Files Added

- `simple-pipeline.js` runs the automation.
- `automation.html` is a separate admin-only launcher page.
- `.env.example` lists the environment variables to set in EasyPanel.

## Environment Variables

Set these in EasyPanel for the app:

```bash
APOLLO_EMAIL=
APOLLO_PASSWORD=
PLUSVIBE_KEY=
VERIFIER_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=
HEADLESS=true
APOLLO_SCRAPE_PAGES=100
```

Optional browser-only proxy/VPN endpoint:

```bash
PROXY_SERVER=
PROXY_USERNAME=
PROXY_PASSWORD=
```

Use this only for the automation browser. Do not route the whole dashboard container through a VPN unless you also configure inbound routing carefully.

For per-client PlusVibe keys, add an optional variable using the workspace id:

```bash
PV_KEY_6912DDFEF9582848982B9A62=
```

If no per-client key exists, the runner uses `PLUSVIBE_KEY`.

## Run From Command Line

```bash
node simple-pipeline.js --url "https://app.apollo.io/people?personTitles=ACCOUNTANT&countries=GB" --workspace-id "6912ddfef9582848982b9a62" --workspace-name "AccrueAccounting"
```

Test without touching Apollo or PlusVibe:

```bash
node simple-pipeline.js --url "https://app.apollo.io/people?personTitles=ACCOUNTANT&countries=GB" --workspace-id "test" --workspace-name "Test" --dry-run
```

## Run From Dashboard

Open:

```text
/automation.html
```

Log in as admin, paste the Apollo URL, choose a client, and click `Run Pipeline`.

## Logs

Run logs are written to:

```text
automation-runs/
```

Downloaded temporary CSV files are written to:

```text
downloads/
```

Both folders are ignored by git.

## Notes

Apollo UI selectors may need one calibration pass against the live Apollo account because Apollo button labels can differ by account, extension, and page version. The runner is written so those selectors are isolated in `simple-pipeline.js`.
