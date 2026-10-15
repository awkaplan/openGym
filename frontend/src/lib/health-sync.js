// Health Connect on the Android app (#200): turning it on, and keeping it in step with the log —
// and, with a switch of its own, reading weigh-ins other apps logged there back in.
// What gets written is worked out in lib/health-connect.js; this file owns the native plugin
// (HealthConnectPlugin.java) and the phone's own record of what it wrote.
//
// It is a fact about this phone, not about the training log: kept in its own file in the app's
// data directory, never in S, so it does not sync to a server, ride in a backup, or switch on a
// second phone. Off until the user turns it on; nothing is asked of Health Connect before that.
//
// The web build never gets here (MOBILE is a build-time flag), and iOS answers 'unsupported'.
import { MOBILE, isAndroid, readJsonFile, writeJsonFile } from './mobile.js'
import { healthRecords, planSync, writtenIds, mergeHealthWeights, READ_DAYS } from './health-connect.js'
import { exerciseNameFor } from './i18n-core.js'
import { EXIDX } from './exercises.js'
import { speedUnitOf } from './speed.js'

export const HEALTH_FILE = 'opengym-health.json'
// `read` is the other direction, weigh-ins other apps logged in Health Connect, with a switch of
// its own: `seen` holds the readings already taken ({ [Health Connect id]: time }).
const READ_OFF = { on: false, seen: {}, at: 0, error: null, added: 0 }
const OFF = { on: false, written: {}, at: 0, error: null, read: READ_OFF }
const readOf = h => ({ ...READ_OFF, ...(h?.read && typeof h.read === 'object' ? h.read : {}) })

// Wrapped in an object, as in rest-alert.js: a Capacitor plugin proxy answers `then`, so a
// promise resolved with the bare proxy never settles.
let pluginP = null
const plugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  const { registerPlugin } = await import('@capacitor/core')
  return { HC: registerPlugin('HealthConnect') }
})().catch(() => null))

// The file's content, read once and then kept here: a save while it is off (the usual case) must
// not cost a file read, and every change to it goes through saveHealth anyway.
let cached = null
export async function loadHealth() {
  if (cached) return cached
  const f = await readJsonFile(HEALTH_FILE)
  cached = f && typeof f === 'object' ? { ...OFF, ...f, written: f.written && typeof f.written === 'object' ? f.written : {}, read: readOf(f) } : { ...OFF }
  return cached
}
// One file write at a time, each writing what is newest by its turn: two saves in flight could
// otherwise finish out of order and leave the older content on disk.
let writing = Promise.resolve()
const saveHealth = h => {
  cached = h
  writing = writing.catch(() => {}).then(() => writeJsonFile(HEALTH_FILE, cached))
  return writing
}
// Writing and reading each own their part of the file and run on their own, so each saves only
// its part over what the file holds by then: a copy taken before the other one saved would put
// back what that one just changed.
const patchHealth = async patch => {
  await loadHealth()
  // `cached` as it is now, after the wait: another save may have replaced it meanwhile.
  const out = { ...cached, ...patch }
  await saveHealth(out)
  return out
}

/** { status: 'available' | 'update' | 'missing' | 'unsupported', granted, readGranted } —
 *  `granted` for writing, `readGranted` for reading weigh-ins. */
export async function healthStatus() {
  if (!MOBILE) return { status: 'unsupported', granted: false }
  try {
    const p = await plugin()
    if (!p) return { status: 'unsupported', granted: false }
    return await p.HC.status()
  } catch { return { status: 'unsupported', granted: false } }
}

/** Health Connect's own screen for what apps wrote, or its store page where it is missing. */
export async function openHealthConnect() {
  const p = await plugin()
  if (p) await p.HC.openSettings()
}

const nameOf = e => (EXIDX[e.id] ? exerciseNameFor(EXIDX[e.id]) : (e.n || e.id))

// One sync at a time. A change that comes in while one runs is not lost: the running one is
// followed by a single further pass with the newest state.
let running = null
let again = null
const listeners = new Set()
/** Called with the file's new content after every sync, for the Settings row. */
export function onHealthChange(cb) { listeners.add(cb); return () => listeners.delete(cb) }
const told = h => { listeners.forEach(cb => { try { cb(h) } catch { /* a closed screen */ } }) }

/**
 * Writes what changed since the last sync and removes what was deleted from openGym. A no-op
 * while it is off. Resolves with the file's content afterwards; `error` is 'permission' when
 * Health Connect refused (the user took the permission back), 'unavailable' when it is gone.
 */
export function syncHealth(S) {
  if (!MOBILE) return Promise.resolve(null)
  // Not read yet: initHealthSync reads it at launch and syncs then, which covers a save made
  // before that; the save path itself never waits on the file.
  if (!cached || !cached.on) return Promise.resolve(cached)
  if (running) { again = S; return running }
  again = null
  running = (async () => {
    let h = await loadHealth()
    let next = S
    while (next) {
      if (h.on) h = await syncOnce(next, h)
      // A state that came in meanwhile, taken only now: cleared before a pass, it would lose a
      // change made while the pass was starting.
      next = again
      again = null
    }
    return h
  })().finally(() => { running = null })
  return running
}

