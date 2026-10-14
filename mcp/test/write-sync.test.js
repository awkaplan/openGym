// An MCP write has to look, to the api and to every other device, like a write from an API
// client (PUT /api/data without `stamped`): revision moved, write ids chained, removals on
// record. Real files in a temp dir — the in-memory seed used by write-tools.test.js skips the
// disk path this is about.
import { describe, test, expect, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-write-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const rt = (id, name) => ({ id, name, exercises: [], _ts: 1000 })
fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
  users: [{ id: 'alex', name: 'Alex', created: '2026-01-01' }], creds: [], subs: [], invites: []
}))
fs.writeFileSync(path.join(dir, 'state-alex.json'), JSON.stringify({
  routines: [rt('r1', 'Push'), rt('r2', 'Pull')], workouts: [], week: { 3: ['r1', 'r2'] },
  _rev: 7, _wid: 'wid7', _wids: ['wid6'], _ts: 1000
}))

async function load() {
  vi.resetModules()
  vi.stubEnv('OPENGYM_DATA', dir)
  vi.stubEnv('OPENGYM_UID', 'alex')
  return import('../src/state.js')
}
const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'state-alex.json'), 'utf8'))

describe('writeState against a real state file', () => {
  test('moves _rev, chains the write ids and records the removal', async () => {
    const { writeState } = await load()
    await writeState(st => {
      st.routines = st.routines.filter(r => r.id !== 'r1')
      return st
    })
    const d = onDisk()
    expect(d._rev).toBeGreaterThanOrEqual(8)
    expect(d._wid).toMatch(/^[0-9a-f]{16}$/)
    expect(d._wid).not.toBe('wid7')
    expect(d._wids).toEqual(['wid6', 'wid7'])
    // The removal is on record, so a device still holding Push does not bring it back.
    expect(JSON.stringify(d.deleted || {})).toContain('r1')
    expect(d.routines.map(r => r.id)).toEqual(['r2'])
  })

  test('keeps a pre-write backup and leaves the app-owned file free of MCP metadata', async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'state-alex.mcp.json'), 'utf8'))
    expect(meta.backups).toHaveLength(1)
    expect(meta.backups[0].state._rev).toBe(7)
    expect(onDisk().backups).toBeUndefined()
  })

  test('a second write builds on the first revision', async () => {
    const { writeState } = await load()
    const before = onDisk()._rev
    await writeState(st => { st.unit = 'lb'; return st })
    const d = onDisk()
    expect(d._rev).toBeGreaterThan(before)
    expect(d._wids).toHaveLength(3)
  })
})
