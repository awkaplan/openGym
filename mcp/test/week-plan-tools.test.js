// Week-plan write tools: set_week_plan, clear_week_plan, set_day_override, clear_day_override,
// and the `overrides` get_week_plan lists for them. Seeded in memory, like write-tools.test.js.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests, getState } from '../src/state.js'
import { TOOLS } from '../src/tools.js'

// A Monday, so "today" and its weekday are fixed: 2026-07-27 is getDay() 1.
const TODAY = '2026-07-27'
const byName = Object.fromEntries(TOOLS.map(t => [t.name, t.handler]))
const call = (name, params = {}) => byName[name](params)

let S = null
let push, pull, legs
beforeAll(() => { vi.useFakeTimers({ now: new Date(TODAY + 'T12:00:00'), toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })
beforeEach(() => {
  S = buildDemoState()
  S.unit = 'kg'
  S.queue = null
  S.scheduleMode = null
  S.week = { 1: [S.routines[0].id], 3: [S.routines[1].id] }
  S.dayPlan = { '2026-07-20': 'rest' }   // a past override: history, never touched
  ;[push, pull, legs] = S.routines
  _seedStateForTests(S)
})
const state = () => getState()

describe('set_week_plan', () => {
  test('sets the listed weekdays by index or name and leaves the others alone', async () => {
    const r = await call('set_week_plan', { days: [{ weekday: 'Friday', routine_ids: [push.id, pull.id] }, { weekday: 3, routine_ids: [] }] })
    expect(state().week).toEqual({ 1: [push.id], 5: [push.id, pull.id] })
    expect(r.updated_weekdays).toEqual(['Friday', 'Wednesday'])
    // Answers with the plan as get_week_plan reads it.
    expect(r.weekdays[5].routine_ids).toEqual([push.id, pull.id])
    expect(r.weekdays[3].routine_ids).toEqual([])
  })

  test('replace writes a whole new week', async () => {
    await call('set_week_plan', { replace: true, days: [{ weekday: 2, routine_ids: [legs.id] }, { weekday: 4, routine_ids: [legs.id, legs.id] }] })
    expect(state().week).toEqual({ 2: [legs.id], 4: [legs.id] })   // a repeat id is kept once
  })

  test('the new plan is what the coming days resolve to', async () => {
    await call('set_week_plan', { replace: true, days: [{ weekday: 1, routine_ids: [legs.id] }] })
    const plan = await call('get_week_plan')
    expect(plan.today_routine_ids).toEqual([legs.id])
    expect(plan.days.filter(d => d.routine_ids.length).map(d => d.date)).toEqual([TODAY])
  })

  test('refuses an unknown routine, a weekday twice or a made-up day, and writes nothing', async () => {
    const before = structuredClone(state().week)
    await expect(async () => call('set_week_plan', { days: [{ weekday: 2, routine_ids: ['nope'] }] })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(async () => call('set_week_plan', { days: [{ weekday: 2, routine_ids: [] }, { weekday: 'tuesday', routine_ids: [] }] })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('set_week_plan', { days: [{ weekday: 'Caturday', routine_ids: [] }] })).rejects.toMatchObject({ code: 'EINVAL' })
    expect(state().week).toEqual(before)
  })
})

describe('clear_week_plan', () => {
  test('makes every weekday rest and keeps the routines and the overrides', async () => {
    await call('set_day_override', { date: '2026-07-29', rest: true })
    const r = await call('clear_week_plan')
    expect(state().week).toEqual({})
    expect(state().routines.length).toBe(S.routines.length)
    expect(state().dayPlan).toEqual({ '2026-07-20': 'rest', '2026-07-29': 'rest' })
    expect(r.cleared_overrides).toEqual([])
  })

  test('include_overrides drops today and later, never the past', async () => {
    await call('set_day_override', { date: TODAY, routine_id: legs.id })
    await call('set_day_override', { date: '2026-08-15', rest: true })
    const r = await call('clear_week_plan', { include_overrides: true })
    expect(state().dayPlan).toEqual({ '2026-07-20': 'rest' })
    expect(r.cleared_overrides).toEqual([TODAY, '2026-08-15'])
  })
})

describe('set_day_override / clear_day_override', () => {
  test('a routine on a date wins over its weekday, and get_week_plan lists it', async () => {
    const r = await call('set_day_override', { date: '2026-07-28', routine_id: legs.id })
    expect(r).toMatchObject({ date: '2026-07-28', override: legs.id, previous_override: null })
    const tue = r.days.find(d => d.date === '2026-07-28')
    expect(tue).toMatchObject({ routine_ids: [legs.id], planned_by: 'override' })
    expect(r.overrides).toEqual([{ date: '2026-07-28', kind: 'routine', routine_id: legs.id, routine_name: legs.name }])
  })

  test('rest replaces a planned weekday, past the seven days too', async () => {
    await call('set_day_override', { date: '2026-07-29', rest: true })
    const r = await call('set_day_override', { date: '2026-09-07', rest: true })
    expect(r.days.find(d => d.date === '2026-07-29')).toMatchObject({ routine_ids: [], planned_by: 'rest_override' })
    expect(r.overrides.map(o => [o.date, o.kind])).toEqual([['2026-07-29', 'rest'], ['2026-09-07', 'rest']])
  })

  test('needs exactly one of routine_id or rest, and a routine that exists', async () => {
    await expect(async () => call('set_day_override', { date: '2026-07-28' })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('set_day_override', { date: '2026-07-28', routine_id: legs.id, rest: true })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(async () => call('set_day_override', { date: '2026-07-28', routine_id: 'nope' })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state().dayPlan).toEqual({ '2026-07-20': 'rest' })
  })

  test('clearing puts the date back on its weekday; clearing again is a no-op', async () => {
    await call('set_day_override', { date: '2026-07-29', routine_id: legs.id })
    const r = await call('clear_day_override', { date: '2026-07-29' })
    expect(r).toMatchObject({ cleared: true, previous_override: legs.id })
    expect(r.days.find(d => d.date === '2026-07-29')).toMatchObject({ routine_ids: [pull.id], planned_by: 'weekday' })
    expect((await call('clear_day_override', { date: '2026-07-29' })).cleared).toBe(false)
    expect(state().dayPlan).toEqual({ '2026-07-20': 'rest' })
  })
})

test('each tool answers gracefully when there is no state', async () => {
  _seedStateForTests(null)
  expect(await call('set_week_plan', { days: [{ weekday: 1, routine_ids: [] }] })).toHaveProperty('error')
  expect(await call('clear_week_plan')).toHaveProperty('error')
  expect(await call('set_day_override', { date: TODAY, rest: true })).toHaveProperty('error')
  expect(await call('clear_day_override', { date: TODAY })).toHaveProperty('error')
})
