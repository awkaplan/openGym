// Write-tool tests for mcp/src/tools.js — the 7 plan-management tools that persist into the
// openGym state. Seeded via _seedStateForTests (in-memory, no disk I/O): writeState mutates
// the seeded state and the metadata cache, so each test sees a real write path without
// touching the filesystem.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests, _metaForTests, getState } from '../src/state.js'
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

// A routine id that exists in the demo seed (Push Day).
function pushRoutine() {
  return S.routines.find(r => r.name === 'Push Day')
}

// writeState works on a clone and swaps the internal state reference — the test's `S`
// variable goes stale after a write. Re-sync it so later assertions/mutations see the
// persisted state, exactly as a fresh getState() would in production.
function resync() {
  S = getState()
  return S
}

/* ---------- create_routine ---------- */

describe('create_routine', () => {
  test('creates a routine that list_routines then sees', async () => {
    const before = await call('list_routines')
    const r = await call('create_routine', {
      name: 'Core Day',
      exercises: [
        { id: '0031', sets: 3, reps: 10, weight: 20 },
        { id: '0684', sets: 3, reps: 12 }
      ]
    })
    expect(r.name).toBe('Core Day')
    expect(r.exercise_count).toBe(2)
    expect(typeof r.id).toBe('string')
    const after = await call('list_routines')
    expect(after.routines.length).toBe(before.routines.length + 1)
    const detail = await call('get_routine', { routine_id: r.id })
    expect(detail.name).toBe('Core Day')
    expect(detail.exercises.length).toBe(2)
    expect(detail.exercises[0].weight).toBe(20)
  })

  test('rejects an exercise id that is not in the catalog, and persists nothing', async () => {
    const before = await call('list_routines')
    await expect(call('create_routine', {
      name: 'Bad',
      exercises: [{ id: 'not-an-exercise', sets: 3, reps: 8 }]
    })).rejects.toThrow(/unknown exercise id/)
    const after = await call('list_routines')
    expect(after.routines.length).toBe(before.routines.length)
  })

  test('rejects an empty exercise list', async () => {
    await expect(call('create_routine', { name: 'Empty', exercises: [] })).rejects.toThrow()
  })
})

/* ---------- update_routine ---------- */

describe('update_routine', () => {
  test('replaces the exercise list and renames the routine', async () => {
    const push = pushRoutine()
    const r = await call('update_routine', {
      routine_id: push.id,
      name: 'Push Day v2',
      exercises: [{ id: '0031', sets: 4, reps: 8, weight: 60 }]
    })
    expect(r.name).toBe('Push Day v2')
    const detail = await call('get_routine', { routine_id: push.id })
    expect(detail.name).toBe('Push Day v2')
    expect(detail.exercises.length).toBe(1)
    expect(detail.exercises[0].sets).toBe(4)
  })

  test('throws ENOENT on a non-existent routine', async () => {
    await expect(call('update_routine', { routine_id: 'bogus', name: 'X' })).rejects.toThrow(/no routine/)
  })

  test('rejects an unknown exercise id in the replacement list', async () => {
    const push = pushRoutine()
    await expect(call('update_routine', {
      routine_id: push.id,
      exercises: [{ id: 'nope', sets: 3, reps: 8 }]
    })).rejects.toThrow(/unknown exercise id/)
  })
})

/* ---------- delete_routine ---------- */

describe('delete_routine', () => {
  test('removes the routine and cleans its week-plan assignments', async () => {
    const push = pushRoutine()
    // Push Day is scheduled on Monday (week[1]) in the demo seed.
    expect(S.week[1]).toBe(push.id)
    const r = await call('delete_routine', { routine_id: push.id })
    expect(r.deleted).toBe(push.id)
    resync()
    expect(S.routines.find(x => x.id === push.id)).toBeUndefined()
    expect(S.week[1]).toBeUndefined()
    const plan = await call('get_week_plan')
    expect(plan.weekdays.find(d => d.weekday === 1).routine_id).toBeNull()
  })

  test('a combined weekday keeps its other routines and per-date reschedules go', async () => {
    const push = pushRoutine()
    const other = S.routines.find(x => x.id !== push.id)
    // v1.3+: a weekday holds a LIST of routine ids (a combined day).
    S.week[3] = [push.id, other.id]
    S.dayPlan = { '2026-07-29': push.id, '2026-07-30': other.id }
    await call('delete_routine', { routine_id: push.id })
    resync()
    expect(S.week[3]).toEqual([other.id])
    expect(S.dayPlan).toEqual({ '2026-07-30': other.id })
  })

  test('throws ENOENT on a non-existent routine', async () => {
    await expect(call('delete_routine', { routine_id: 'bogus' })).rejects.toThrow(/no routine/)
  })
})

