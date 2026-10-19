// The profile's own bar per type (S.barDefaults): one setting for every workout, under the
// per-exercise override and over the standard 20 kg / 45 lb bars.
import { describe, expect, test } from 'vitest'
import { BAR_TYPES, BAR_EQ, standardBarWeight, hasOwnBarDefault, withBarDefault, barWeightFor } from './bar.js'
import { baseWeightFor, loadKindFor, rowLoad, inventoryFor } from './plates.js'
import { barFloor } from './history.js'
import { convertStateUnit } from './units.js'
import { EXDB } from './exercises-data.js'

const idOf = eq => EXDB.find(e => e.eq === eq).id
const barbell = idOf('barbell'), olympic = idOf('olympic barbell'), ez = idOf('ez barbell'), smith = idOf('smith machine')

describe('standardBarWeight', () => {
  test('is the standard bar without a setting of your own', () => {
    expect(standardBarWeight({ unit: 'kg' }, 'barbell')).toBe(20)
    expect(standardBarWeight({ unit: 'lb', barDefaults: {} }, 'barbell')).toBe(45)
    expect(standardBarWeight({ unit: 'kg' }, 'dumbbell')).toBeNull()
  })
  test('is your own bar when you set one, 0 included', () => {
    const S = { unit: 'kg', barDefaults: { barbell: 15, 'smith machine': 0 } }
    expect(standardBarWeight(S, 'barbell')).toBe(15)
    expect(standardBarWeight(S, 'smith machine')).toBe(0)
    expect(standardBarWeight(S, 'ez barbell')).toBe(10)
    expect(hasOwnBarDefault(S, 'smith machine')).toBe(true)
    expect(hasOwnBarDefault(S, 'ez barbell')).toBe(false)
  })
  test('an olympic barbell rides on the barbell’s weight unless it has its own', () => {
    expect(standardBarWeight({ unit: 'kg', barDefaults: { barbell: 15 } }, 'olympic barbell')).toBe(15)
    expect(standardBarWeight({ unit: 'kg', barDefaults: { barbell: 15, 'olympic barbell': 20 } }, 'olympic barbell')).toBe(20)
  })
  test('ignores junk', () => {
    for (const v of [-5, 'x', null, NaN, Infinity]) expect(standardBarWeight({ unit: 'kg', barDefaults: { barbell: v } }, 'barbell')).toBe(20)
    expect(standardBarWeight({ unit: 'kg', barDefaults: 'oops' }, 'barbell')).toBe(20)
  })
  test('lists every bar type but the olympic one, which follows the barbell', () => {
    expect([...BAR_EQ].filter(eq => !BAR_TYPES.includes(eq))).toEqual(['olympic barbell'])
  })
})

describe('withBarDefault', () => {
  test('sets, rounds, and takes the key away on the standard bar', () => {
    let m = withBarDefault({}, 'barbell', 15.004, 'kg')
    expect(m).toEqual({ barbell: 15 })
    m = withBarDefault(m, 'ez barbell', 0, 'kg')
    expect(m).toEqual({ barbell: 15, 'ez barbell': 0 })
    m = withBarDefault(m, 'barbell', 20, 'kg')
    expect(m).toEqual({ 'ez barbell': 0 })
    expect(withBarDefault({ barbell: 35 }, 'barbell', 45, 'lb')).toEqual({})
  })
  test('refuses what is not a bar type or not a weight', () => {
    expect(withBarDefault({ barbell: 15 }, 'dumbbell', 5, 'kg')).toEqual({ barbell: 15 })
    expect(withBarDefault({ barbell: 15 }, 'barbell', -1, 'kg')).toEqual({})
    expect(withBarDefault(null, 'barbell', 15, 'kg')).toEqual({ barbell: 15 })
  })
  test('returns a new object', () => {
    const m = { barbell: 15 }
    expect(withBarDefault(m, 'trap bar', 30, 'kg')).not.toBe(m)
    expect(m).toEqual({ barbell: 15 })
  })
})

describe('every workout starts from your bar', () => {
  const S = { unit: 'kg', barDefaults: { barbell: 15, 'smith machine': 0 }, barWeights: {} }
  test('barWeightFor and the plate base read it', () => {
    expect(barWeightFor(S, barbell)).toBe(15)
    expect(barWeightFor(S, olympic)).toBe(15)
    expect(barWeightFor(S, ez)).toBe(10)
    expect(barWeightFor(S, smith)).toBe(0)
    expect(baseWeightFor(S, barbell)).toBe(15)
    expect(baseWeightFor(S, smith)).toBe(0)
  })
  test('an exercise’s own bar still wins, "no bar" included', () => {
    const own = { ...S, barWeights: { [barbell]: 25, [olympic]: 0 } }
    expect(barWeightFor(own, barbell)).toBe(25)
    expect(barWeightFor(own, olympic)).toBe(0)
    expect(baseWeightFor(own, barbell)).toBe(25)
  })
  test('the lightest warm-up is your bar', () => {
    expect(barFloor(S, barbell)).toBe(15)
  })
  test('the plate line loads from your bar', () => {
    // 55 kg on a 15 kg bar is 20 a side; on the standard bar it would be 17.5.
    const L = rowLoad(loadKindFor(S, { id: barbell }), 55, baseWeightFor(S, barbell), inventoryFor(S))
    expect(L.kind).toBe('pairs')
    expect(L.perSide).toBe(20)
  })
})

describe('a unit switch converts your bar', () => {
  test('a 15 kg bar is the 33 lb bar; 25 kg lands on the standard 55 lb trap bar and drops out; 0 stays 0', () => {
    const out = convertStateUnit({ unit: 'kg', barDefaults: { barbell: 15, 'trap bar': 25, 'smith machine': 0, dumbbell: 5 } }, 'lb')
    expect(out.barDefaults).toEqual({ barbell: 33, 'smith machine': 0 })
  })
  test('a state without the setting stays without it', () => {
    expect('barDefaults' in convertStateUnit({ unit: 'kg' }, 'lb')).toBe(false)
  })
})
