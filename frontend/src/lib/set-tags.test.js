import { describe, it, expect } from 'vitest'
import {
  SET_TAG_MAX, SET_TAGS_MAX, cleanSetTag, cleanSetTags, sessionSetTags, withSetTag, withoutSetTag,
  hasSetTag, annotateSet, isAnnotated, setAnnotationLine,
} from './set-tags.js'

describe('cleanSetTag / cleanSetTags', () => {
  it('trims, collapses whitespace and caps a label', () => {
    expect(cleanSetTag('  Belt  ')).toBe('Belt')
    expect(cleanSetTag('Pause\n  at   bottom')).toBe('Pause at bottom')
    expect(cleanSetTag('x'.repeat(40))).toHaveLength(SET_TAG_MAX)
    expect(cleanSetTag(null)).toBe('')
    expect(cleanSetTag(5)).toBe('')
  })

  it('drops empties and case-insensitive duplicates, keeping the first spelling', () => {
    expect(cleanSetTags(['Belt', ' belt', '', 'Wraps', 'BELT', null])).toEqual(['Belt', 'Wraps'])
    expect(cleanSetTags('Belt')).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => 'T' + i)
    expect(cleanSetTags(many)).toHaveLength(SET_TAGS_MAX)
    expect(cleanSetTags(many, Infinity)).toHaveLength(20)
  })
})

describe('sessionSetTags', () => {
  it('unions the routines’ lists in order', () => {
    const rs = [{ setTags: ['Belt', 'Paused'] }, { setTags: ['paused', 'Pain'] }, {}, null]
    expect(sessionSetTags(rs)).toEqual(['Belt', 'Paused', 'Pain'])
  })
  it('is empty for routines without a list, or none', () => {
    expect(sessionSetTags([{ ex: [] }])).toEqual([])
    expect(sessionSetTags(undefined)).toEqual([])
  })
})

describe('withSetTag / withoutSetTag', () => {
  it('adds at the end once', () => {
    expect(withSetTag(['Belt'], ' Wraps ')).toEqual(['Belt', 'Wraps'])
    expect(withSetTag(['Belt'], 'belt')).toEqual(['Belt'])
    expect(withSetTag(undefined, 'Belt')).toEqual(['Belt'])
    expect(withSetTag(['Belt'], '  ')).toEqual(['Belt'])
  })
  it('removes ignoring case', () => {
    expect(withoutSetTag(['Belt', 'Wraps'], 'BELT')).toEqual(['Wraps'])
    expect(withoutSetTag(['Belt'], 'Nope')).toEqual(['Belt'])
  })
})

describe('annotateSet', () => {
  it('writes tags and note, and leaves an unannotated set without the keys', () => {
    const set = { w: 100, r: 5, done: true }
    annotateSet(set, { tags: ['Belt', 'belt', ''], note: '  felt fast ' })
    expect(set).toEqual({ w: 100, r: 5, done: true, tags: ['Belt'], note: 'felt fast' })
    annotateSet(set, { tags: [], note: '' })
    expect(set).toEqual({ w: 100, r: 5, done: true })
  })
  it('touches only what it is given', () => {
    const set = { tags: ['Belt'], note: 'keep' }
    annotateSet(set, { tags: ['Wraps'] })
    expect(set).toEqual({ tags: ['Wraps'], note: 'keep' })
    annotateSet(set, { note: '' })
    expect(set).toEqual({ tags: ['Wraps'] })
  })
  it('keeps a set’s own labels even past the workout list’s cap', () => {
    const set = {}
    annotateSet(set, { tags: Array.from({ length: 15 }, (_, i) => 'T' + i) })
    expect(set.tags).toHaveLength(15)
  })
  it('caps the note at NOTE_MAX', () => {
    const set = {}
    annotateSet(set, { note: 'x'.repeat(900) })
    expect(set.note).toHaveLength(500)
  })
})

describe('reading annotations back', () => {
  it('hasSetTag ignores case', () => {
    expect(hasSetTag({ tags: ['Belt'] }, 'belt')).toBe(true)
    expect(hasSetTag({ tags: ['Belt'] }, 'Wraps')).toBe(false)
    expect(hasSetTag({}, 'Belt')).toBe(false)
    expect(hasSetTag({ tags: ['Belt'] }, '')).toBe(false)
  })
  it('isAnnotated', () => {
    expect(isAnnotated({ w: 1 })).toBe(false)
    expect(isAnnotated({ tags: [] })).toBe(false)
    expect(isAnnotated({ note: '  ' })).toBe(false)
    expect(isAnnotated({ tags: ['Belt'] })).toBe(true)
    expect(isAnnotated({ note: 'x' })).toBe(true)
    expect(isAnnotated(null)).toBe(false)
  })
  it('setAnnotationLine joins labels, then the note', () => {
    expect(setAnnotationLine({ tags: ['Belt', 'Paused'], note: 'easy' })).toBe('Belt, Paused · easy')
    expect(setAnnotationLine({ tags: ['Belt'] })).toBe('Belt')
    expect(setAnnotationLine({ note: 'easy' })).toBe('easy')
    expect(setAnnotationLine({})).toBe('')
    expect(setAnnotationLine(null)).toBe('')
  })
})
