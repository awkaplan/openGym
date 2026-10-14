// Tests for the workout-log write tools (relabel_workout_exercise, update_workout_set,
// delete_workout). Same harness as write-tools.test.js: seeded in-memory state via
// _seedStateForTests, handlers called directly, resync() after every write because
// writeState swaps the internal state reference (the test's S goes stale).
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests, getState } from '../src/state.js'
import { TOOLS } from '../src/tools.js'

const FAKE_TODAY_ISO = '2026-07-27'

const byName = Object.fromEntries(TOOLS.map(t => [t.name, t.handler]))

async function call(name, params = {}) {
  const h = byName[name]
  if (!h) throw new Error(`unknown tool ${name}`)
  return h(params)
}

function freshState() {
  const s = buildDemoState()
  s.unit = 'kg'
  return s
}

let S = null

beforeAll(() => {
  vi.useFakeTimers({ now: new Date(FAKE_TODAY_ISO + 'T12:00:00Z'), toFake: ['Date'] })
  S = freshState()
  _seedStateForTests(S)
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  S = freshState()
  _seedStateForTests(S)
})

// writeState works on a clone and swaps the internal state reference — re-sync so later
// assertions see the persisted state, exactly as a fresh getState() would in production.
function resync() {
  S = getState()
  return S
}

// Re-seed with a pre-modified state: mutate a shallow clone before it is seeded, so tests
// can craft shapes the demo seed does not produce (duplicate entries, target snapshots).
function seedWith(mutate) {
  const s = freshState()
  mutate(s)
  S = s
  _seedStateForTests(s)
  return s
}

// First workout with a reps-mode entry that has a done, loaded set — the normal case the
// tools are meant for. Returns { w, entry, setIndex }.
function firstLiftedWorkout(state) {
  for (const w of state.workouts) {
    for (const e of w.entries) {
      const idx = (e.sets || []).findIndex(s => s.done && (s.w || 0) > 0)
      if (idx >= 0) return { w, entry: e, setIndex: idx }
    }
  }
  throw new Error('demo seed produced no lifted workout — test premise broken')
}

/* ---------- relabel_workout_exercise ---------- */

describe('relabel_workout_exercise', () => {
  test('moves the entry id, the PR list and the target snapshot; get_workout shows the new name', async () => {
    seedWith(s => {
      const w = s.workouts[0]
      w.entries[0].id = '0027'
      w.entries[0].target = { id: '0027', sets: 3, reps: 8, weight: 25 }
      w.prs = ['0027']
    })
    const wid = S.workouts[0].id
    const r = await call('relabel_workout_exercise', { workout_id: wid, exercise_id: '0027', new_exercise_id: '0032' })
    expect(r).toMatchObject({ workout_id: wid, relabeled: '0027', with: '0032', name: 'barbell deadlift' })
    resync()
    const w = S.workouts.find(x => x.id === wid)
    expect(w.entries[0].id).toBe('0032')
    expect(w.entries[0].target.id).toBe('0032')
    // Target numbers stay as planned that day — only the label moves.
    expect(w.entries[0].target.weight).toBe(25)
    expect(w.prs).toEqual(['0032'])
    const view = await call('get_workout', { workout_id: wid })
    expect(view.entries[0].id).toBe('0032')
    expect(view.entries[0].name).toBe('barbell deadlift')
    expect(view.prs).toContain('barbell deadlift')
  })

  test('works without a target snapshot (old seeds log entries bare)', async () => {
    seedWith(s => {
      s.workouts[0].entries[0].id = '0027'
      delete s.workouts[0].entries[0].target
      s.workouts[0].prs = []
    })
    const wid = S.workouts[0].id
    await call('relabel_workout_exercise', { workout_id: wid, exercise_id: '0027', new_exercise_id: '0032' })
    resync()
    expect(S.workouts.find(x => x.id === wid).entries[0].id).toBe('0032')
  })

  test('throws ENOENT for an unknown workout and an exercise not in the workout', async () => {
    await expect(call('relabel_workout_exercise', { workout_id: 'bogus', exercise_id: '0027', new_exercise_id: '0032' })).rejects.toThrow(/no workout with id/)
    const wid = S.workouts[0].id
    await expect(call('relabel_workout_exercise', { workout_id: wid, exercise_id: '9999', new_exercise_id: '0032' })).rejects.toThrow(/no entry for exercise/)
  })

  test('rejects an unknown new exercise id and identical ids', async () => {
    const wid = S.workouts[0].id
    const { entry } = firstLiftedWorkout(S)
    await expect(call('relabel_workout_exercise', { workout_id: wid, exercise_id: entry.id, new_exercise_id: 'not-an-exercise' })).rejects.toThrow(/unknown exercise id/)
    await expect(call('relabel_workout_exercise', { workout_id: wid, exercise_id: entry.id, new_exercise_id: entry.id })).rejects.toThrow(/identical/)
  })

  test('an ambiguous exercise needs entry_index; the index selects among matching entries', async () => {
    seedWith(s => {
      const w = s.workouts[0]
      w.entries.push(JSON.parse(JSON.stringify(w.entries[0])))
      w.entries[0].id = '0027'
      w.entries[1].id = '0027'
    })
    const wid = S.workouts[0].id
    await expect(call('relabel_workout_exercise', { workout_id: wid, exercise_id: '0027', new_exercise_id: '0032' }))
      .rejects.toThrow(/entry_index/)
    const r = await call('relabel_workout_exercise', { workout_id: wid, exercise_id: '0027', new_exercise_id: '0032', entry_index: 1 })
    expect(r.relabeled).toBe('0027')
    resync()
    const entries = S.workouts.find(x => x.id === wid).entries.filter(e => e.id === '0027' || e.id === '0032')
    expect(entries.map(e => e.id)).toEqual(['0027', '0032'])
  })
})

