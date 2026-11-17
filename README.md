# backyard-calendar

Backyard Sports content calendar. `index.html` is the whole app; its data lives in a
Google Sheet behind an Apps Script web app (`BACKEND_URL` in `index.html`).

## Daily backup

Every day at 09:00 UTC, Vercel Cron calls `api/backup.js` (schedule in `vercel.json`). It
reads all events and categories from the Apps Script (the same request the calendar makes
on load) and saves them to Vercel Blob as `backups/YYYY-MM-DD.json`. Backups are private
and kept for 30 days. The Apps Script doesn't change.

A backup is a snapshot of that moment, not of every change. For a recent mistake, the
Sheet's own **File → Version history** goes back edit by edit.

### Setup (once, in the Vercel project)

1. **Storage → Create Database → Blob**, with **Private** access, connected to this project
   (store `backyard-calendar-backups`). That adds `BLOB_STORE_ID`, and the function signs in
   with Vercel's short-lived OIDC token, so no read-write token is needed. Only if the log
   shows `No blob credentials found` (OIDC turned off for the project): add a read-write
   token to the connection, which the function then uses instead.
2. **Settings → Environment Variables**: add `CRON_SECRET` (Production) with a random value,
   e.g. from `openssl rand -hex 32`. Vercel Cron sends it on every call; without it the
   function refuses to run.
3. Deploy. **Settings → Cron Jobs** lists the job once it's in production.

### Checking it

- **Settings → Cron Jobs → Run** runs it right away. The log (Logs, filtered by
  `/api/backup`) shows `Backup saved: backups/… (N events, N categories)`.
- The files are under **Storage → (the Blob store) → Browser → backups/**, and can be
  downloaded from there.
- A failed run (the Apps Script down or answering an error) logs `Backup failed` and saves
  nothing, so it never replaces a good backup or deletes the old ones.

### Cost

Well within what every Vercel plan includes: one cron run of a second or two per day (Hobby allows daily
crons, run at some point within the scheduled hour) and about 30 small JSON files in Blob.
