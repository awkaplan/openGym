// Workout create / edit tools: create_workout, update_workout, add/remove_workout_exercise,
// add/remove_workout_set. Seeded in memory, like write-tools.test.js. Every edit goes through the
// app's own history editor (session-edit.js), so these check the record the app would have saved.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests, getState } from '../src/state.js'
import { TOOLS } from '../src/tools.js'

const TODAY = '2026-07-27'
const byName = Object.fromEntries(TOOLS.map(t => [t.name, t.handler]))
const call = (name, params = {}) => byName[name](params)
const BENCH = '0025', SQUAT = '0043', DEAD = '0032', HOP = '4918'

let S = null
beforeAll(() => { vi.useFakeTimers({ now: new Date(TODAY + 'T20:00:00'), toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })
beforeEach(() => {
  S = buildDemoState()
  S.unit = 'kg'
  S.workouts = []
  S.exWeights = {}
  S.active = null
  _seedStateForTests(S)
})
const saved = id => getState().workouts.find(w => w.id === id)
const bench = (w, r = 5) => ({ id: BENCH, sets: [{ w, r }, { w, r }] })

describe('create_workout', () => {
  test('logs a workout as the app files one, and get_workout reads it back', async () => {
    const r = await call('create_workout', {
      date: '2026-07-20', time: '07:30', duration_min: 45, note: 'felt strong',
      exercises: [
        { id: BENCH, sets: [{ w: 40, r: 8, warmup: true }, { w: 80, r: 5 }, { w: 80, r: 4, done: false }] },
        { id: HOP, sets: [{ min: 10, speed: 6 }] },
        { id: SQUAT, mode: 'time', sets: [{ sec: 60, w: 20 }] }
      ]
    })
    expect(r).toMatchObject({ date: '2026-07-20', start_time: '07:30', duration_min: 45, note: 'felt strong', routine_name: 'Freestyle' })
    expect(r.entries.map(e => e.id ?? e.exercise_id)).toEqual([BENCH, HOP, SQUAT])
    const w = saved(r.id)
    expect(w.entries[0].sets).toEqual([{ w: 40, r: 8, done: true, phase: 'warmup' }, { w: 80, r: 5, done: true }, { w: 80, r: 4, done: false }])
    expect(w.entries[1]).toMatchObject({ target: { id: HOP, mode: 'cardio' }, sets: [{ min: 10, speed: 6, done: true }] })
    expect(w.entries[2]).toMatchObject({ target: { id: SQUAT, mode: 'time' }, sets: [{ sec: 60, w: 20, done: true }] })
    expect(w.vol).toBeGreaterThan(0)
    expect(w._ts).toBeGreaterThan(0)   // stamped, so a sync keeps it
    expect(w.prs).toContain(BENCH)     // the first bench ever leads
  })

  test('is filed in date order and badged against what came before it only', async () => {
    const later = await call('create_workout', { date: '2026-07-22', exercises: [bench(100)] })
    expect(saved(later.id).prs).toEqual([BENCH])
    const earlier = await call('create_workout', { date: '2026-07-21', exercises: [bench(120)] })
    expect(getState().workouts.map(w => w.d)).toEqual(['2026-07-21', '2026-07-22'])
    expect(saved(earlier.id).prs).toEqual([BENCH])
    expect(saved(later.id).prs).toEqual([])   // 100 no longer leads 120 before it
    expect(getState().exWeights).toEqual({})  // never moves the confirmed working weights
  })

  test('a routine session counts for that routine and keeps its plan as the target', async () => {
    const routine = getState().routines.find(r => r.ex.some(c => (c.mode || 'reps') === 'reps'))
    const cfg = routine.ex.find(c => (c.mode || 'reps') === 'reps')
    const r = await call('create_workout', { date: '2026-07-20', routine_id: routine.id, exercises: [{ id: cfg.id, sets: [{ w: 50, r: 5 }] }] })
    const w = saved(r.id)
    expect(w).toMatchObject({ routineId: routine.id, routineIds: [routine.id], name: routine.name })
    expect(w.entries[0]).toMatchObject({ rid: routine.id, target: { id: cfg.id } })
  })

  test('refuses the future, nothing done, a set missing its numbers, and unknown ids — writing nothing', async () => {
    const bad = [
      [{ date: TODAY, time: '19:30', duration_min: 60, exercises: [bench(50)] }, 'EINVAL'],
      [{ date: '2026-07-28', exercises: [bench(50)] }, 'EINVAL'],
      [{ date: '2026-07-20', exercises: [{ id: BENCH, sets: [{ w: 50, r: 5, done: false }] }] }, 'EINVAL'],
      [{ date: '2026-07-20', exercises: [{ id: BENCH, sets: [{ w: 50 }] }] }, 'EINVAL'],
      [{ date: '2026-07-20', exercises: [{ id: 'nope', sets: [{ r: 5 }] }] }, 'EINVAL'],
      [{ date: '2026-07-20', routine_id: 'nope', exercises: [bench(50)] }, 'ENOENT']
    ]
    for (const [params, code] of bad) await expect(async () => call('create_workout', params)).rejects.toMatchObject({ code })
    expect(getState().workouts).toEqual([])
  })
})

describe('update_workout', () => {
  test('renames, notes, moves and re-times one workout', async () => {
    const a = await call('create_workout', { date: '2026-07-20', exercises: [bench(80)] })
    const b = await call('create_workout', { date: '2026-07-22', exercises: [bench(90)] })
    const r = await call('update_workout', { workout_id: a.id, name: 'Morning push', note: 'gym was empty', date: '2026-07-24', time: '06:15', duration_min: 50 })
    expect(r).toMatchObject({ date: '2026-07-24', start_time: '06:15', duration_min: 50, routine_name: 'Morning push', note: 'gym was empty' })
    expect(getState().workouts.map(w => w.id)).toEqual([b.id, a.id])   // re-filed after b
    expect(saved(a.id).prs).toEqual([])        // 80 after 90 leads nothing now
    expect((await call('update_workout', { workout_id: a.id, note: '' })).note).toBeNull()
  })

  test('refuses an empty change, a move into the future, and an unknown id', async () => {
    const a = await call('create_workout', { date: '2026-07-20', exercises: [bench(80)] })
    await expect(async () => call('update_workout', { workout_id: a.id })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('update_workout', { workout_id: a.id, date: '2026-07-30' })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('update_workout', { workout_id: 'nope', name: 'x' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(saved(a.id).d).toBe('2026-07-20')
  })
})

describe('exercises and sets in a saved workout', () => {
  test('add and remove an exercise; volume and badges follow', async () => {
    const a = await call('create_workout', { date: '2026-07-20', exercises: [bench(80)] })
    const before = saved(a.id).vol
    const r = await call('add_workout_exercise', { workout_id: a.id, position: 0, exercise: { id: DEAD, sets: [{ w: 140, r: 3 }] } })
    expect(saved(a.id).entries.map(e => e.id)).toEqual([DEAD, BENCH])
    expect(saved(a.id).vol).toBe(before + 140 * 3)
    expect(saved(a.id).prs).toContain(DEAD)
    expect(r.entries).toHaveLength(2)
    await call('remove_workout_exercise', { workout_id: a.id, exercise_id: DEAD })
    expect(saved(a.id).entries.map(e => e.id)).toEqual([BENCH])
    expect(saved(a.id).prs).toEqual([BENCH])
    expect(saved(a.id).vol).toBe(before)
  })

  test('add and remove sets, by position', async () => {
    const a = await call('create_workout', { date: '2026-07-20', exercises: [bench(80)] })
    await call('add_workout_set', { workout_id: a.id, exercise_id: BENCH, position: 0, set: { w: 40, r: 10, warmup: true } })
    await call('add_workout_set', { workout_id: a.id, exercise_id: BENCH, set: { w: 85, r: 3 } })
    expect(saved(a.id).entries[0].sets.map(s => s.w)).toEqual([40, 80, 80, 85])
    expect(saved(a.id).entries[0].topW).toBe(85)
    await call('remove_workout_set', { workout_id: a.id, exercise_id: BENCH, set_index: 3 })
    expect(saved(a.id).entries[0].sets.map(s => s.w)).toEqual([40, 80, 80])
    expect(saved(a.id).entries[0].topW).toBe(80)
    await expect(async () => call('add_workout_set', { workout_id: a.id, exercise_id: BENCH, set: { w: 85 } })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('remove_workout_set', { workout_id: a.id, exercise_id: BENCH, set_index: 9 })).rejects.toMatchObject({ code: 'EINVAL' })
  })

  test('an exercise whose last done set goes drops out; the workout\'s last one is refused', async () => {
    const a = await call('create_workout', { date: '2026-07-20', exercises: [{ id: BENCH, sets: [{ w: 80, r: 5 }] }, { id: DEAD, sets: [{ w: 140, r: 3 }] }] })
    await call('remove_workout_set', { workout_id: a.id, exercise_id: DEAD, set_index: 0 })
    expect(saved(a.id).entries.map(e => e.id)).toEqual([BENCH])
    await expect(async () => call('remove_workout_set', { workout_id: a.id, exercise_id: BENCH, set_index: 0 })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('remove_workout_exercise', { workout_id: a.id, exercise_id: BENCH })).rejects.toMatchObject({ code: 'EINVAL' })
    expect(saved(a.id).entries[0].sets).toHaveLength(1)
  })

  test('update_workout_set: a mistyped weight corrected down loses the PR badge it never earned', async () => {
    await call('create_workout', { date: '2026-07-20', exercises: [bench(100)] })
    const typo = await call('create_workout', { date: '2026-07-22', exercises: [bench(160)] })
    expect(saved(typo.id).prs).toEqual([BENCH])
    await call('update_workout_set', { workout_id: typo.id, exercise_id: BENCH, set_index: 0, w: 60 })
    await call('update_workout_set', { workout_id: typo.id, exercise_id: BENCH, set_index: 1, w: 60 })
    expect(saved(typo.id).prs).toEqual([])
    expect(saved(typo.id).entries[0].topW).toBe(60)
  })

  test('a workout running on a device is left alone by an edit of a saved one', async () => {
    const a = await call('create_workout', { date: '2026-07-20', exercises: [bench(80)] })
    const live = { id: 'live', d: TODAY, start: Date.now(), entries: [{ id: SQUAT, sets: [{ w: 60, r: 5, done: false }] }] }
    _seedStateForTests({ ...getState(), active: structuredClone(live) })
    await call('add_workout_set', { workout_id: a.id, exercise_id: BENCH, set: { w: 80, r: 5 } })
    expect(getState().active).toEqual(live)
    expect(saved(a.id).entries[0].sets).toHaveLength(3)
  })
})

test('each tool answers gracefully when there is no state', async () => {
  _seedStateForTests(null)
  const args = {
    create_workout: { date: '2026-07-20', exercises: [bench(80)] },
    update_workout: { workout_id: 'x', name: 'y' },
    add_workout_exercise: { workout_id: 'x', exercise: bench(80) },
    remove_workout_exercise: { workout_id: 'x', exercise_id: BENCH },
    add_workout_set: { workout_id: 'x', exercise_id: BENCH, set: { w: 1, r: 1 } },
    remove_workout_set: { workout_id: 'x', exercise_id: BENCH, set_index: 0 }
  }
  for (const [name, p] of Object.entries(args)) expect(await call(name, p)).toHaveProperty('error')
})
