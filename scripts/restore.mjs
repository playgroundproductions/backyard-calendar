#!/usr/bin/env node
/**
 * Restores a calendar backup (backups/YYYY-MM-DD.json from Vercel Blob) into a calendar
 * Sheet, through the same Apps Script actions the calendar page uses. See README → Restoring.
 *
 *   node scripts/restore.mjs <backup.json> --to <Apps Script /exec URL>            # dry run
 *   node scripts/restore.mjs <backup.json> --to <Apps Script /exec URL> --apply    # restore
 *
 * The dry run only reads the Sheet and lists what would change. With --apply, the Sheet ends
 * up exactly like the backup: missing or changed categories and events are written back,
 * and events (then categories) that aren't in the backup are deleted.
 *
 * The live calendar's URL also needs --production, so a restore meant for a test copy can't
 * land on the real calendar by mistake.
 */
import { readFile } from 'node:fs/promises'

// Same URL as BACKEND_URL in index.html
const PRODUCTION_URL =
  'https://script.google.com/macros/s/AKfycbzoACEpOw_kctpbUkUbb8mPR7gMS1Otjf7ck6aSdlkTt41YKMpMckbOBe4Xuiw_xwpynw/exec'
const EVENT_FIELDS = ['id', 'title', 'date', 'categoryId', 'description', 'url', 'status']
const CATEGORY_FIELDS = ['id', 'name', 'color']

const USAGE = `Usage: node scripts/restore.mjs <backup.json> --to <Apps Script /exec URL> [--apply] [--production]`

function parseArgs(argv) {
  const args = { file: null, to: null, apply: false, production: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--to') args.to = argv[++i]
    else if (arg === '--apply') args.apply = true
    else if (arg === '--production') args.production = true
    else if (arg === '--help' || arg === '-h') return null
    else if (!arg.startsWith('--') && !args.file) args.file = arg
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!args.file || !args.to) return null
  return args
}

const isCalendarData = (data) => Array.isArray(data?.events) && Array.isArray(data?.categories)

/** Only the fields the Sheet stores, as strings, so a row reads the same however it was saved */
function pick(record, fields) {
  return Object.fromEntries(fields.map((field) => [field, String(record[field] ?? '')]))
}

const sameRecord = (a, b, fields) => fields.every((field) => a[field] === b[field])

/** Fields the backup's records have that none of the Sheet's records come back with */
function missingFields(wanted, current, fields) {
  if (!current.length) return []
  return fields.filter(
    (field) =>
      wanted.some((record) => field in record) && !current.some((record) => field in record),
  )
}

/** What turns `current` into `wanted`: records to write (new or changed) and ids to delete */
export function diff(wanted, current, fields) {
  const currentById = new Map(current.map((record) => [record.id, pick(record, fields)]))
  const wantedIds = new Set(wanted.map((record) => String(record.id)))
  const toAdd = []
  const toUpdate = []
  for (const record of wanted.map((r) => pick(r, fields))) {
    const existing = currentById.get(record.id)
    if (!existing) toAdd.push(record)
    else if (!sameRecord(record, existing, fields)) toUpdate.push(record)
  }
  const toDelete = [...currentById.keys()].filter((id) => !wantedIds.has(id))
  return { toAdd, toUpdate, toDelete }
}

async function readSheet(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`The Apps Script answered ${response.status}`)
  const data = await response.json().catch(() => null)
  if (!isCalendarData(data)) throw new Error('The Apps Script did not answer with calendar data')
  return data
}

