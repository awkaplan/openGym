/* opengym-mcp state — reads ./data/state-<uid>.json + db.json (read-only), and writes plan
   changes back to the same state file (atomic temp+rename, same pattern as the openGym api).
   MCP-owned metadata (deload snapshots, pre-write backups) lives in a separate
   state-<uid>.mcp.json the app never touches, so an app write cannot wipe it.
   Cached with an fs.watch + mtime fallback so a session the api server just wrote is
   visible on the next tool call without a restart. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// The server's own stamping of a write from a client that does not stamp its edits (what an
// API planner is). Same module PUT /api/data runs, so an MCP write is recorded the same way.
import { stampPut } from '../../api/sync-stamps.js'

const DATA_DIR = process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')

// null = no state file (brand-new account); undefined = not yet loaded.
let _state = undefined
let _db = undefined
let _uid = null
let _watcher = null
let _loadedMtime = 0    // mtimeMs we last read at — used to catch watcher omissions

// Write support. _testMode: seeded tests mutate in-memory state only — no disk I/O, no
// metadata file — so the suite stays fast and isolated. _writeQueue serialises concurrent
// async handlers (Node is single-threaded, but two tool calls can interleave at await points).
let _testMode = false
let _writeQueue = Promise.resolve()
const WID_KEEP = 50   // same as api/server.js
let _meta = undefined   // cached metadata object ({ deloads, backups })

// null means one thing only: the file is not there (an account that never synced from a device).
// Every other failure — no permission on the mount, a truncated or corrupt file — is a real fault,
// and reporting it as "no synced state yet, sign in from a device" sends the operator to fix the
// wrong thing while the data sits there unreadable.
function readJsonOrNull(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    // Node's own message repeats the path it was given, and that is the server's absolute path:
    // the basename identifies the file just as well.
    const base = path.basename(file)
    const err = new Error(`cannot read ${base}: ${e.code || e.name} — ${String(e.message).replaceAll(file, base)}`)
    err.code = 'EIO'
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`${path.basename(file)} is not valid JSON: ${e.message}`)
    err.code = 'EIO'
    throw err
  }
}

function reloadDb() { _db = readJsonOrNull(path.join(DATA_DIR, 'db.json')) || { users: [], creds: [], subs: [], invites: [] } }

function stateFile(uid) {
  return path.join(DATA_DIR, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
}

// Pick the uid: OPENGYM_UID env, else the only state-* file, else the only user in db.json.
// Throws listing the options if ambiguous. The sanitiser on stateFile() keeps a sneaky
// '..' in OPENGYM_UID harmless.
function resolveUid() {
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envUid)) throw new Error(`OPENGYM_UID contains characters that aren't safe in a filename: ${JSON.stringify(envUid)}`)
    return envUid
  }
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/^state-/, '').replace(/\.json$/, ''))
  if (files.length === 1) return files[0]
  if (files.length === 0) {
    reloadDb()
    if (_db.users.length === 1) return _db.users[0].id
    if (_db.users.length === 0) throw new Error(`no openGym users found in ${path.join(DATA_DIR, 'db.json')} — sign in at least once on a device`)
    // Multiple users in db.json but no state file yet — hit when accounts exist but none has
    // signed in on a device.
    throw ambiguousUid(_db.users.map(u => u.id))
  }
  throw ambiguousUid(files)
}

// "Which profile?" is a config question for the operator, and this message travels as a tool
// result: into the model's context and into whatever transcript it lands in. Every account id on
// the box, plus the server's absolute paths, has no business there. The count and the setting to
// change are what the model can act on; the ids and the path go to the server log on stderr,
// where the operator is already reading the startup line.
function ambiguousUid(ids) {
  console.error(`[opengym-mcp] ${ids.length} openGym profiles in ${DATA_DIR}: ${ids.join(', ')} — set OPENGYM_UID to one of them`)
  const err = new Error(`this openGym data directory holds ${ids.length} profiles — set OPENGYM_UID to the one this server should read (the ids are on the server's stderr, and in db.json under "users"[].id)`)
  err.code = 'EINVAL'
  return err
}

// Idempotent. Picks the uid, loads db.json, attaches the watcher, primes state.
export function init() {
  if (_uid !== null) return
  if (!fs.existsSync(DATA_DIR)) throw new Error(`OPENGYM_DATA dir does not exist: ${DATA_DIR}`)
  _uid = resolveUid()
  reloadDb()
  const file = stateFile(_uid)
  if (fs.existsSync(file)) {
    _state = readJsonOrNull(file)
    if (_state) _state = Object.assign({}, defaultsShape(), _state)
    try { _loadedMtime = fs.statSync(file).mtimeMs } catch {}
  }
  if (_watcher) _watcher.close()
  // fs.watch is best-effort: the api server's atomic write at PUT /api/data is the source of
  // truth, and a stale read just gets corrected on the next change or the next tool call.
  try {
    _watcher = fs.watch(file, () => {
      // On change, simply clear the cache — the next getState() will re-read. Avoids reading
      // twice if the watcher fires multiple events for one atomic-write (rename + create).
      _state = undefined
      _loadedMtime = 0
    })
    // Unref'd, or the watcher alone holds the event loop open and the process outlives the
    // client that spawned it — "exits when the LLM client disconnects" stops being true the
    // moment there is a state file to watch. Most clients kill the child anyway, but one that
    // merely closes the pipe would leak a process per session. Watching is unaffected: the
    // stdio transport is what keeps the loop alive while a client is actually attached.
    _watcher.unref()
  } catch { /* fs.watch unsupported on this platform; tools will re-read on mtime change */ }
}

