// Tests for the equipment-profile tools (get_equipment, update_equipment_profiles).
// Same harness as the other tool tests: seeded in-memory state, handlers called directly.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests, getState } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { EXDB } from '../../frontend/src/lib/exercises-data.js'

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
  s.equipProfiles = []
  s.activeEquipId = null
  s.equipFilterOn = false
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

function resync() {
  S = getState()
  return S
}

// A couple of real catalog equipment values to build profiles from.
const DUMBBELL = 'dumbbell'
const BARBELL = 'barbell'
const LEVER = 'leverage machine'

/* ---------- get_equipment ---------- */

describe('get_equipment', () => {
  test('reports empty profiles, filter state, and the catalog checklist', async () => {
    const r = await call('get_equipment')
    expect(r.profiles).toEqual([])
    expect(r.filter_on).toBe(false)
    expect(r.active_profile_id).toBe(null)
    // The checklist derives from the catalog and contains the values we test with.
    const names = r.catalog_equipment.map(x => x.equipment)
    expect(names).toContain(DUMBBELL)
    expect(names).toContain(BARBELL)
    expect(names).toContain(LEVER)
    for (const c of r.catalog_equipment) expect(c.exercise_count).toBeGreaterThan(0)
    // Cross-check one count against the raw catalog.
    const dumb = r.catalog_equipment.find(x => x.equipment === DUMBBELL)
    expect(dumb.exercise_count).toBe(EXDB.filter(e => e.eq === DUMBBELL).length)
  })

  test('reports existing profiles with their equipment lists', async () => {
    S.equipProfiles = [{ id: 'eqHome', name: 'Home', equipment: [DUMBBELL, KETTLEBELL()] }]
    S.activeEquipId = 'eqHome'
    S.equipFilterOn = true
    _seedStateForTests(S)
    const r = await call('get_equipment')
    expect(r.profiles).toHaveLength(1)
    expect(r.profiles[0]).toMatchObject({ id: 'eqHome', name: 'Home', equipment_count: 2 })
    expect(r.active_profile_id).toBe('eqHome')
    expect(r.filter_on).toBe(true)
  })

  function KETTLEBELL() { return 'kettlebell' }
})

/* ---------- update_equipment_profiles ---------- */

describe('update_equipment_profiles', () => {
  test('creates a profile, activates it, and turns the filter on', async () => {
    const r = await call('update_equipment_profiles', {
      profiles: [{ name: 'Home Gym', equipment: [DUMBBELL, BARBELL, LEVER, 'kettlebell'] }],
      active_profile_id: null,
      filter_on: true
    })
    expect(r.profiles).toHaveLength(1)
    expect(r.profiles[0].name).toBe('Home Gym')
    expect(r.profiles[0].equipment_count).toBe(4)
    expect(typeof r.profiles[0].id).toBe('string')
    expect(r.filter_on).toBe(true)
    resync()
    expect(S.equipProfiles[0].equipment).toEqual([DUMBBELL, BARBELL, LEVER, 'kettlebell'])
    // active_profile_id null → no active profile, but filter state is stored.
    expect(S.activeEquipId).toBe(null)
    expect(S.equipFilterOn).toBe(true)
  })

  test('updates an existing profile in place when its id is passed', async () => {
    S.equipProfiles = [{ id: 'eq1', name: 'Home', equipment: [DUMBBELL] }]
    _seedStateForTests(S)
    const r = await call('update_equipment_profiles', {
      profiles: [{ id: 'eq1', name: 'Home Gym', equipment: [DUMBBELL, BARBELL] }],
      active_profile_id: 'eq1'
    })
    expect(r.active_profile_id).toBe('eq1')
    resync()
    expect(S.equipProfiles).toHaveLength(1)
    expect(S.equipProfiles[0].name).toBe('Home Gym')
    expect(S.equipProfiles[0].id).toBe('eq1')
    expect(S.equipProfiles[0].equipment).toEqual([DUMBBELL, BARBELL])
    expect(S.activeEquipId).toBe('eq1')
  })

  test('replace semantics: unlisted profiles are removed and a dangling active id is nulled', async () => {
    S.equipProfiles = [
      { id: 'eq1', name: 'Home', equipment: [DUMBBELL] },
      { id: 'eq2', name: 'Gym', equipment: [BARBELL] }
    ]
    S.activeEquipId = 'eq2'
    _seedStateForTests(S)
    const r = await call('update_equipment_profiles', {
      profiles: [{ name: 'Home v2', equipment: [DUMBBELL] }],
      active_profile_id: null
    })
    expect(r.profiles).toHaveLength(1)
    resync()
    expect(S.equipProfiles.map(p => p.name)).toEqual(['Home v2'])
    // eq2 was deleted and was active — activeEquipId must not dangle.
    expect(S.activeEquipId).toBe(null)
  })

  test('validates equipment names against the catalog (EINVAL, nothing half-applied)', async () => {
    await expect(call('update_equipment_profiles', {
      profiles: [{ name: 'Bad', equipment: ['leverage machnie'] }]
    })).rejects.toThrow(/unknown equipment type/)
    resync()
    expect(S.equipProfiles).toHaveLength(0)
  })

  test('rejects an empty profile list, a foreign active id, and duplicate names', async () => {
    await expect(call('update_equipment_profiles', { profiles: [] })).rejects.toThrow(/at least one profile/)
    await expect(call('update_equipment_profiles', {
      profiles: [{ name: 'A', equipment: [DUMBBELL] }],
      active_profile_id: 'not-listed'
    })).rejects.toThrow(/active_profile_id/)
    await expect(call('update_equipment_profiles', {
      profiles: [{ name: 'Same', equipment: [DUMBBELL] }, { name: 'Same', equipment: [BARBELL] }]
    })).rejects.toThrow(/unique/)
  })

  test('deduplicates equipment within a profile and tolerates id-less profiles', async () => {
    const r = await call('update_equipment_profiles', {
      profiles: [{ name: 'Home', equipment: [DUMBBELL, DUMBBELL, BARBELL] }]
    })
    expect(r.profiles[0].equipment).toEqual([DUMBBELL, BARBELL])
    expect(r.profiles[0].id).not.toBe('eq1')
  })
})
