# backyard-calendar

Backyard Sports content calendar. `index.html` is the whole app; its data lives in a
Google Sheet behind an Apps Script web app (`BACKEND_URL` in `index.html`).

## Daily backup

Every day at 09:00 UTC, Vercel Cron calls `api/backup.js` (schedule in `vercel.json`). It
reads all events and categories from the Apps Script (the same request the calendar makes
on load) and saves them to Vercel Blob as `backups/YYYY-MM-DD.json`. Backups are private
and kept for 30 days (`RETENTION_DAYS` in `api/backup.js`). The Apps Script doesn't change.
To bring one back, see [Restoring](#restoring).

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

## Restoring

First pick the right tool:

- **A recent mistake** (an event deleted or edited by accident today or yesterday): use the
  Sheet's **File → Version history**. It goes back edit by edit and needs no script.
- **A bigger loss** (rows wiped, the Sheet overwritten, the script writing bad data): restore
  a daily backup with `scripts/restore.mjs`, below. Anything changed after that backup's
  time (09:00 UTC) is lost, so check Version history for the latest edits afterwards.

The restore goes through the same Apps Script actions the calendar uses, so the script
doesn't change. The Sheet ends up exactly like the backup: missing or changed events and
categories are written back, and those not in the backup are deleted.

1. **Download the backup**: Vercel → Storage → the Blob store → Browser → `backups/` →
   the day's file → Download. Needs Node.js 18 or newer.
2. **Dry run** (only reads the Sheet, changes nothing) and check the counts make sense:
   ```sh
   node scripts/restore.mjs ~/Downloads/2026-11-17.json --to <Apps Script /exec URL>
   ```
3. **Restore**: the same command with `--apply`. For the live calendar (the `BACKEND_URL`
   in `index.html`) it also needs `--production`, so a restore meant for a copy can't land
   on the real calendar by mistake:
   ```sh
   node scripts/restore.mjs ~/Downloads/2026-11-17.json --to <URL> --apply --production
   ```
   It sends one change at a time (a full restore of ~370 events takes a few minutes), then
   reads the Sheet again and only reports `Done` once it matches the backup.
4. Reload the calendar page.

### Testing a restore on a copy

Before relying on it (or after changing the Apps Script), test on a copy so the live
calendar isn't touched:

1. In the Sheet, **File → Make a copy** (the Apps Script is copied with it). Make it right
   before testing: a copy doesn't follow the live Sheet, and an old one can miss columns the
   backup has (the script then stops and says which).
2. In the copy, **Extensions → Apps Script → Deploy → New deployment → Web app**, execute as
   *Me*, access *Anyone*. Copy the `/exec` URL.
3. Change or delete a few rows in the copy, then run the dry run and `--apply` against that
   URL. The dry run should list exactly those changes, and the restore should end in `Done`.
4. Delete the copy afterwards, or at least archive its deployment (Deploy → Manage
   deployments): while deployed, anyone with its URL can read and change that data.

## Cost

Well within what every Vercel plan includes: one cron run of a second or two per day (Hobby allows daily
crons, run at some point within the scheduled hour) and about 30 small JSON files in Blob.