// Returns the state object, or null for a fresh account that never signed in on a device.
export function getState() {
  init()
  const file = stateFile(_uid)
  // Re-read if the file's mtime changed since our last load — covers watcher omissions and
  // platforms with no fs.watch.
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch {
    return _state === undefined ? null : _state
  }
  if (_state === undefined || mtime !== _loadedMtime) {
    const fresh = readJsonOrNull(file)
    if (fresh) {
      // Same shape the frontend builds on pullState — defaults merged with stored state so any
      // field the app added since the snapshot was last saved shows up undefined-safe.
      _state = Object.assign({}, defaultsShape(), fresh)
      _loadedMtime = mtime
    } else if (_state === undefined) {
      _state = null  // no state file at all — never signed in on a device
    }
  }
  return _state
}

// Returns the user record (id + name). No passkey material, no VAPID keys, no push subs.
export function getUser() {
  init()
  const u = _db.users.find(x => x.id === _uid) || { id: _uid, name: 'Profile', created: null }
  return { id: u.id, name: u.name, created: u.created || null }
}

export const dataDir = () => DATA_DIR

// Test-only: work against a passed-in state, not the disk.
export function _seedStateForTests(state) {
  _testMode = true
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }], creds: [], subs: [], invites: [] }
  _state = state
  _meta = { deloads: {}, backups: [] }
  _loadedMtime = Number.MAX_SAFE_INTEGER   // never re-read from disk in a test
  if (_watcher) { _watcher.close(); _watcher = null }
}

/* ---------- write support ---------- */

function metaFile() {
  return path.join(DATA_DIR, 'state-' + _uid + '.mcp.json')
}

// Atomic write: temp file + rename, the same pattern the openGym api uses for PUT /api/data.
// A reader (the app, another MCP process) never sees a half-written file.
function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

// MCP-owned metadata: deload snapshots + pre-write backups. Lives in its own file because the
// app replaces the whole state file on write — an extra field there would be lost.
function readMeta() {
  if (_meta) return _meta
  const m = readJsonOrNull(metaFile())
  _meta = { deloads: m?.deloads || {}, backups: Array.isArray(m?.backups) ? m.backups : [] }
  return _meta
}

function writeMeta(meta) {
  _meta = meta
  if (_testMode) return
  atomicWrite(metaFile(), JSON.stringify(meta))
}

// Run a state mutation under the write queue. The mutator receives a fresh deep clone of the
// latest state (re-read if the file changed since our last load) and returns the next state.
// Before persisting, the current state is backed up (last 5) into the metadata file so a
// destructive write is rollback-able. Resolves with the persisted state.
export function writeState(mutator) {
  const run = _writeQueue.then(() => {
    const S = getState()
    if (!S) {
      const e = new Error('no synced state yet — sign in at least once from a device so the openGym api can save a state file for this profile')
      e.code = 'ENOSTATE'
      throw e
    }
    // `cur` is the document as the api has it on disk, read fresh (not the cached, defaults-
    // merged S): the revision and the stamps are compared against exactly what the api holds.
    // Reading and renaming below happen with nothing awaited between them, which is the same
    // window PUT /api/data has against another writer.
    const cur = _testMode ? S : (readJsonOrNull(stateFile(_uid)) || S)
    const next = mutator(structuredClone(_testMode ? S : Object.assign({}, defaultsShape(), cur)))
    next._ts = Date.now()
    // Do what PUT /api/data does with a write from a client that does not stamp (v1.4):
    //  - stampPut records what this write removed or changed (`deleted` / `edited`), so another
    //    device that still holds a deleted routine or workout does not bring it back on its
    //    next merge;
    //  - `_rev` moves, so a client polling /api/data/rev reads the change instead of pushing its
    //    own older copy over it (its push would carry the old baseRev and be accepted);
    //  - `_wid` / `_wids` name this write and its ancestors for the same reason.
    const report = {}
    stampPut(cur, next, { overRead: true, stamped: false, report })
    const curRev = cur._rev || 0
    next._rev = report.changed ? curRev + 2 : curRev + 1
    next._wids = [...(Array.isArray(cur._wids) ? cur._wids : []), ...(cur._wid ? [cur._wid] : [])]
      .filter(x => typeof x === 'string').slice(-WID_KEEP)
    next._wid = crypto.randomBytes(8).toString('hex')
    if (!_testMode) {
      const meta = readMeta()
      meta.backups.push({ at: new Date().toISOString(), state: cur })
      if (meta.backups.length > 5) meta.backups = meta.backups.slice(-5)
      writeMeta(meta)
      atomicWrite(stateFile(_uid), JSON.stringify(next))
      _state = Object.assign({}, defaultsShape(), next)
      try { _loadedMtime = fs.statSync(stateFile(_uid)).mtimeMs } catch {}
    } else {
      _state = next
    }
    return next
  })
  // A failed write must not poison the queue for the next caller.
  _writeQueue = run.catch(() => {})
  return run
}

// Run a metadata mutation under the same queue (serialised with state writes). Resolves with
// the updated metadata object.
export function updateMeta(mutator) {
  const run = _writeQueue.then(() => {
    const meta = readMeta()
    const next = mutator(meta)
    writeMeta(next)
    return next
  })
  _writeQueue = run.catch(() => {})
  return run
}

export const _metaForTests = () => readMeta()
export { readMeta, writeMeta }

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}