/* ---------- progress_exercise ---------- */

describe('progress_exercise', () => {
  // Push Day in the demo seed is all bodyweight (weight 0) — add a weighted exercise so the
  // weight-progression path is actually exercised. 0031 is a known catalog id.
  function weightedPush() {
    const push = pushRoutine()
    push.ex.push({ id: '0031', sets: 3, reps: 8, weight: 60 })
    return push
  }

  test('raises weight by the default increment and reps by the rep step', async () => {
    const push = weightedPush()
    const ex = push.ex.at(-1)
    const beforeW = ex.weight
    const beforeR = ex.reps
    const r = await call('progress_exercise', { routine_id: push.id, exercise_id: ex.id })
    expect(r.weight).toBeGreaterThan(beforeW)
    expect(r.reps).toBe(beforeR + 1)
    // Persisted: get_routine shows the new targets.
    const detail = await call('get_routine', { routine_id: push.id })
    const after = detail.exercises.find(e => e.id === ex.id)
    expect(after.weight).toBe(r.weight)
    expect(after.reps).toBe(r.reps)
  })

  test('honours an explicit weight_increment', async () => {
    const push = weightedPush()
    const ex = push.ex.at(-1)
    const beforeW = ex.weight
    const r = await call('progress_exercise', {
      routine_id: push.id, exercise_id: ex.id, weight_increment: 10
    })
    expect(r.weight).toBe(beforeW + 10)
  })

  test('bodyweight exercise (weight 0) progresses reps only', async () => {
    const push = pushRoutine()
    // Force a bodyweight-style exercise: weight 0, reps target.
    push.ex[0].weight = 0
    push.ex[0].reps = 10
    const r = await call('progress_exercise', { routine_id: push.id, exercise_id: push.ex[0].id })
    expect(r.weight).toBeNull()
    expect(r.reps).toBe(11)
  })

  test('timed exercise raises the duration target by 5 s', async () => {
    const push = pushRoutine()
    push.ex.push({ id: 'synth-plank', sets: 3, sec: 60, weight: 0, mode: 'time' })
    const r = await call('progress_exercise', { routine_id: push.id, exercise_id: 'synth-plank' })
    expect(r.mode).toBe('time')
    expect(r.sec).toBe(65)
  })

  test('cardio exercise is rejected', async () => {
    const push = pushRoutine()
    push.ex.push({ id: 'synth-treadmill', sets: 1, min: 20, speed: 8, mode: 'cardio' })
    await expect(call('progress_exercise', { routine_id: push.id, exercise_id: 'synth-treadmill' }))
      .rejects.toThrow(/cardio/)
  })

  test('rejects a negative increment without changing state', async () => {
    const push = pushRoutine()
    const ex = push.ex[0]
    const beforeW = ex.weight
    await expect(call('progress_exercise', {
      routine_id: push.id, exercise_id: ex.id, weight_increment: -5
    })).rejects.toThrow()
    expect(ex.weight).toBe(beforeW)
  })
})

/* ---------- swap_exercise ---------- */

describe('swap_exercise', () => {
  test('replaces the exercise id and keeps the target structure', async () => {
    const push = pushRoutine()
    const ex = push.ex[0]
    const structure = { sets: ex.sets, reps: ex.reps, weight: ex.weight }
    const r = await call('swap_exercise', {
      routine_id: push.id, exercise_id: ex.id, new_exercise_id: '0031'
    })
    expect(r.replaced).toBe(ex.id)
    expect(r.with).toBe('0031')
    const detail = await call('get_routine', { routine_id: push.id })
    const after = detail.exercises.find(e => e.id === '0031')
    expect(after.sets).toBe(structure.sets)
    expect(after.reps).toBe(structure.reps)
    expect(after.weight).toBe(structure.weight)
  })

  test('rejects an unknown replacement exercise', async () => {
    const push = pushRoutine()
    await expect(call('swap_exercise', {
      routine_id: push.id, exercise_id: push.ex[0].id, new_exercise_id: 'nope'
    })).rejects.toThrow(/unknown exercise id/)
  })
})

