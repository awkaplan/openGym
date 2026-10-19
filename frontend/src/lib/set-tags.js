// Per-set annotations: short labels you tick on a set ("Belt", "Paused", "Pain") and a line of
// your own, on top of the session note (the whole workout) and the exercise note (one exercise).
//
// Which labels are on offer is the workout's own choice, not one global list: a heavy squat day
// wants "Belt" and "Wraps", a rehab day "Pain" and "Twinge". So the list lives on the routine
//
//   routine.setTags = ['Belt', 'Wraps', 'Paused']
//
// and a session copies it when it starts (A.setTags, the union over the routines it was built
// from, lib/session-start.js). A label added mid-session joins that session's list and can be
// saved back to the routine; it never edits the routine behind your back.
//
// What a set carries is the label text itself, not an index into the list:
//
//   set.tags = ['Belt', 'Paused'], set.note = 'Left knee caved on rep 4'
//
// so renaming or removing a label later leaves the sets already logged reading as they did.
// Annotations are display only: nothing in progression, 1RM or volume reads them.
import { NOTE_MAX } from './history.js'

/** Longest label, in characters. A chip, not a sentence: the note is for sentences. */
export const SET_TAG_MAX = 24
/** Most labels one workout offers. Past this the chips stop being a quick pick. */
export const SET_TAGS_MAX = 12

/** One label cleaned up: trimmed, inner whitespace collapsed, capped. '' for nothing usable. */
export function cleanSetTag(v) {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, ' ').trim().slice(0, SET_TAG_MAX).trim()
}

/**
 * A list of labels cleaned up: each one cleaned, empties dropped, duplicates (ignoring case)
 * dropped keeping the first spelling, capped at `max`.
 */
export function cleanSetTags(list, max = SET_TAGS_MAX) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const v of list) {
    const tag = cleanSetTag(v)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/** The labels a session built from these routines offers: each routine's, in order, once. */
export function sessionSetTags(routines) {
  return cleanSetTags((routines || []).flatMap(r => (Array.isArray(r?.setTags) ? r.setTags : [])))
}

/** `list` with `tag` added at the end (or unchanged when it is there already, or full). */
export function withSetTag(list, tag) {
  return cleanSetTags([...(Array.isArray(list) ? list : []), tag])
}

/** `list` without `tag` (compared ignoring case). */
export function withoutSetTag(list, tag) {
  const key = cleanSetTag(tag).toLowerCase()
  return cleanSetTags(list).filter(x => x.toLowerCase() !== key)
}

/** Whether a set carries `tag` (ignoring case). */
export function hasSetTag(set, tag) {
  const key = cleanSetTag(tag).toLowerCase()
  return !!key && Array.isArray(set?.tags) && set.tags.some(x => cleanSetTag(x).toLowerCase() === key)
}

/**
 * Writes `tags` and `note` onto a set (a store draft), in place. Empty values take the key away,
 * so a set nobody annotated stays byte-for-byte the shape it always was. A set's own labels are
 * not capped by the workout's list: it keeps whatever it was given, cleaned.
 */
export function annotateSet(set, { tags, note } = {}) {
  if (!set || typeof set !== 'object') return set
  if (tags !== undefined) {
    const clean = cleanSetTags(tags, Infinity)
    if (clean.length) set.tags = clean; else delete set.tags
  }
  if (note !== undefined) {
    const text = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : ''
    if (text) set.note = text; else delete set.note
  }
  return set
}

/** Whether a set carries any annotation at all. */
export const isAnnotated = set => !!(set && ((Array.isArray(set.tags) && set.tags.length) || (typeof set.note === 'string' && set.note.trim())))

/** One line for a set's annotations: its labels, then its note. '' for none. */
export function setAnnotationLine(set) {
  if (!set) return ''
  const tags = cleanSetTags(set.tags, Infinity)
  const note = typeof set.note === 'string' ? set.note.trim() : ''
  return [tags.join(', '), note].filter(Boolean).join(' · ')
}
