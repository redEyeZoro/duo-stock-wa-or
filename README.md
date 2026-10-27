# iPhone Duo stock — Washington and Oregon

Adapted from [giuseppi/duo-stock](https://github.com/giuseppi/duo-stock), source revision `4496132`.
Watches **iPhone Duo 256GB Night Sky**, US part **MK1F4LL/A**, for online Apple Store pickup.

| Store | City | Apple store ID |
| --- | --- | --- |
| Bellevue Square | Bellevue, WA | R003 |
| Alderwood | Lynnwood, WA | R100 |
| University Village | Seattle, WA | R072 |
| River Park Square | Spokane, WA | R420 |
| Tacoma Mall | Tacoma, WA | R339 |
| Southcenter | Tukwila, WA | R106 |
| Pioneer Place | Portland, OR | R077 |

## Start locally — no GitHub connection needed

Use Node.js 24. There are no npm dependencies and no install step.
From this source directory:

```sh
node --test
node local-check.js
```

`local-check.js` performs one read-only stock check and exits. It does not send notifications,
connect to GitHub, make a purchase, or start a timer. `--json` prints machine-readable output;
`--save` additionally writes `status.json` for the dashboard. Exit codes: 0 for full coverage,
2 for partial coverage, 1 for a failed check.

To preview the dashboard, run `node local-check.js --save`, then serve this directory through
a local HTTP server and open `index.html`. A saved local snapshot has no restock history and
will become stale unless you run another check. The page's refresh only reads the saved JSON.

## Configuration and coverage

Edit **config.js** for the product, purchase link, primary ZIP, and store IDs.
The primary search uses Bellevue ZIP 98004. It returned all seven stores when verified on
October 27, 2026. If a target remains unknown, the checker tries its configured regional ZIP
(Spokane 99201, Tacoma 98409, Portland 97204), at most once per ZIP per check.
Stores are matched by ID. Missing stores, missing parts, and unrecognized availability values
stay **unknown**, rather than being reported as sold out. Valid partial results can still alert.
The dashboard shows coverage and distinguishes old availability from current results.
Distances, when present, refer to the Bellevue search, not the user's current location.

## Optional unattended checks on your own GitHub repository

Deployment instructions for this repository or a copy:

1. Create your own repository and push this source, including the fresh `state.json`.
2. Set Pages > Source to **GitHub Actions** before running the workflow.
3. Add the repository Actions secret `NTFY_TOPIC`. Use a long random topic and subscribe to
   it in the ntfy app. Anyone who knows an unprotected topic can read/send notifications.
   Never commit the topic or tokens. Do not put them in chat.
4. Run **Check iPhone Duo stock** manually, then verify the Pages dashboard and an end-to-end
   notification on your device. The scheduled workflow runs approximately every five minutes;
   it can be delayed, so this is not a guaranteed five-minute service.

The workflow uses Node 24, runs tests, performs a stock check, and publishes Pages.
It writes shared history and pending notifications to `state.json` using the GitHub contents API.
It requires contents write access; Pages publishing has separate pages/id-token permissions.
`GITHUB_REPOSITORY` and `GITHUB_TOKEN` are supplied by Actions. The state branch is `main`.
Public repositories and Pages expose stock history/configuration, never the notification topic.
A private repository's Actions/Pages availability depends on your GitHub plan.

GitHub can disable scheduled public-repository workflows after 60 days of inactivity.
If more precise triggering is needed later, an outside scheduler can dispatch this workflow;
that requires additional setup and an appropriately scoped token. It is not configured here.

## Optional laptop watcher

```sh
node duo-watch.js --no-test
```

Set `NTFY_TOPIC` in the environment to enable pushes. Without it, alerts print to the terminal.
Omit `--no-test` to send a startup test notification. This command keeps running until Ctrl-C;
the computer must remain awake and connected. `INTERVAL_SEC` defaults to 120 and must be at
least 60. Requests have timeouts; Apple blocking causes increasing delays plus random jitter.

In a Git clone of **your own** repository, an installed/authenticated `gh` CLI lets the laptop
share the GitHub record. Without GitHub, it uses memory: restarting may repeat an alert, and
local observations are not persisted as history. The downloaded archive has no Git remote.
Both the Actions checker and laptop watcher must use this adapted version with state format 3.
Do not run the upstream watcher against the new record.

`DUO_EXTRA_HEADERS` can supply request headers as JSON if required for troubleshooting Apple
blocking. Browser headers may contain account cookies; keep them out of source and logs.
The live local check succeeded without sign-in cookies during adaptation.

## Delivery behavior and limits

- Newly detected stock is saved as a pending notification before delivery.
- A three-minute lease lets one healthy runner send. If it crashes, a later check retries
  after expiry, but only when the latest result still confirms availability.
- Successful sends clear their pending entries; failed sends release the lease for retry.
  A failed acknowledgement can cause a duplicate push. Delivery is not exactly once, and
  ntfy accepting a message does not prove it reached the phone.
- Unknown stock preserves history and pending work. A confirmed sellout prevents a stale
  alert from being sent. If a previously undelivered opportunity returns, it can be retried.
- As in upstream, an already-announced restock that disappears and returns within ten minutes
  counts as the same event and does not send another alert. This is a noise-reduction tradeoff.
- The Actions checker warns after six consecutive failed or incomplete checks. Complete
  coverage resets that streak. Laptop-only operation logs incomplete coverage; its push
  health warning covers repeated Apple blocking.
- History counts observed restock events, not phones. Pickup availability is not a reservation
  or a promise of walk-in stock. Checkout still happens on Apple.

## Code map

`config.js` — product and stores.
`duo.js` — Apple requests, normalization, coverage, ntfy delivery.
`local-check.js` — standalone read-only query.
`record.js` — restock history and state migration.
`delivery.js` — pending notification leases and acknowledgements.
`notebook.js` — GitHub read/write coordination using file SHAs.
`check.js` — single Actions run and dashboard data.
`duo-watch.js` — repeating laptop watcher, with an in-memory fallback.
`history.js` / `index.html` — history summaries and dashboard.
`tests/` — mocked network tests; they never send real notifications or write to GitHub.

The original author's California history was cleared for this adaptation. Version 1/2 state
can migrate to version 3 without replaying already-announced stock; unknown formats fail
without overwriting the record. Historical upstream design notes remain in `project-docs/`.
