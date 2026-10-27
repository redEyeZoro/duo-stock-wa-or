# duo-stock — local Washington/Oregon adaptation

Setup and behavior: README.md. Product and stores: config.js.

- Adapted from giuseppi/duo-stock revision 4496132. No npm dependencies; Node 24.
- No credentials in source, JSON output, or logs. NTFY_TOPIC comes from a secret/env variable.
- `node local-check.js` is read-only, does not notify, and needs no GitHub login.
- Stores are matched by Apple's storeNumber. Missing/unrecognized availability is unknown.
- Use /shop/retail/pickup-message; regional fallback queries fill gaps in the Bellevue response.
- `record.js` holds stock history; `delivery.js` holds persisted notification work and leases.
- State is version 3. Old v1/v2 records migrate; unknown/malformed formats must never be wiped.
- Both shared-state runners must use the adapted version. Pending delivery expires after three
  minutes and retries only when current stock is available. Acknowledgement loss can duplicate.
- `notebook.js` coordinates writes through GitHub contents API SHA compare-and-swap.
- Only state.json is committed by the bot; status.json is generated and published to Pages.
- Run `node --test` before publishing. Tests mock Apple, GitHub, and ntfy.
- Workflow actions remain pinned to upstream commit SHAs; update SHA and version comment together.
- Upstream project-docs are historical context; README.md describes the current adaptation.
