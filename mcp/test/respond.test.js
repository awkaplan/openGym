// The reply each tool call gets over MCP. The write tools resolve once the state file is saved;
// sent before that, every write answered `{}` and a failed save answered nothing at all.
import { describe, test, expect, vi, afterAll } from 'vitest'
import { respond } from '../src/respond.js'
import { _seedStateForTests, getState } from '../src/state.js'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { TOOLS } from '../src/tools.js'

const text = reply => JSON.parse(reply.content[0].text)
const tool = name => TOOLS.find(t => t.name === name)

describe('respond', () => {
  test('a synchronous result is sent as JSON', async () => {
    expect(text(await respond({ handler: () => ({ ok: 1 }) }))).toEqual({ ok: 1 })
  })

  test('a write is answered with what it resolved to, not {}', async () => {
    expect(text(await respond({ handler: () => Promise.resolve({ deleted: 'w1' }) }))).toEqual({ deleted: 'w1' })
  })

  test('a write that fails while saving is an error reply', async () => {
    const err = Object.assign(new Error('no workout with id "x"'), { code: 'ENOENT' })
    const reply = await respond({ handler: () => Promise.reject(err) })
    expect(reply).toEqual({ isError: true, content: [{ type: 'text', text: 'ENOENT: no workout with id "x"' }] })
  })

  test('a thrown error is an error reply', async () => {
    const reply = await respond({ handler: () => { throw new Error('bad') } })
    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toBe('ERROR: bad')
  })

  describe('through a real write tool', () => {
    vi.useFakeTimers({ now: new Date('2026-07-27T12:00:00'), toFake: ['Date'] })
    afterAll(() => vi.useRealTimers())

    test('set_day_override answers with the plan it saved', async () => {
      const S = buildDemoState()
      _seedStateForTests(S)
      const reply = await respond(tool('set_day_override'), { date: '2026-07-31', routine_id: S.routines[0].id })
      expect(reply.isError).toBeUndefined()
      expect(text(reply)).toMatchObject({ date: '2026-07-31', override: S.routines[0].id })
      expect(getState().dayPlan['2026-07-31']).toBe(S.routines[0].id)
    })
  })
})