/** One action at a time (as the calendar page sends them), retried once if it fails */
async function send(url, action, payload) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...payload }),
      })
      if (!response.ok) throw new Error(`answered ${response.status}`)
      const text = await response.text()
      // The script answers JSON; an { error } means the action didn't go through
      const answer = (() => {
        try {
          return JSON.parse(text)
        } catch {
          return null
        }
      })()
      if (answer?.error) throw new Error(String(answer.error))
      return
    } catch (error) {
      if (attempt === 2) throw new Error(`${action} failed: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

function describe(label, { toAdd, toUpdate, toDelete }) {
  return `${label}: ${toAdd.length} to recreate, ${toUpdate.length} to change back, ${toDelete.length} to delete`
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`)
    process.exit(1)
  }
  if (!args) {
    console.error(USAGE)
    process.exit(1)
  }

  const backup = JSON.parse(await readFile(args.file, 'utf8'))
  if (!isCalendarData(backup)) throw new Error(`${args.file} is not a calendar backup`)
  if (!backup.categories.length) throw new Error('The backup has no categories, refusing to restore it')

  const isProduction = args.to.trim() === PRODUCTION_URL
  if (args.apply && isProduction && !args.production) {
    throw new Error('This is the live calendar. Add --production to restore into it.')
  }

  console.log(`Backup: ${args.file} (${backup.createdAt ?? 'no date'}) — ${backup.events.length} events, ${backup.categories.length} categories`)
  console.log(`Target: ${isProduction ? 'LIVE calendar' : 'a copy'} (${args.to})`)

  const current = await readSheet(args.to)
  console.log(`Now in the Sheet: ${current.events.length} events, ${current.categories.length} categories\n`)

  // A Sheet whose Apps Script is older than the backup (e.g. a copy made before a column was
  // added) can't store every field: the restore would silently drop them, so stop here
  const missing = [
    ...missingFields(backup.events, current.events, EVENT_FIELDS).map((f) => `events.${f}`),
    ...missingFields(backup.categories, current.categories, CATEGORY_FIELDS).map(
      (f) => `categories.${f}`,
    ),
  ]
  if (missing.length) {
    throw new Error(
      `The target Sheet doesn't return ${missing.join(', ')}, which the backup has. Its Apps ` +
        'Script (or columns) are probably older than the live calendar\'s: make a new copy, ' +
        'or update its script and columns first.',
    )
  }

  const categories = diff(backup.categories, current.categories, CATEGORY_FIELDS)
  const events = diff(backup.events, current.events, EVENT_FIELDS)
  console.log(describe('Categories', categories))
  console.log(describe('Events', events))

  const total =
    categories.toAdd.length + categories.toUpdate.length + categories.toDelete.length +
    events.toAdd.length + events.toUpdate.length + events.toDelete.length
  if (!total) {
    console.log('\nThe Sheet already matches the backup. Nothing to do.')
    return
  }
  if (!args.apply) {
    for (const event of events.toDelete.slice(0, 10)) console.log(`  would delete event ${event}`)
    if (events.toDelete.length > 10) console.log(`  … and ${events.toDelete.length - 10} more`)
    console.log('\nDry run: nothing was changed. Run again with --apply to restore.')
    return
  }

  // Categories first, so restored events point at categories that exist; categories that
  // aren't in the backup go last, once no restored event uses them
  const steps = [
    ...[...categories.toAdd, ...categories.toUpdate].map((category) => ['updateCategory', { category }]),
    ...[...events.toAdd, ...events.toUpdate].map((event) => ['updateEvent', { event }]),
    ...events.toDelete.map((id) => ['deleteEvent', { id }]),
    ...categories.toDelete.map((id) => [
      'deleteCategory',
      { id, fallbackId: backup.categories[0].id },
    ]),
  ]
  console.log(`\nRestoring (${steps.length} changes)…`)
  for (const [i, [action, payload]] of steps.entries()) {
    await send(args.to, action, payload)
    if ((i + 1) % 25 === 0 || i + 1 === steps.length) console.log(`  ${i + 1}/${steps.length}`)
  }

  // Read the Sheet again: the restore only counts once it matches the backup
  const after = await readSheet(args.to)
  const left = [
    diff(backup.categories, after.categories, CATEGORY_FIELDS),
    diff(backup.events, after.events, EVENT_FIELDS),
  ].reduce((sum, d) => sum + d.toAdd.length + d.toUpdate.length + d.toDelete.length, 0)
  if (left) throw new Error(`Restored, but ${left} differences remain. Run it again, or check the Sheet.`)
  console.log(`\nDone: the Sheet matches the backup (${after.events.length} events, ${after.categories.length} categories).`)
}

// Runs from the command line; importing the file (tests) only gets diff()
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nRestore failed: ${error.message}`)
    process.exit(1)
  })
}