async function syncOnce(S, h) {
  const p = await plugin()
  if (!p) return h
  const plan = planSync(healthRecords(S, { nameOf, speedUnit: speedUnitOf(S) }), h.written)
  const nothing = !plan.sessions.length && !plan.weights.length && !plan.remove.sessions.length && !plan.remove.weights.length
  if (nothing) {
    if (!h.error) return h
    // Nothing to write, but the last attempt failed: clear it once Health Connect says yes again.
    const st = await p.HC.status().catch(() => null)
    if (!(st?.status === 'available' && st.granted)) return h
    const out = await patchHealth({ error: null })
    told(out)
    return out
  }
  let out = { ...h }
  try {
    if (plan.sessions.length || plan.weights.length) {
      await p.HC.write({ sessions: plan.sessions, weights: plan.weights })
      // Written but not yet removed: kept as written, so a failed remove is tried again.
      const kept = Object.fromEntries(Object.entries(h.written).filter(([id]) => !plan.written[id]))
      out.written = { ...kept, ...plan.written }
    }
    if (plan.remove.sessions.length || plan.remove.weights.length) await p.HC.remove(plan.remove)
    out = { ...out, written: plan.written, at: Date.now(), error: null }
  } catch (e) {
    out.error = errorOf(e)
  }
  out = await patchHealth({ written: out.written, at: out.at, error: out.error })
  told(out)
  return out
}

const errorOf = e => (e?.code === 'permission' ? 'permission' : e?.code === 'unavailable' ? 'unavailable' : 'failed')

/**
 * Turning it on: asks for the two write permissions, then writes the whole log once. Resolves
 * with { ok, reason } — reason 'denied' when the user did not grant both, or the status when
 * Health Connect is not there to ask.
 */
export async function enableHealth(S) {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  const granted = st.granted || (await p.HC.requestPermissions().catch(() => ({ granted: false }))).granted
  if (!granted) return { ok: false, reason: 'denied' }
  await patchHealth({ on: true, error: null })
  const after = await syncHealth(S)
  return { ok: !after?.error, reason: after?.error || null, health: after }
}

/**
 * Turning it off stops the writing. With `removeWritten`, what openGym wrote is taken out of
 * Health Connect too; without it, it stays there as the user's own data. Rejects when the
 * removal fails, and then stays on, so nothing is left behind that the phone forgot it wrote.
 */
export async function disableHealth({ removeWritten = false } = {}) {
  if (running) await running.catch(() => {})
  const h = await loadHealth()
  if (removeWritten) {
    const ids = writtenIds(h.written)
    if (ids.sessions.length || ids.weights.length) {
      const p = await plugin()
      if (!p) throw new Error('unavailable')
      await p.HC.remove(ids)
    }
  }
  const out = await patchHealth({ on: false, error: null, written: removeWritten ? {} : h.written })
  told(out)
  return out
}

// ---- Reading weigh-ins back ----

const DAY_MS = 24 * 60 * 60 * 1000
let reading = null

/**
 * Takes in the weigh-ins other apps logged in Health Connect over the last READ_DAYS days
 * (lib/health-connect.js mergeHealthWeights decides what changes). `update` is the store's: the
 * merge is worked out against the state as it is at that moment and written in the same turn, so
 * nothing typed meanwhile is overwritten. A no-op while reading is off. One read at a time.
 * Resolves with { health, added, updated }; `health.read.error` as for writing.
 */
export function readHealth(getState, update) {
  if (!MOBILE) return Promise.resolve(null)
  if (reading) return reading
  reading = (async () => {
    const h = await loadHealth()
    const r = readOf(h)
    const p = r.on ? await plugin() : null
    if (!p) return { health: h, added: 0, updated: 0 }
    let next, added = 0, updated = 0
    try {
      const now = Date.now()
      const res = await p.HC.readWeights({ since: now - READ_DAYS * DAY_MS })
      const S = getState()
      const m = mergeHealthWeights(S?.bodyweight, res?.weights, { unit: S?.unit === 'lb' ? 'lb' : 'kg', seen: r.seen, now })
      if (m.added || m.updated) update(s => { s.bodyweight = m.bodyweight })
      added = m.added
      updated = m.updated
      next = { ...r, seen: m.seen, at: now, error: null, added: r.added + m.added }
    } catch (e) {
      next = { ...r, error: errorOf(e) }
    }
    const out = await patchHealth({ read: next })
    told(out)
    return { health: out, added, updated }
  })().finally(() => { reading = null })
  return reading
}

/**
 * Turning reading on: asks for the read-weight permission only (writing keeps its own two), then
 * reads once. Resolves with { ok, reason, added, health }, `reason` as for enableHealth.
 */
export async function enableHealthRead(getState, update) {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  const granted = st.readGranted || (await p.HC.requestReadPermission().catch(() => ({ granted: false }))).granted
  if (!granted) return { ok: false, reason: 'denied' }
  const h = await loadHealth()
  await patchHealth({ read: { ...readOf(h), on: true, error: null } })
  const r = await readHealth(getState, update)
  const error = r?.health?.read?.error || null
  return { ok: !error, reason: error, added: r?.added || 0, health: r?.health }
}

/** Turning reading off. The weigh-ins it already took stay, as your own data; `seen` is kept so
 *  turning it on again does not bring back one you deleted. */
export async function disableHealthRead() {
  if (reading) await reading.catch(() => {})
  const h = await loadHealth()
  const out = await patchHealth({ read: { ...readOf(h), on: false, error: null } })
  told(out)
  return out
}

// Back in the foreground: a change synced from another device while the phone was away, or a
// permission the user granted again in Health Connect's own settings, is picked up then.
// Weigh-ins logged elsewhere meanwhile (a morning on the scale) are read in at the same moments.
let started = false
export function initHealthSync(getState, update) {
  if (!MOBILE || started) return
  started = true
  const both = () => {
    syncHealth(getState()).catch(() => {})
    if (update) readHealth(getState, update).catch(() => {})
  }
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appStateChange', ({ isActive }) => { if (isActive) both() })
  }).catch(() => {})
  // Once at launch, for a workout finished just before the app was closed. Reading the file here
  // also settles whether it is on, which the saves wait for (syncHealth).
  setTimeout(() => loadHealth().then(both).catch(() => {}), 3000)
}