/* ---------- schedule_deload / cancel_deload ---------- */

describe('schedule_deload / cancel_deload', () => {
  test('scales weighted targets down and restores them on cancel', async () => {
    const push = pushRoutine()
    // Push Day is bodyweight-only — add a weighted exercise so the scaling is observable.
    push.ex.push({ id: '0031', sets: 3, reps: 8, weight: 60 })
    const ex = push.ex.at(-1)
    const origW = ex.weight
    const origSets = ex.sets

    const sched = await call('schedule_deload', { routine_id: push.id, factor: 0.6 })
    expect(sched.deloaded).toBe(true)
    resync()
    const scaled = S.routines.find(r => r.id === push.id).ex.at(-1)
    expect(scaled.weight).toBeLessThan(origW)
    expect(scaled.sets).toBeLessThanOrEqual(origSets)

    // Metadata snapshot exists.
    expect(_metaForTests().deloads[push.id]).toBeTruthy()

    const cancel = await call('cancel_deload', { routine_id: push.id })
    expect(cancel.restored).toBe(true)
    expect(cancel.warning).toBeNull()
    resync()
    const restored = S.routines.find(r => r.id === push.id).ex.at(-1)
    expect(restored.weight).toBe(origW)
    expect(restored.sets).toBe(origSets)
    expect(_metaForTests().deloads[push.id]).toBeUndefined()
  })

  test('refuses a second deload while one is active', async () => {
    const push = pushRoutine()
    await call('schedule_deload', { routine_id: push.id })
    await expect(call('schedule_deload', { routine_id: push.id })).rejects.toThrow(/already has an active deload/)
  })

  test('cancel without an active deload is an error', async () => {
    const push = pushRoutine()
    await expect(call('cancel_deload', { routine_id: push.id })).rejects.toThrow(/no active deload/)
  })

  test('warns when the routine was modified during the deload, but still restores', async () => {
    const push = pushRoutine()
    const ex = push.ex[0]
    const origW = ex.weight
    await call('schedule_deload', { routine_id: push.id, factor: 0.6 })
    // User edits the routine in the app while the deload is active — on the *current* state.
    resync()
    S.routines.find(r => r.id === push.id).ex[0].weight = origW + 5
    const cancel = await call('cancel_deload', { routine_id: push.id })
    expect(cancel.restored).toBe(true)
    expect(cancel.warning).toMatch(/modified while the deload was active/)
    resync()
    expect(S.routines.find(r => r.id === push.id).ex[0].weight).toBe(origW)
  })

  test('rejects an out-of-range factor', async () => {
    const push = pushRoutine()
    await expect(call('schedule_deload', { routine_id: push.id, factor: 1.5 })).rejects.toThrow()
    await expect(call('schedule_deload', { routine_id: push.id, factor: 0.1 })).rejects.toThrow()
  })
})

/* ---------- shared: no-state fallback ---------- */

describe('shared: no-state fallback for write tools', () => {
  test('every write tool answers gracefully when state is null', async () => {
    _seedStateForTests(null)
    const calls = {
      create_routine: { name: 'X', exercises: [{ id: '0031', sets: 3, reps: 8 }] },
      update_routine: { routine_id: 'x', name: 'X' },
      delete_routine: { routine_id: 'x' },
      progress_exercise: { routine_id: 'x', exercise_id: '0031' },
      swap_exercise: { routine_id: 'x', exercise_id: '0031', new_exercise_id: '0684' },
      schedule_deload: { routine_id: 'x' },
      cancel_deload: { routine_id: 'x' }
    }
    for (const t of TOOLS) {
      if (!calls[t.name]) continue
      const r = await t.handler(calls[t.name])
      expect(r).toHaveProperty('error')
    }
  })

  afterAll(() => { _seedStateForTests(S = freshState()) })
})