/* ---------- update_workout_set ---------- */

describe('update_workout_set', () => {
  test('fixes a mis-entered weight and recomputes top weight and volume', async () => {
    const { w, entry, setIndex } = firstLiftedWorkout(S)
    const wid = w.id
    const before = await call('get_workout', { workout_id: wid })
    const entryViewBefore = before.entries.find(e => e.id === entry.id)
    const sBefore = entryViewBefore.sets[setIndex]
    const newW = (sBefore.w || 0) > 0 ? sBefore.w / 2 : 10

    const r = await call('update_workout_set', { workout_id: wid, exercise_id: entry.id, set_index: setIndex, w: newW })
    expect(r.set.w).toBe(newW)
    expect(r.set.done).toBe(true)
    resync()
    const wAfter = S.workouts.find(x => x.id === wid)
    const eAfter = wAfter.entries.find(e => e.id === entry.id)
    // Volume = Σ w·r over done sets across ALL entries of the workout.
    const expectedVol = wAfter.entries.reduce((v, e) =>
      v + e.sets.reduce((n, s) => n + (s.done ? (s.w || 0) * (s.r || 0) : 0), 0), 0)
    expect(wAfter.vol).toBe(expectedVol)
    // topW mirrors the app: the weight of the last logged (done) set.
    const lastDone = [...eAfter.sets].reverse().find(s => s.done)
    expect(eAfter.topW).toBe(lastDone ? (lastDone.w || null) : null)
  })

  test('undone sets drop out of volume; no done set left → topW null', async () => {
    seedWith(s => {
      const w = s.workouts[0]
      w.entries = [w.entries[0]]
      const e = w.entries[0]
      e.sets = [
        { w: 30, r: 10, done: true },
        { w: 30, r: 10, done: true }
      ]
      e.topW = 30
      e.target = { id: e.id, sets: 3, reps: 10, weight: 30 }
      w.vol = 600
    })
    const wid = S.workouts[0].id
    const eid = S.workouts[0].entries[0].id
    const r = await call('update_workout_set', { workout_id: wid, exercise_id: eid, set_index: 0, done: false })
    expect(r.set.done).toBe(false)
    expect(r.workout_volume).toBe(300)
    const r2 = await call('update_workout_set', { workout_id: wid, exercise_id: eid, set_index: 1, done: false })
    expect(r2.workout_volume).toBe(0)
    expect(r2.entry_top_w).toBe(null)
  })

  test('edits cardio sets via min/speed', async () => {
    seedWith(s => {
      s.workouts[0].entries = [{ id: '3666', sets: [{ min: 10, speed: 5, done: true }], topW: null, target: { id: '3666', mode: 'cardio', sets: 1, min: 10, speed: 5 } }]
      s.workouts[0].vol = 0
    })
    const wid = S.workouts[0].id
    const r = await call('update_workout_set', { workout_id: wid, exercise_id: '3666', set_index: 0, min: 15, speed: 5.5 })
    expect(r.set).toMatchObject({ min: 15, speed: 5.5, done: true })
  })

  test('throws on missing fields, out-of-range set_index, unknown workout/exercise', async () => {
    const { w, entry } = firstLiftedWorkout(S)
    const wid = w.id
    await expect(call('update_workout_set', { workout_id: wid, exercise_id: entry.id, set_index: 0 })).rejects.toThrow(/nothing to change/)
    await expect(call('update_workout_set', { workout_id: wid, exercise_id: entry.id, set_index: 99, w: 10 })).rejects.toThrow(/out of range/)
    await expect(call('update_workout_set', { workout_id: 'bogus', exercise_id: entry.id, set_index: 0, w: 10 })).rejects.toThrow(/no workout with id/)
    await expect(call('update_workout_set', { workout_id: wid, exercise_id: '9999', set_index: 0, w: 10 })).rejects.toThrow(/no entry for exercise/)
  })
})

/* ---------- delete_workout ---------- */

describe('delete_workout', () => {
  test('removes the session and reports what went; list_workouts loses it', async () => {
    const wid = S.workouts[0].id
    const before = await call('list_workouts', {})
    const r = await call('delete_workout', { workout_id: wid })
    expect(r.deleted).toBe(wid)
    expect(r.date).toBe(S.workouts[0] ? S.workouts[0].d : r.date)
    expect(typeof r.volume).toBe('number')
    resync()
    expect(S.workouts.some(x => x.id === wid)).toBe(false)
    const after = await call('list_workouts', {})
    expect(after.total_count).toBe(before.total_count - 1)
  })

  test('throws ENOENT for an unknown workout', async () => {
    await expect(call('delete_workout', { workout_id: 'bogus' })).rejects.toThrow(/no workout with id/)
  })
})
