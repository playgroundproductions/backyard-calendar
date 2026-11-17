import { del, list, put } from '@vercel/blob'

/**
 * Daily backup of the calendar (Vercel Cron, see vercel.json).
 *
 * Reads everything from the Apps Script backend (the same GET the calendar makes on load)
 * and saves it to Vercel Blob as backups/YYYY-MM-DD.json, private. Backups older than
 * RETENTION_DAYS are then deleted. Running it twice on the same day replaces that day's file.
 *
 * Only Vercel Cron (or someone with CRON_SECRET) can run it:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<calendar domain>/api/backup
 */

// Same URL as BACKEND_URL in index.html
const BACKEND_URL =
  'https://script.google.com/macros/s/AKfycbzoACEpOw_kctpbUkUbb8mPR7gMS1Otjf7ck6aSdlkTt41YKMpMckbOBe4Xuiw_xwpynw/exec'
const PREFIX = 'backups/'
const RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export async function GET(request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let data
  try {
    const response = await fetch(BACKEND_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Apps Script answered ${response.status}`)
    data = await response.json()
  } catch (error) {
    console.error('Backup failed: could not read the calendar', error)
    return Response.json({ error: 'Could not read the calendar' }, { status: 502 })
  }

  // An error page or an { error } answer from the script must not be saved as a backup
  if (!Array.isArray(data?.events) || !Array.isArray(data?.categories)) {
    console.error('Backup failed: unexpected answer from the calendar', data)
    return Response.json({ error: 'Unexpected answer from the calendar' }, { status: 502 })
  }

  const now = new Date()
  const pathname = `${PREFIX}${now.toISOString().slice(0, 10)}.json`
  const backup = {
    createdAt: now.toISOString(),
    events: data.events,
    categories: data.categories,
  }
  await put(pathname, JSON.stringify(backup, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })

  // Only after today's backup is saved, so a failed run never leaves fewer backups behind
  const deleted = await deleteOldBackups(now)

  console.log(
    `Backup saved: ${pathname} (${backup.events.length} events, ${backup.categories.length} categories); deleted ${deleted.length} old backups`,
  )
  return Response.json({
    saved: pathname,
    events: backup.events.length,
    categories: backup.categories.length,
    deleted,
  })
}

/** Deletes the backups whose date (from the file name) is older than RETENTION_DAYS */
async function deleteOldBackups(now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10)
  const old = []
  let cursor
  do {
    const page = await list({ prefix: PREFIX, cursor })
    for (const blob of page.blobs) {
      const date = blob.pathname.slice(PREFIX.length, PREFIX.length + 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) old.push(blob)
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  if (old.length) await del(old.map((blob) => blob.url))
  return old.map((blob) => blob.pathname)
}
