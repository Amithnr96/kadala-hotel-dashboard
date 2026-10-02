# Kadala Hotel shared dashboard

The Node server protects the dashboard and all records with database-backed owner/staff sessions. PostgreSQL stores password hashes, sessions, accounts and daily records. The original `index.html` is the legacy browser-only dashboard, retained for safe migration until the new service is ready; the server serves `shared.html` after authentication.

## Deploy

- Node 22 or later; `npm ci --omit=dev`; start with `npm start`.
- Set `DATABASE_URL` to a PostgreSQL connection string using verified TLS for external connections. Neon Free is supported.
- Set `APP_ORIGIN` to the exact HTTPS service origin, without a trailing slash.
- Set `NODE_ENV=production` and a cryptographically random `SETUP_TOKEN` of at least 32 characters.
- Use `/healthz` for health checks. It does not keep a sleeping database awake.
- The server initializes its tables on startup. It never logs credentials or records.
- Open `/setup#<SETUP_TOKEN>` privately and choose the owner username/password. Remove `SETUP_TOKEN` from hosting settings after setup. Only one owner is allowed, even if the token remains configured.
- The owner creates staff invitations through **Manage staff**. Staff choose their own passwords using one-time links that expire after 24 hours. Disabling or re-inviting a staff account revokes existing sessions.
- Passwords require 12–128 characters and are hashed with scrypt. Sessions expire after 12 hours. All writes require same-origin requests and an authenticated CSRF token (except login/activation, which require same-origin requests).

## Migration and use

Back up records with **Backup JSON** on the original site using the browser where they were entered. In the new site, sign in as owner and use **Import JSON (add missing dates)**. Imports add dates that are not yet present and never overwrite existing shared dates. If records exist on several devices, reconcile overlapping dates before importing.

Both owner and staff can view/edit the same data. Use **Refresh records** to retrieve other users' changes. The server rejects edits based on an old revision; refresh downloads pending changes before loading the current records. Changes are not silently overwritten. JSON backups contain all loaded months; CSV exports contain the selected month.

The server stores records in PostgreSQL, not localStorage or an ephemeral hosting filesystem. Existing browser data is left untouched during migration. Free hosting plans have quotas and may sleep; no paid upgrades are configured by this application.

## Tests

`npm ci` then `npm test`. Tests use an isolated embedded PostgreSQL instance and HTTP requests to verify authentication, CSRF, account roles, staff invitations/revocation, shared records, import safety and conflicting edits. No production data or credentials are used.
