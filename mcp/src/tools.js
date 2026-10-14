/* The tools: read tools return JSON; write tools persist through state.writeState (atomic
   write, rolling backup, _ts stamp so an open app tab adopts the change instead of
   overwriting it). labels.js pre-substitutes any {0}/{1} template the lib returns so the
   LLM gets final text, not template strings. ISO dates are validated on the way in; the
   handlers never see 'yesterday'. */
import crypto from 'node:crypto'
import { z } from 'zod'
import { getState, getUser, writeState, updateMeta, readMeta, writeMeta } from './state.js'
import {
  fmt, setLabel, exLine, muscleName, policyName, friendlyDuration, ratio, muscleOrder
} from './labels.js'
import {
  modeOf, workoutVolume, setsDone, effectiveRoutine, effectiveRoutineIds, lastEntryFor, workoutAt, repStep as repStepOf
} from '../../frontend/src/lib/history.js'
import { queueView, queueNext, pinState } from '../../frontend/src/lib/queue.js'
import { EXIDX, EXDB, exOr, registerCustom } from '../../frontend/src/lib/exercises.js'
import { isWarmupRow, isFailureSet } from '../../frontend/src/lib/workout-model.js'
import {
  bestSetOf, best1RM, e1rmSeries, DEFAULT_FORMULA, REP_CAP
} from '../../frontend/src/lib/onerm.js'
import { loadOfWorkouts, rankOf, levelsOf } from '../../frontend/src/lib/muscles.js'
import { policyFor, defaultIncrement, DEFAULT_SEC_INCREMENT, snapWeight } from '../../frontend/src/lib/progression.js'
import { deleteRoutine as deleteRoutineInState } from '../../frontend/src/lib/routines.js'
import { buildSessionEntries, startsFromLast } from '../../frontend/src/lib/session-start.js'

/* ---------- helpers ---------- */

// A 'YYYY-MM-DD' the calendar actually has. The regex alone let 2026-02-30 through, and
// new Date('2026-02-30T12:00:00') rolls over to March 2 — so preview_session answered for
// March 2 while echoing February 30 back as the date it had answered for. Round-trip the string
// through the same local-noon construction the handlers use and insist it comes back unchanged;
// as a zod refine that is a -32602 at the SDK boundary instead of a confident wrong answer.
const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const todayIso = () => localIso(new Date())
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  v => { const d = new Date(v + 'T12:00:00'); return !Number.isNaN(d.getTime()) && localIso(d) === v },
  { message: 'not a date the calendar has (YYYY-MM-DD)' }
)

// A custom exercise lives in S.customEx and is merged into EXIDX by registerCustom() at
// store load (useStore.js:54). The MCP server deliberately never calls it: http.js serves
// several profiles from one process behind withRemoteState, so mutating the module-global
// index would leak one profile's customs into another's reads.
const customOf = (id, S) => (S.customEx || []).find(ex => ex.id === id)
// exOr's miss is a placeholder object, not null — callers that only need a name are fine
// with it, callers feeding muscle resolution are NOT. Use customOf directly there.
const exerciseOf = (id, S) => customOf(id, S) || exOr(id)
// The session builder, though, reads each exercise's equipment and body part from that global
// index, so preview_session built a custom leg lift with the small load step where the app (which
// registers its customs) takes the larger one. It registers the profile's customs for the length
// of one synchronous build and takes them back out in the same call: nothing else, and no other
// profile's read, can run in between.
function withCustomsIndexed(S, build) {
  registerCustom(Array.isArray(S.customEx) ? S.customEx : [])
  try { return build() } finally { registerCustom([]) }
}

function entryView(e, S) {
  const ex = exerciseOf(e.id, S)
  // Spread id into the cfg the way every call site in the app does (Workout.jsx, Stats.jsx,
  // progression.js) — the sheet saves a cardio target as {sets, min, speed} with no id and no
  // mode, so modeOf needs the id to fall through to isCardio(id).
  const cfg = { ...(e.target || {}), id: e.id }
  const mode = modeOf(cfg)
  return {
    id: e.id,
    name: ex.n,
    body_part: ex.bp || null,
    mode,
    target: e.target || null,
    sets: (e.sets || []).map(s => ({
      done: !!s.done,
      label: setLabel(e.id, { ...s, done: undefined }, cfg),
      // Taken to failure (the app's "F"): RIR 0 for effort when nothing was rated by hand.
      ...(isFailureSet(s) ? { failure: true } : {}),
      w: Number(s.w) || 0,
      r: Number(s.r) || 0,
      sec: Number(s.sec) || 0,
      min: Number(s.min) || 0,
      speed: Number(s.speed) || 0
    }))
  }
}

// Best estimate per exercise, mirroring the UI's PR table: every eligible set across history, biggest wins.
// It asks bestSetOf() rather than scanning the rows here, so this table and the per-exercise answer of
// estimate_1rm are the same reading of the same history. They were not while this scanned: a unilateral
// set is one row carrying both sides, so the row's `r` is L+R and went over the rep cap while bestSetOf
// read each side's own reps, and a row with one side still unchecked is not `done` here but is completed
// work for the limb that finished it. The exercise then had a 1RM and no line in the PR table at once.
// An assistance machine is left out the same way (issue #232): the load is the help you were given.
// Warm-ups are skipped for the same reason bestSetOf() skips them (onerm.js): a heavy ramp row is not a
// record. Without this the coach's PR and the athlete's PR silently disagree for the same exercise.
function prTable(S, formula) {
  const byId = new Map()
  for (const w of (S.workouts || [])) {
    for (const e of (w.entries || [])) {
      const best = bestSetOf(e, formula)
      if (!best) continue
      const prev = byId.get(e.id)
      if (!prev || best.est > prev.est) {
        const ex = exerciseOf(e.id, S)
        // exId as well as exName: the consumer needs an id, not a name — exOr() treats any
        // string as both, so passing exName where exId belongs would silently "work" wrong.
        byId.set(e.id, { exId: e.id, exName: ex.n, bp: ex.bp || null, est: best.est, w: best.w, r: best.r, date: w.d })
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.est - a.est)
}

/* ---------- the 8 tools ---------- */

/** list_routines — names + counts of each routine in the user's plan. */
export const listRoutines = {
  name: 'list_routines',
  description: 'List the workout routines saved in the user\'s openGym profile (the same list the Plan screen shows). Each routine is a named set of exercises with set/rep targets. Use this to discover the plan structure before diving into a specific routine or today\'s workout.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return noState()
    return {
      unit: S.unit || 'kg',
      routines: (S.routines || []).map(r => ({
        id: r.id,
        name: r.name,
        emoji: r.emoji || null,
        exercise_count: (r.ex || []).length,
        superset_groups: [...new Set((r.ex || []).map(e => e.sg).filter(Boolean))].length || 0,
        policy: policyFor(null, r, 'reps'),
        exclude_from_progression: r.excludeFromProgression === true
      }))
    }
  }
}

/** get_routine — the full exercise list for one routine, including set/rep targets. */
export const getRoutine = {
  name: 'get_routine',
  description: 'Get the full exercise list for a single routine (the same view the routine editor shows). Returns mode (reps/time/cardio), set/rep/weight targets (a `pyramid` list of per-set rep targets, \'max\' meaning as many reps as possible, when the exercise uses pyramid sets, with `pyramid_rest_sec` and `pyramid_weight` per set where planned, 0 meaning the exercise\'s rest or last time\'s weight), superset links, any per-exercise custom increment or Epley deload factor, and each exercise\'s own rest in seconds (absent means it inherits the global rest timer). Use routine_id from list_routines.',
  schema: { routine_id: z.string().min(1) },
  handler: ({ routine_id }) => {
    const S = getState()
    if (!S) return noState()
    const r = (S.routines || []).find(x => x.id === routine_id)
    if (!r) { const e = new Error(`no routine with id ${JSON.stringify(routine_id)}`); e.code = 'ENOENT'; throw e }
    return {
      id: r.id,
      name: r.name,
      emoji: r.emoji || null,
      policy: policyFor(null, r, 'reps'),
      policy_name: policyName(policyFor(null, r, 'reps')),
      exclude_from_progression: r.excludeFromProgression === true,
      unit: S.unit || 'kg',
      exercises: (r.ex || []).map((cfg, i) => {
        const ex = exerciseOf(cfg.id, S)
        const mode = modeOf(cfg)
        return {
          position: i + 1,
          id: cfg.id,
          name: ex.n,
          body_part: ex.bp || null,
          mode,
          sets: cfg.sets || 1,
          reps: mode === 'reps' ? (cfg.reps || 0) : undefined,
          reps_min: mode === 'reps' && cfg.repsMin != null ? cfg.repsMin : undefined,
          reps_max: mode === 'reps' && cfg.repsMax != null ? cfg.repsMax : undefined,
          // Pyramid sets: one rep target per set, in order; 'max' is as many reps as possible.
          pyramid: mode === 'reps' && Array.isArray(cfg.pyramid) && cfg.pyramid.length ? cfg.pyramid : undefined,
          // Each pyramid set's own rest in seconds, 0 meaning the exercise's rest.
          pyramid_rest_sec: mode === 'reps' && Array.isArray(cfg.pyramid) && cfg.pyramid.length && Array.isArray(cfg.pyramidRest) && cfg.pyramidRest.length ? cfg.pyramidRest : undefined,
          // Each pyramid set's own planned weight (#445), 0 meaning it starts from that set last time.
          pyramid_weight: mode === 'reps' && Array.isArray(cfg.pyramid) && cfg.pyramid.length && Array.isArray(cfg.pyramidWeight) && cfg.pyramidWeight.length ? cfg.pyramidWeight : undefined,
          sec: mode === 'time' ? (cfg.sec || 0) : undefined,
          min: mode === 'cardio' ? (cfg.min || 0) : undefined,
          speed: mode === 'cardio' ? (cfg.speed || 0) : undefined,
          weight: cfg.weight != null ? cfg.weight : undefined,
          increment: cfg.inc != null ? cfg.inc : undefined,
          deload_factor: cfg.deloadFactor != null ? cfg.deloadFactor : undefined,
          // The exercise's own rest (issue #10). Absent means it inherits the global rest
          // timer; a superset rests once, taking the longest its members ask for.
          rest_sec: cfg.restSec > 0 ? cfg.restSec : undefined,
          policy: policyFor(cfg, r, mode),
          policy_override: cfg.prog || null,
          superset_group: cfg.sg || null,
          summary: exLine(cfg, S.unit || 'kg')
        }
      })
    }
  }
}

/** get_week_plan — what's scheduled each weekday + today, and the coach week when one is running. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const getWeekPlan = {
  name: 'get_week_plan',
  description: 'Show the user\'s training plan. `days` is the authoritative answer to "what is planned when": the next seven dates from today with the routines planned for each (a date can hold several — a combined day) and how each was decided: a coach-week session ("coach"), a session the user pinned to that date ("pinned"), a one-off routine override ("override"), a "rest" override ("rest_override"), the weekday plan ("weekday") or nothing ("rest"). `coach_week` is the current coach week when one is running (a week written by an external planner through the API, never by the app): its sessions are done IN ORDER on whatever days the user trains (no weekday attached), the first undone one is today\'s session, a session can be pinned to a date, and `waiting` means the week starts on `starts_on`. `weekdays` is the user\'s own weekly plan keyed by JS getDay() (Sunday=0 … Saturday=6, the openGym state convention) — in a coach week it holds only the routines the user planned themselves, which ride along beside the coach-week session.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return noState()
    const today = new Date()
    const isoToday = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
    const todayWd = today.getDay()
    const routines = S.routines || []
    const nameOf = id => routines.find(x => x.id === id)?.name || null
    // A weekday holds a routine-id list (combine routines); older states hold one id.
    const weekdayIds = d => [].concat(S.week?.[d] || []).filter(id => routines.some(x => x.id === id))
    const todayIds = effectiveRoutineIds(S, isoToday, isoToday)
    const view = queueView(S, isoToday)
    // How a date's plan was decided — the same precedence as effectiveRoutineIds, named.
    const plannedBy = (iso, ids) => {
      const ov = S.dayPlan?.[iso]
      if (ov === 'rest') return 'rest_override'
      const pin = pinState(S, ov)
      if (pin === 'open') return 'pinned'
      if (!pin && ov && routines.some(x => x.id === ov)) return 'override'
      if (ids.length && queueNext(S, iso, isoToday) === ids[0]) return 'coach'
      return ids.length ? 'weekday' : 'rest'
    }
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i, 12)
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const ids = effectiveRoutineIds(S, iso, isoToday)
      return { date: iso, weekday: d.getDay(), weekday_name: DAY_NAMES[d.getDay()], routine_ids: ids, routine_names: ids.map(nameOf), planned_by: plannedBy(iso, ids) }
    })
    return {
      today: isoToday,
      today_routine_id: todayIds[0] ?? null,
      today_routine_name: todayIds.length ? nameOf(todayIds[0]) : null,
      today_routine_ids: todayIds,
      today_routine_names: todayIds.map(nameOf),
      coach_week: view ? {
        label: view.label,
        starts_on: view.startsOn,
        waiting: view.waiting,
        complete: view.complete,
        // state: done | next (today's session) | pinned (to `pinned_to`) | later
        sessions: view.items.map(i => ({ routine_id: i.id, routine_name: i.name, state: i.state, pinned_to: i.on ?? null }))
      } : null,
      days,
      weekdays: [0, 1, 2, 3, 4, 5, 6].map(d => {
        const ids = weekdayIds(d)
        // Surface today's override only (not the whole dayPlan dict — usually empty, but might
        // have grown from repeated "move this day" actions).
        const overrideForToday = d === todayWd ? (S.dayPlan?.[isoToday] ?? null) : null
        return {
          weekday: d,
          weekday_name: DAY_NAMES[d],
          routine_ids: ids,
          routine_names: ids.map(nameOf),
          routine_id: ids[0] ?? null,
          routine_name: ids.length ? nameOf(ids[0]) : null,
          routine_emoji: ids.length ? (routines.find(x => x.id === ids[0])?.emoji || null) : null,
          override_for_today_or_null: overrideForToday
        }
      })
    }
  }
}

/** list_workouts — newest-first summary of recent sessions. */
export const listWorkouts = {
  name: 'list_workouts',
  description: 'List recent finished workouts, newest first. Each item summarises the date, exercise count, sets done / planned, total volume (in the user\'s unit), duration and whether PRs were set. Use this before drilling into a specific date with get_workout.',
  schema: {
    from: isoDate().optional().describe('Inclusive start date YYYY-MM-DD. Defaults to no lower bound (list most recent).'),
    to: isoDate().optional().describe('Inclusive end date YYYY-MM-DD. Defaults to today.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max items to return. Defaults to 25.')
  },
  handler: ({ from, to, limit }) => {
    const S = getState()
    if (!S) return noState()
    const lim = Math.min(Math.max(limit || 25, 1), 200)
    // `to` is documented as defaulting to today, and had no default at all. A row dated in the
    // future — another device with a wrong clock — was listed first as the most recent session.
    const hi = to || todayIso()
    const all = (S.workouts || []).slice().sort((a, b) => (b.d || '').localeCompare(a.d || ''))
    const matching = all.filter(w => {
      if (from && w.d < from) return false
      if (w.d > hi) return false
      return true
    })
    const filtered = matching.slice(0, lim)
    return {
      unit: S.unit || 'kg',
      // total_count is all-time and predates the filter — kept as it is, since callers read it
      // that way. matching_count is how many are in the from/to range, and truncated says the
      // limit cut the list: without them "how many sessions did I do in March" was unanswerable,
      // because 25 rows and a total of 340 say nothing about the 40 in March.
      total_count: all.length,
      matching_count: matching.length,
      returned_count: filtered.length,
      truncated: filtered.length < matching.length,
      workouts: filtered.map(w => ({
        // The only thing that identifies a session uniquely. Two workouts on one day is
        // ordinary — a lifting session and an evening run — and without an id here the second
        // one cannot be asked about at all.
        id: w.id || null,
        date: w.d,
        routine_id: w.routineId || null,
        routine_name: w.name || null,
        exercise_count: (w.entries || []).length,
        sets_done: setsDone(w),
        sets_planned: plannedSets(w),
        sets_ratio: ratio(setsDone(w), plannedSets(w)),
        volume: workoutVolume(w),
        duration_ms: w.end && w.start ? (w.end - w.start) : null,
        duration: w.end && w.start ? friendlyDuration(w.end - w.start) : null,
        prs: (w.prs || []).length,
        bodyweight_at_workout: w.bw || null
      }))
    }
  }
}

function plannedSets(w) {
  let n = 0
  ;(w.entries || []).forEach(e => { n += (e.sets || []).length })
  return n
}

/** get_workout — full entry/set breakdown for one date. */
export const getWorkout = {
  name: 'get_workout',
  description: 'Get the full breakdown of one workout: every exercise, its mode (reps/time/cardio), the target, and per-set labels (e.g. "5 @ 60 kg", "1:30 · 20 kg"). Identify it by workout_id (from list_workouts) or by date. Use list_workouts first if you don\'t know either.',
  schema: {
    date: isoDate().optional().describe('The workout date as YYYY-MM-DD. If two sessions share that date, the answer lists them instead and asks for a workout_id.'),
    workout_id: z.string().min(1).optional().describe('The id from list_workouts. Preferred: it names one session even on a day with two.')
  },
  handler: ({ date, workout_id }) => {
    const S = getState()
    if (!S) return noState()
    const workouts = S.workouts || []
    let w
    if (workout_id) {
      w = workouts.find(x => x.id === workout_id)
      if (!w) { const e = new Error(`no workout with id ${workout_id}`); e.code = 'ENOENT'; throw e }
    } else if (date) {
      const sameDay = workouts.filter(x => x.d === date)
      if (!sameDay.length) { const e = new Error(`no workout on ${date}`); e.code = 'ENOENT'; throw e }
      // Answering with the first of two is how a question about the evening run gets the
      // morning's lifting numbers, stated with total confidence. Say there are two instead.
      if (sameDay.length > 1) {
        return {
          ambiguous: true,
          date,
          message: `${sameDay.length} workouts were logged on ${date} — call get_workout again with one of these workout_id values.`,
          workouts: sameDay.map(x => ({
            id: x.id || null,
            routine_name: x.name || null,
            sets_done: setsDone(x),
            volume: workoutVolume(x),
            duration: x.end && x.start ? friendlyDuration(x.end - x.start) : null
          }))
        }
      }
      w = sameDay[0]
    } else {
      const e = new Error('get_workout needs either workout_id or date'); e.code = 'EINVAL'; throw e
    }
    return {
      id: w.id || null,
      date: w.d,
      routine_id: w.routineId || null,
      routine_name: w.name || null,
      unit: S.unit || 'kg',
      bodyweight_at_workout: w.bw || null,
      volume: workoutVolume(w),
      sets_done: setsDone(w),
      sets_planned: plannedSets(w),
      duration: w.end && w.start ? friendlyDuration(w.end - w.start) : null,
      prs: (w.prs || []).map(id => {
        const ex = exerciseOf(id, S)
        return ex.missing ? id : ex.n
      }),
      entries: (w.entries || []).map(e => entryView(e, S))
    }
  }
}

/** get_bodyweight — recent weigh-ins with the goal line. */
export const getBodyweight = {
  name: 'get_bodyweight',
  description: 'Get the body-weight log: chronological weigh-ins with weights, current goal, deltas vs goal (signed positive = above goal), and a latest summary. Useful for "am I trending toward my weight goal?" questions.',
  schema: {
    from: isoDate().optional().describe('Inclusive start date YYYY-MM-DD.'),
    to: isoDate().optional().describe('Inclusive end date YYYY-MM-DD. Defaults to today.')
  },
  handler: ({ from, to }) => {
    const S = getState()
    if (!S) return noState()
    const goal = S.targetW || null
    // Same documented default as list_workouts: a future-dated weigh-in is not "latest".
    const hi = to || todayIso()
    const bw = (S.bodyweight || []).filter(b => {
      if (from && b.d < from) return false
      if (b.d > hi) return false
      return true
    }).sort((a, b) => (a.d || '').localeCompare(b.d || ''))
    const latest = bw.length ? bw[bw.length - 1] : null
    return {
      unit: S.unit || 'kg',
      goal,
      count: bw.length,
      latest: latest ? { date: latest.d, weight: latest.w, delta_vs_goal: goal != null ? Math.round((latest.w - goal) * 10) / 10 : null } : null,
      entries: bw.map(b => ({
        date: b.d,
        weight: b.w,
        delta_vs_goal: goal != null ? Math.round((b.w - goal) * 10) / 10 : null
      }))
    }
  }
}

/** estimate_1rm — best-ever 1RM for one exercise or a PR table across all reps-mode exercises. */
export const estimate1rm = {
  name: 'estimate_1rm',
  description: `Estimate one-rep max using Epley, Brzycki or Lombardi formulas. If an exercise_id is given, returns the all-time best estimate for that exercise with the source set (weight × reps + date) and the trend across history. If no exercise_id is given, returns a PR table across all reps-mode exercises (sorted highest first). Refuses to guess above ${REP_CAP} reps — above that, formulas diverge past 10% and "work capacity" is read instead of "maximal strength".`,
  schema: {
    // .min(1): an empty string is falsy, so it used to fall through to "no exercise_id given" and
    // answer a question about one exercise with the whole PR table.
    exercise_id: z.string().min(1).optional().describe('An exercise id from list_routines or get_workout entries. If omitted, returns a full PR table.'),
    formula: z.enum(['epley', 'brzycki', 'lombardi']).optional().describe(`Formula to use. Defaults to ${DEFAULT_FORMULA}.`)
  },
  handler: ({ exercise_id, formula }) => {
    const S = getState()
    if (!S) return noState()
    const f = formula || DEFAULT_FORMULA
    if (exercise_id) {
      const ex = exerciseOf(exercise_id, S)
      const best = best1RM(S, exercise_id, f)
      const series = e1rmSeries(S, exercise_id, f)
      // A null best has two very different causes: never trained, or trained only above the
      // rep cap. Without saying which, an exercise logged for years at 15 reps reads as "no
      // records for calf raise" — a confident statement about the opposite of the truth.
      const trainedAtAll = (S.workouts || []).some(w =>
        (w.entries || []).some(e => e.id === exercise_id && (e.sets || []).some(s => s.done)))
      // exOr's miss is a placeholder named "Unknown exercise", not null. A typo'd or made-up id
      // therefore came back as "No completed sets logged for this exercise" — a statement about
      // the athlete's training, when the truth is that no such exercise exists. A deleted custom
      // is unknown to the catalogue too, but it has logged sets, so it keeps the real answer.
      const unknown = !!ex.missing && !trainedAtAll
      // w/r (not weight/reps) matches pr_table and entry-view — every set in the API surface uses the same couple.
      return {
        exercise: { id: exercise_id, name: ex.n, body_part: ex.bp || null, ...(unknown ? { unknown: true } : {}) },
        formula: f,
        formula_note: `Estimates use the ${f} formula. Cap at ${REP_CAP} reps applies; r=1 is treated as the measurement, not an estimate.`,
        best: best ? { est: best.est, w: best.w, r: best.r, date: best.d } : null,
        no_estimate_reason: best ? null
          : trainedAtAll
            ? `This exercise has logged sets, but none of them qualify: every set was above the ${REP_CAP}-rep cap, or carried no weight. That is not the same as never having trained it.`
            : unknown
              ? `No exercise with id ${JSON.stringify(exercise_id)} exists — not in the catalogue, not among this profile's custom exercises, and nothing is logged against it. Check the id against list_routines or a get_workout entry.`
              : 'No completed sets logged for this exercise.',
        trend: series.map(p => ({ date: p.d, est: p.y, w: p.w, r: p.r }))
      }
    }
    return {
      formula: f,
      formula_note: `Estimates use the ${f} formula. Cap at ${REP_CAP} reps applies; r=1 is treated as the measurement, not an estimate.`,
      pr_table: prTable(S, f)
    }
  }
}

/** muscle_balance — training distribution per muscle over a period (week/month/all). */
export const muscleBalance = {
  name: 'muscle_balance',
  description: 'Show which muscles the user has trained in a period, ranked by "effective sets" (volume in kg is intentionally not used — 100 kg leg press vs 12 kg lateral raise say nothing about which muscle worked harder). Reports worked muscles with a 0-4 relative level (1 = some work, 4 = most worked) and the muscles trained zero times in that period — useful for "what am I neglecting?" questions.',
  schema: {
    period: z.enum(['week', 'month', 'all']).describe('window: last 7 days, last 30 days, or all-time')
  },
  handler: ({ period }) => {
    const S = getState()
    if (!S) return noState()
    // Whole local days, counting today: a week is the 7 dates ending today, a month the 30. The
    // cutoff used to be an instant 7 x 24h back, which for the workouts that carry no clock — an
    // import, a hand-added session; they fall back to their date at local noon — pulled in an
    // EIGHTH calendar date, the one 7 days ago. "Last 7 days" listing 8 of them.
    const now = new Date()
    const midnightDaysBack = n => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime()
    const cutoff = period === 'week' ? midnightDaysBack(6)
      : period === 'month' ? midnightDaysBack(29)
        : Number.NEGATIVE_INFINITY
    const workouts = (S.workouts || []).filter(w => workoutAt(w) >= cutoff)
    // loadOf() resolves each entry through EXIDX, which holds the catalogue only, so a
    // custom exercise's sets score zero here. Attaching the custom itself lets loadOf's own
    // `historical` branch resolve it. Only a *found* custom: exOr's miss placeholder carries
    // no muscle metadata and no muscleSnapshot, so attaching that would displace the entry
    // and silently zero a *deleted* custom, whose snapshot loadOf reads off the entry
    // (muscles.js:245 → metadataOf, snapshot written at sheets.jsx:421-426).
    const load = loadOfWorkouts(workouts.map(w => ({
      ...w,
      entries: (w.entries || []).map(e => {
        const c = e.exercise ? null : customOf(e.id, S)
        return c ? { ...e, exercise: c } : e
      })
    })))
    const { worked, missed } = rankOf(load)
    const levels = levelsOf(load)
    return {
      period,
      // Local, like every other date this API reports (get_week_plan.today, every workout date).
      // toISOString() reads UTC, so late in the evening west of Greenwich the reported cutoff was
      // the day AFTER the one the filter used, and east of Greenwich the day before.
      cutoff_iso: period === 'all' ? null : localIso(new Date(cutoff)),
      workouts_in_period: workouts.length,
      worked: worked.map(slug => ({ slug, name: muscleName(slug), level: levels[slug], effective_sets: Math.round((load[slug] || 0) * 10) / 10 })),
      neglected: missed.map(slug => ({ slug, name: muscleName(slug) })),
      muscle_order_head_to_toe: muscleOrder()
    }
  }
}

/* ---------- preview_session ---------- */

// Where a number on the session screen actually came from. A routine's own weight is the LAST
// fallback, not the first: buildSets() takes the weight of this routine's last session of the
// exercise (any routine's, when this one never trained it), then the confirmed working weight,
// and applyPrescription() then overwrites it with whatever the progression policy decided. The
// reps are the routine's own unless the profile starts planned sessions from the last session
// (startFrom 'last'), or a policy that moves reps moved them. Reporting the winner is the whole
// point of this tool — "the plan says 60" is not an answer to "what will the app show me".
function sourceOf(S, cfg, plan, field, routine) {
  // Progression off (or a deload routine): the session is built from the routine's own target,
  // exactly as session-start.js does with useTarget — history and the confirmed weight are ignored.
  if (!plan || plan.kind === 'off') return 'routine_plan'
  const decided = plan.kind !== 'first' && plan[field] != null
  // A policy that settles on the routine's own reps or hold — a restart after the plan was
  // edited, a bodyweight hold at the plan's count — is the plan speaking, not an override.
  if (decided) return field !== 'weight' && plan[field] === cfg[field] ? 'routine_plan' : 'progression'
  const last = lastEntryFor(S, cfg.id, routine && routine.id)
  if (field === 'reps') return startsFromLast(S) && last ? 'last_session' : 'routine_plan'
  if (last) return 'last_session'
  const conf = (S.exWeights || {})[cfg.id]
  return conf && conf.w > 0 ? 'confirmed_weight' : 'routine_plan'
}

const SOURCE_TEXT = {
  progression: 'the progression policy overrode the routine',
  confirmed_weight: 'your confirmed working weight for this exercise',
  last_session: 'carried over from the last time this routine had this exercise (or any routine, if this one never has)',
  routine_plan: "the routine's own target"
}

/** preview_session — what starting this routine will actually put on screen. */
export const previewSession = {
  name: 'preview_session',
  description:
    'Preview the session a routine will actually open with — the numbers the user will see after the progression policy and their training history have overridden the routine\'s own targets. This is NOT the same as get_routine: a routine storing "squat 3x8 @ 60kg" can open at 75kg because the policy progressed or deloaded from that routine\'s last logged session. The reps are the routine\'s own unless a policy that moves reps moved them, or the profile starts planned sessions from the last session (starts_from). Always call this (not get_routine) before telling someone what weight they are about to lift, or before judging whether an edit to a routine had any effect. Returns, per exercise, the planned target, the policy\'s decision and its stated reason, the opening set rows, and where each number came from. Defaults to today\'s scheduled routine.',
  schema: {
    routine_id: z.string().min(1).optional().describe('Routine to preview. Defaults to the routine scheduled for `date`.'),
    date: isoDate().optional().describe('Date the session would be started on, YYYY-MM-DD. Affects which routine is scheduled and any one-off day override. Defaults to today.')
  },
  handler: ({ routine_id, date }) => {
    const S = getState()
    if (!S) return noState()
    const now = new Date()
    const iso = date || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'))

    let r
    if (routine_id) {
      r = (S.routines || []).find(x => x.id === routine_id)
      if (!r) { const e = new Error(`no routine with id ${JSON.stringify(routine_id)}`); e.code = 'ENOENT'; throw e }
    } else {
      r = effectiveRoutine(S, iso)
      if (!r) return { date: iso, routine_id: null, routine_name: null, rest_day: true, note: 'no routine is scheduled for this date (rest day)', exercises: [] }
    }

    const unit = S.unit || 'kg'
    // The same builder the app starts a session with (sheets.jsx beginWorkout → session-start.js):
    // prescription, step, progression-off targets, deload routines and warm-up ramps all come from
    // there, so the preview cannot drift from what the screen shows.
    const built = withCustomsIndexed(S, () => buildSessionEntries(S, r))
    const exercises = (r.ex || []).map((cfg, i) => {
      const ex = exerciseOf(cfg.id, S)
      const mode = modeOf({ ...cfg, id: cfg.id })
      const plan = built[i].plan
      const rows = built[i].sets
      const work = rows.filter(s => !isWarmupRow(s))
      const openW = work.length ? (work[0].w || 0) : 0
      const openR = work.length ? (work[0].r || 0) : 0
      const openSec = work.length ? (work[0].sec || 0) : 0
      const openMin = work.length ? (work[0].min || 0) : 0
      const wSrc = sourceOf(S, cfg, plan, 'weight', r)
      const rSrc = sourceOf(S, cfg, plan, 'reps', r)
      return {
        position: i + 1,
        id: cfg.id,
        name: ex.n,
        mode,
        policy: plan.policy,
        policy_name: policyName(plan.policy),
        planned: {
          sets: cfg.sets || 1,
          reps: mode === 'reps' ? (cfg.reps || 0) : undefined,
          sec: mode === 'time' ? (cfg.sec || 0) : undefined,
          min: mode === 'cardio' ? (cfg.min || 0) : undefined,
          weight: cfg.weight != null ? cfg.weight : undefined,
          summary: exLine(cfg, unit)
        },
        prescription: {
          kind: plan.kind,
          weight: plan.weight != null ? plan.weight : undefined,
          reps: plan.reps != null ? plan.reps : undefined,
          sets: plan.sets != null ? plan.sets : undefined,
          // Triple progression aims each set on its own ("12, 12, 12, 9"); `reps` is the first set's.
          row_reps: Array.isArray(plan.rowReps) ? plan.rowReps : undefined,
          sec: plan.sec != null ? plan.sec : undefined,
          why: plan.why ? fmt(plan.why[0], plan.why.slice(1)) : null
        },
        opening_sets: rows.map(s => ({
          phase: isWarmupRow(s) ? 'warmup' : 'work',
          type: s.type || 'straight',
          ...(isFailureSet(s) ? { failure: true } : {}),
          label: setLabel(cfg.id, { ...s, done: undefined }, { ...cfg, id: cfg.id }),
          w: Number(s.w) || 0,
          r: Number(s.r) || 0,
          sec: Number(s.sec) || 0,
          min: Number(s.min) || 0,
          speed: Number(s.speed) || 0
        })),
        weight_source: wSrc,
        weight_source_text: SOURCE_TEXT[wSrc],
        reps_source: mode === 'reps' ? rSrc : undefined,
        reps_source_text: mode === 'reps' ? SOURCE_TEXT[rSrc] : undefined,
        // The headline: did editing the routine change anything the user will see? Tracked per
        // dimension — a bodyweight exercise whose weight is 0 either way still counts when the
        // rep target moved, and saying which one moved saves the caller diffing it themselves.
        changed: [
          ...(mode === 'reps' && cfg.weight != null && openW !== cfg.weight ? ['weight'] : []),
          ...(mode === 'reps' && (cfg.reps || 0) > 0 && openR !== cfg.reps ? ['reps'] : []),
          ...(mode === 'time' && (cfg.sec || 0) > 0 && openSec !== cfg.sec ? ['sec'] : []),
          ...(mode === 'cardio' && (cfg.min || 0) > 0 && openMin !== cfg.min ? ['min'] : [])
        ],
        differs_from_plan:
          (mode === 'reps' && cfg.weight != null && openW !== cfg.weight) ||
          (mode === 'reps' && (cfg.reps || 0) > 0 && openR !== cfg.reps) ||
          (mode === 'time' && (cfg.sec || 0) > 0 && openSec !== cfg.sec) ||
          (mode === 'cardio' && (cfg.min || 0) > 0 && openMin !== cfg.min)
      }
    })

    const differing = exercises.filter(e => e.differs_from_plan)
    return {
      date: iso,
      routine_id: r.id,
      routine_name: r.name,
      unit,
      // The profile's "Planned sessions start from" setting: 'plan' opens at the routine's own
      // reps, 'last_session' carries them over from the last time.
      starts_from: startsFromLast(S) ? 'last_session' : 'plan',
      policy: policyFor(null, r, 'reps'),
      policy_name: policyName(policyFor(null, r, 'reps')),
      exercises,
      // Surfaced separately so a coach reading this cannot miss it: these are the exercises
      // where what the routine stores and what the athlete will see are two different numbers.
      overridden_count: differing.length,
      overridden: differing.map(e => ({
        name: e.name,
        planned_weight: e.planned.weight,
        opening_weight: e.opening_sets.filter(s => s.phase === 'work')[0]?.w ?? null,
        planned_reps: e.planned.reps,
        opening_reps: e.opening_sets.filter(s => s.phase === 'work')[0]?.r ?? null,
        planned_sec: e.planned.sec,
        opening_sec: e.opening_sets.filter(s => s.phase === 'work')[0]?.sec ?? null,
        planned_min: e.planned.min,
        opening_min: e.opening_sets.filter(s => s.phase === 'work')[0]?.min ?? null,
        changed: e.changed,
        reason: e.prescription.why || e.weight_source_text
      }))
    }
  }
}


/* ---------- write helpers ---------- */


// The exercise catalog is EXDB + the user's custom exercises. The app merges customs into
// EXIDX via registerCustom; the MCP must do the same before validating exercise ids, or a
// routine built around a custom exercise would be rejected as "unknown".
function withCustomExercises(S) {
  registerCustom(S.customEx || [])
}

function requireRoutine(S, routine_id) {
  const r = (S.routines || []).find(x => x.id === routine_id)
  if (!r) { const e = new Error(`no routine with id ${JSON.stringify(routine_id)}`); e.code = 'ENOENT'; throw e }
  return r
}

function requireExercise(r, exercise_id) {
  const cfg = (r.ex || []).find(x => x.id === exercise_id)
  if (!cfg) { const e = new Error(`no exercise ${JSON.stringify(exercise_id)} in routine ${JSON.stringify(r.name)}`); e.code = 'ENOENT'; throw e }
  return cfg
}

function assertKnownExercise(id) {
  if (!EXIDX[id]) { const e = new Error(`unknown exercise id ${JSON.stringify(id)} — not in the exercise catalog`); e.code = 'EINVAL'; throw e }
}

// The scaled copy of a routine's exercises a deload applies: weight × factor (snapped to the
// exercise's increment), sets rounded down (never below 1). Reps and time targets stay put —
// a deload cuts load and volume, not the rep scheme.
function scaleExercises(ex, factor) {
  return (ex || []).map(cfg => {
    const o = { ...cfg }
    if (o.weight > 0) o.weight = snapWeight(o.weight * factor, o.inc > 0 ? o.inc : 1)
    if (o.sets > 1) o.sets = Math.max(1, Math.round(o.sets * factor))
    return o
  })
}

const POLICY_ENUM = ['off', 'linear', 'greyskull', 'double', 'time']

// One exercise config as the write tools accept it. weight may be 0 (bodyweight work); sets
// must be ≥ 1; inc must be positive when given. Mode-specific fields (sec/min/speed) are
// optional and only meaningful for their mode — the app's modeOf() decides from the id.
const exerciseSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(['reps', 'time', 'cardio']).optional().describe('How the exercise is logged. Defaults to reps (or cardio for cardio-catalog exercises). Timed holds (plank, farmer\'s carry) need mode: "time".'),
  sets: z.number().int().min(1).optional(),
  reps: z.number().int().min(1).optional(),
  repsMin: z.number().int().min(1).optional(),
  repsMax: z.number().int().min(1).optional(),
  weight: z.number().min(0).optional(),
  inc: z.number().positive().optional(),
  sg: z.string().optional(),
  policy: z.enum(POLICY_ENUM).optional(),
  sec: z.number().positive().optional(),
  min: z.number().positive().optional(),
  speed: z.number().positive().optional()
})

/* ---------- the 7 write tools ---------- */

/** create_routine — a new routine with its exercise list. */
export const createRoutine = {
  name: 'create_routine',
  description: 'Create a new workout routine with a name and a list of exercises, each with set/rep/weight targets (and optional increment, superset group, or per-exercise progression policy). Exercise ids must come from the catalog (get_routine/list_routines return them). Persists directly into the openGym state.',
  schema: {
    name: z.string().min(1).describe('Routine name, e.g. "Push Day".'),
    emoji: z.string().optional().describe('Optional emoji shown next to the routine name.'),
    prog: z.enum(POLICY_ENUM).optional().describe('Default progression policy for the routine.'),
    exercises: z.array(exerciseSchema).min(1).describe('Exercises with their targets. At least one.')
  },
  handler: ({ name, emoji, prog, exercises }) => {
    const S = getState()
    if (!S) return noState()
    // Handler-level validation: the SDK applies the zod schema before the handler in
    // production, but the handler is the last line of defence for destructive writes.
    if (!exercises || !exercises.length) {
      const e = new Error('create_routine needs at least one exercise')
      e.code = 'EINVAL'
      throw e
    }
    withCustomExercises(S)
    exercises.forEach(e => assertKnownExercise(e.id))
    const id = crypto.randomUUID()
    return writeState(st => {
      st.routines = [...(st.routines || []), { id, name, emoji: emoji || null, ...(prog ? { prog } : {}), ex: exercises.map(e => ({ ...e })) }]
      return st
    }).then(() => ({ id, name, exercise_count: exercises.length }))
  }
}

/** update_routine — replace the structure of an existing routine. */
export const updateRoutine = {
  name: 'update_routine',
  description: 'Replace the structure of an existing routine: name, emoji, default policy, and/or the full exercise list. Exercises not listed are removed — pass the complete desired exercise list. Use routine_id from list_routines.',
  schema: {
    routine_id: z.string().min(1),
    name: z.string().min(1).optional(),
    emoji: z.string().nullable().optional(),
    prog: z.enum(POLICY_ENUM).nullable().optional(),
    exercises: z.array(exerciseSchema).min(1).optional()
  },
  handler: ({ routine_id, name, emoji, prog, exercises }) => {
    const S = getState()
    if (!S) return noState()
    requireRoutine(S, routine_id)
    if (exercises) {
      withCustomExercises(S)
      exercises.forEach(e => assertKnownExercise(e.id))
    }
    return writeState(st => {
      const r = requireRoutine(st, routine_id)
      if (name != null) r.name = name
      if (emoji !== undefined) r.emoji = emoji
      if (prog !== undefined) r.prog = prog || undefined
      if (exercises) r.ex = exercises.map(e => ({ ...e }))
      return st
    }).then(() => ({ routine_id, name: name ?? requireRoutine(S, routine_id).name, exercise_count: exercises ? exercises.length : undefined }))
  }
}

/** delete_routine — remove a routine and its week-plan assignments. */
export const deleteRoutine = {
  name: 'delete_routine',
  description: 'Delete a routine and remove it from the week plan (a weekday that held only this routine becomes rest; a combined day keeps its other routines) and from any per-date reschedule. Irreversible — the pre-write backup in the MCP metadata file is the only recovery path.',
  schema: { routine_id: z.string().min(1) },
  handler: ({ routine_id }) => {
    const S = getState()
    if (!S) return noState()
    requireRoutine(S, routine_id)
    return writeState(st => {
      // The app's own delete: pulls the id out of every weekday's routine list (a combined
      // day keeps its other routines), and drops per-date reschedules that name it.
      st.routines = st.routines || []
      deleteRoutineInState(st, routine_id)
      return st
    }).then(() => ({ deleted: routine_id }))
  }
}

/** progress_exercise — raise weight and/or reps of one exercise in a routine. */
export const progressExercise = {
  name: 'progress_exercise',
  description: 'Progress one exercise in a routine: raise the weight target by the exercise\'s increment (or an explicit weight_increment) and the rep target by the rep step (or an explicit reps_increment). For bodyweight exercises (weight 0) only reps move; for timed exercises the duration target rises by 5 s. Cardio exercises cannot be progressed this way — adjust min/speed via update_routine.',
  schema: {
    routine_id: z.string().min(1),
    exercise_id: z.string().min(1),
    weight_increment: z.number().positive().optional().describe('Explicit weight step. Defaults to the exercise\'s increment (5 kg lower body / 2.5 kg upper body in kg units).'),
    reps_increment: z.number().int().positive().optional().describe('Explicit rep step. Defaults to the exercise\'s rep step (2 for unilateral work, else 1).')
  },
  handler: ({ routine_id, exercise_id, weight_increment, reps_increment }) => {
    const S = getState()
    if (!S) return noState()
    const r = requireRoutine(S, routine_id)
    const cfg = requireExercise(r, exercise_id)
    const mode = modeOf({ ...cfg, id: cfg.id })
    if (mode === 'cardio') {
      const e = new Error('cardio exercises have no weight/reps to progress — adjust min/speed via update_routine')
      e.code = 'EINVAL'
      throw e
    }
    const unit = S.unit || 'kg'
    if (weight_increment != null && weight_increment <= 0) {
      const e = new Error('weight_increment must be a positive number')
      e.code = 'EINVAL'
      throw e
    }
    if (reps_increment != null && reps_increment <= 0) {
      const e = new Error('reps_increment must be a positive integer')
      e.code = 'EINVAL'
      throw e
    }
    const wInc = weight_increment ?? (cfg.weight > 0 ? defaultIncrement(cfg.id, unit) : 0)
    const rInc = reps_increment ?? repStepOf(cfg)
    return writeState(st => {
      const rr = requireRoutine(st, routine_id)
      const cc = requireExercise(rr, exercise_id)
      if (mode === 'time') {
        cc.sec = (cc.sec || 0) + (weight_increment ?? DEFAULT_SEC_INCREMENT)
      } else {
        if (cc.weight > 0) cc.weight = snapWeight((cc.weight || 0) + wInc, wInc)
        if (cc.reps != null) {
          cc.reps = (cc.reps || 0) + rInc
          if (cc.repsMin != null) cc.repsMin = (cc.repsMin || 0) + rInc
        }
      }
      return st
    }).then(() => {
      const after = requireExercise(requireRoutine(getState(), routine_id), exercise_id)
      return {
        routine_id, exercise_id,
        // weight 0 means bodyweight work — surface null so the LLM reads "no load", not "0 kg".
        weight: after.weight > 0 ? after.weight : null,
        reps: after.reps ?? null,
        reps_min: after.repsMin ?? null,
        sec: after.sec ?? null,
        mode
      }
    })
  }
}

/** swap_exercise — replace one exercise with another, keeping the target structure. */
export const swapExercise = {
  name: 'swap_exercise',
  description: 'Replace one exercise in a routine with another from the catalog. The replacement keeps the original\'s sets/reps/weight/increment/superset structure — adjust targets afterwards with update_routine if the new exercise needs different numbers.',
  schema: {
    routine_id: z.string().min(1),
    exercise_id: z.string().min(1).describe('The exercise to replace.'),
    new_exercise_id: z.string().min(1).describe('The catalog exercise to put in its place.')
  },
  handler: ({ routine_id, exercise_id, new_exercise_id }) => {
    const S = getState()
    if (!S) return noState()
    withCustomExercises(S)
    assertKnownExercise(new_exercise_id)
    const r = requireRoutine(S, routine_id)
    requireExercise(r, exercise_id)
    return writeState(st => {
      const rr = requireRoutine(st, routine_id)
      const cc = requireExercise(rr, exercise_id)
      cc.id = new_exercise_id
      return st
    }).then(() => ({ routine_id, replaced: exercise_id, with: new_exercise_id }))
  }
}

/** schedule_deload — scale a routine's load down and remember the original. */
export const scheduleDeload = {
  name: 'schedule_deload',
  description: 'Apply a deload to a routine: scale every weighted exercise\'s target down by factor (default 0.6) and reduce set counts, so the week is genuinely easier. The original targets are snapshotted in the MCP metadata file; cancel_deload restores them. Only one active deload per routine.',
  schema: {
    routine_id: z.string().min(1),
    factor: z.number().min(0.3).max(0.9).optional().describe('Load factor, e.g. 0.6 = 60% of normal weight. Defaults to 0.6.')
  },
  handler: ({ routine_id, factor }) => {
    const S = getState()
    if (!S) return noState()
    const f = factor ?? 0.6
    if (f < 0.3 || f > 0.9) {
      const e = new Error('factor must be between 0.3 and 0.9')
      e.code = 'EINVAL'
      throw e
    }
    requireRoutine(S, routine_id)
    return writeState(st => {
      const rr = requireRoutine(st, routine_id)
      const meta = readMeta()
      if (meta.deloads[routine_id]) {
        const e = new Error(`routine ${JSON.stringify(rr.name)} already has an active deload — cancel_deload first`)
        e.code = 'EALREADY'
        throw e
      }
      meta.deloads[routine_id] = {
        originalEx: JSON.parse(JSON.stringify(rr.ex || [])),
        factor: f,
        scheduledAt: new Date().toISOString()
      }
      writeMeta(meta)
      rr.ex = scaleExercises(rr.ex, f)
      return st
    }).then(() => ({ routine_id, factor: f, deloaded: true }))
  }
}

/** cancel_deload — restore a routine's original targets from the snapshot. */
export const cancelDeload = {
  name: 'cancel_deload',
  description: 'Cancel an active deload and restore the routine\'s original targets from the snapshot taken at schedule_deload. Reports a warning if the routine was modified while the deload was active (the snapshot is restored regardless).',
  schema: { routine_id: z.string().min(1) },
  handler: ({ routine_id }) => {
    const S = getState()
    if (!S) return noState()
    const r = requireRoutine(S, routine_id)
    const meta = readMeta()
    const snap = meta.deloads[routine_id]
    if (!snap) {
      const e = new Error(`no active deload for routine ${JSON.stringify(r.name)}`)
      e.code = 'ENOENT'
      throw e
    }
    // Detect manual edits during the deload: compare the current exercises against the
    // scaled snapshot. If they differ, the user changed something in the app meanwhile.
    const scaled = scaleExercises(snap.originalEx, snap.factor)
    const changed = JSON.stringify(r.ex || []) !== JSON.stringify(scaled)
    return writeState(st => {
      const rr = requireRoutine(st, routine_id)
      rr.ex = JSON.parse(JSON.stringify(snap.originalEx))
      return st
    }).then(() => {
      const m2 = readMeta()
      delete m2.deloads[routine_id]
      writeMeta(m2)
      return {
        routine_id,
        restored: true,
        warning: changed
          ? 'routine was modified while the deload was active — original snapshot restored anyway; review the routine'
          : null
      }
    })
  }
}

/* ---------- workout-log write tools ---------- */

function requireWorkout(S, workout_id) {
  const w = (S.workouts || []).find(x => x.id === workout_id)
  if (!w) { const e = new Error(`no workout with id ${JSON.stringify(workout_id)}`); e.code = 'ENOENT'; throw e }
  return w
}

// Locate the entry for exercise_id inside a workout. Most sessions log one entry per
// exercise; when the same exercise appears twice, entry_index (0-based position among the
// matching entries) picks one. Without it, an ambiguous match is an error, not a guess.
function requireEntry(w, exercise_id, entry_index) {
  const matches = []
  ;(w.entries || []).forEach((e, i) => { if (e.id === exercise_id) matches.push({ e, i }) })
  if (!matches.length) {
    const e = new Error(`workout ${JSON.stringify(w.id)} has no entry for exercise ${JSON.stringify(exOr(exercise_id).n)} (${exercise_id})`)
    e.code = 'ENOENT'
    throw e
  }
  if (entry_index != null) {
    const m = matches[entry_index]
    if (!m) { const err = new Error(`entry_index ${entry_index} out of range — ${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} match exercise ${exercise_id}`); err.code = 'EINVAL'; throw err }
    return m
  }
  if (matches.length > 1) {
    const e = new Error(`exercise ${exercise_id} appears ${matches.length} times in this workout — pass entry_index (0-based, among the matching entries) to choose one`)
    e.code = 'EINVAL'
    throw e
  }
  return matches[0]
}

/** relabel_workout_exercise — point a mislabelled entry at the exercise actually performed. */
export const relabelWorkoutExercise = {
  name: 'relabel_workout_exercise',
  description: 'Fix a mislabelled exercise in a finished workout: point one entry at another catalog exercise (e.g. "I did deadlifts but logged bent-over rows"). Moves the entry id, its saved target snapshot and the workout\'s PR list to the new exercise; weights, reps and set history stay as logged. PR flags are moved, not recomputed. If the same exercise appears more than once in the workout, pass entry_index.',
  schema: {
    workout_id: z.string().min(1).describe('The workout id from list_workouts.'),
    exercise_id: z.string().min(1).describe('The exercise id that was logged wrongly.'),
    new_exercise_id: z.string().min(1).describe('The catalog exercise id that was actually performed.'),
    entry_index: z.number().int().min(0).optional().describe('If the wrong exercise appears multiple times in the workout: 0-based index among the matching entries.')
  },
  handler: ({ workout_id, exercise_id, new_exercise_id, entry_index }) => {
    const S = getState()
    if (!S) return noState()
    requireWorkout(S, workout_id)
    if (exercise_id === new_exercise_id) {
      const e = new Error('exercise_id and new_exercise_id are identical — nothing to relabel')
      e.code = 'EINVAL'
      throw e
    }
    withCustomExercises(S)
    assertKnownExercise(new_exercise_id)
    return writeState(st => {
      const w = requireWorkout(st, workout_id)
      const { e } = requireEntry(w, exercise_id, entry_index)
      e.id = new_exercise_id
      // The target snapshot rides along so the workout view shows the new exercise's name;
      // its sets/reps/weight stay as they were planned that day. Old seeds may have no target.
      if (e.target && typeof e.target === 'object') e.target.id = new_exercise_id
      if (Array.isArray(w.prs)) w.prs = [...new Set(w.prs.map(p => (p === exercise_id ? new_exercise_id : p)))]
      return st
    }).then(() => ({
      workout_id,
      relabeled: exercise_id,
      with: new_exercise_id,
      name: EXIDX[new_exercise_id]?.n || new_exercise_id
    }))
  }
}

/** update_workout_set — correct one logged set (weight/reps/duration/done). */
export const updateWorkoutSet = {
  name: 'update_workout_set',
  description: 'Correct one logged set inside a finished workout — fix a mis-entered weight or rep count ("logged 16 kg, lifted 6 kg"), a duration, cardio speed, or the done flag. Recomputes the entry\'s top weight and the workout volume. The per-workout PR badge list is left untouched; the PR table derives from the raw sets and stays correct on its own.',
  schema: {
    workout_id: z.string().min(1).describe('The workout id from list_workouts.'),
    exercise_id: z.string().min(1).describe('The exercise id whose set is being corrected.'),
    set_index: z.number().int().min(0).describe('0-based index of the set within the entry (the order get_workout lists them).'),
    entry_index: z.number().int().min(0).optional().describe('If the exercise appears multiple times in the workout: 0-based index among the matching entries.'),
    w: z.number().min(0).optional().describe('New weight (0 = bodyweight/no load).'),
    r: z.number().int().min(0).optional().describe('New rep count.'),
    sec: z.number().min(0).optional().describe('New duration in seconds (timed exercises).'),
    min: z.number().min(0).optional().describe('New duration in minutes (cardio).'),
    speed: z.number().min(0).optional().describe('New speed (cardio).'),
    done: z.boolean().optional().describe('Mark the set done or undone. Undone sets drop out of volume and strength estimates.')
  },
  handler: ({ workout_id, exercise_id, set_index, entry_index, w, r, sec, min, speed, done }) => {
    const S = getState()
    if (!S) return noState()
    const fields = { w, r, sec, min, speed, done }
    const mutable = Object.keys(fields).filter(k => fields[k] !== undefined)
    if (!mutable.length) {
      const e = new Error('nothing to change — pass at least one of w, r, sec, min, speed, done')
      e.code = 'EINVAL'
      throw e
    }
    requireWorkout(S, workout_id)
    return writeState(st => {
      const wr = requireWorkout(st, workout_id)
      const { e: entry } = requireEntry(wr, exercise_id, entry_index)
      const sets = entry.sets || []
      const s = sets[set_index]
      if (!s) {
        const e = new Error(`set_index ${set_index} out of range — this entry has ${sets.length} set${sets.length === 1 ? '' : 's'}`)
        e.code = 'EINVAL'
        throw e
      }
      for (const k of mutable) s[k] = fields[k]
      // topW mirrors the app: the weight of the last logged (done) set, null when none.
      const lastDone = [...sets].reverse().find(x => x.done)
      entry.topW = lastDone ? (lastDone.w || null) : null
      wr.vol = workoutVolume(wr)
      return st
    }).then(() => {
      const w2 = requireWorkout(getState(), workout_id)
      const { e: entry2 } = requireEntry(w2, exercise_id, entry_index)
      const s2 = entry2.sets[set_index]
      return {
        workout_id,
        exercise_id,
        set_index,
        set: {
          w: Number(s2.w) || 0,
          r: Number(s2.r) || 0,
          sec: Number(s2.sec) || 0,
          min: Number(s2.min) || 0,
          speed: Number(s2.speed) || 0,
          done: !!s2.done
        },
        entry_top_w: entry2.topW ?? null,
        workout_volume: w2.vol ?? workoutVolume(w2)
      }
    })
  }
}

/** delete_workout — remove a finished session entirely. */
export const deleteWorkout = {
  name: 'delete_workout',
  description: 'Delete a finished workout entirely (e.g. a session accidentally logged twice). Irreversible from the MCP side — the pre-write backup in the MCP metadata file is the only recovery path. Identify the session by workout_id from list_workouts; there is deliberately no date-only variant, because two sessions can share one date.',
  schema: {
    workout_id: z.string().min(1).describe('The workout id from list_workouts.')
  },
  handler: ({ workout_id }) => {
    const S = getState()
    if (!S) return noState()
    const w = requireWorkout(S, workout_id)
    const summary = { date: w.d, name: w.name || null, volume: workoutVolume(w) }
    return writeState(st => {
      st.workouts = (st.workouts || []).filter(x => x.id !== workout_id)
      return st
    }).then(() => ({ deleted: workout_id, ...summary }))
  }
}

/* ---------- equipment-profile tools ---------- */

// The equipment values the catalog actually contains — the same list the app's profile
// editor offers (ALL_EQUIPMENT in lib/equipment.js). Validating against it keeps a typo
// like "leverage machnie" from silently matching zero exercises.
function catalogEquipment() {
  const counts = {}
  for (const ex of EXDB) if (ex.eq) counts[ex.eq] = (counts[ex.eq] || 0) + 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => ({ equipment: k, exercise_count: n }))
}

function normalizeEquipmentList(list) {
  const valid = new Set(EXDB.map(e => e.eq).filter(Boolean))
  const out = []
  for (const raw of list || []) {
    const k = String(raw).trim()
    if (!k) continue
    if (!valid.has(k)) {
      const e = new Error(`unknown equipment type ${JSON.stringify(raw)} — must be one of the catalog values (see get_equipment)`)
      e.code = 'EINVAL'
      throw e
    }
    if (!out.includes(k)) out.push(k)
  }
  return out
}

/** get_equipment — current profiles + the catalog's equipment checklist. */
export const getEquipment = {
  name: 'get_equipment',
  description: 'Show the user\'s equipment profiles (named "Home"/"Gym"/… lists of equipment types), which one is active, and whether filtering is on. Also returns the full checklist of equipment types the exercise catalog contains, with exercise counts — use it to pick valid type names for update_equipment_profiles. Body-weight exercises are always available in every profile and never listed here.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return noState()
    return {
      filter_on: !!S.equipFilterOn,
      active_profile_id: S.activeEquipId || null,
      profiles: (S.equipProfiles || []).map(p => ({
        id: p.id,
        name: p.name,
        equipment: p.equipment || [],
        equipment_count: (p.equipment || []).length
      })),
      catalog_equipment: catalogEquipment()
    }
  }
}

const profileSchema = z.object({
  name: z.string().min(1).max(40).describe('Profile name, e.g. "Home Gym".'),
  equipment: z.array(z.string()).min(1).describe('Equipment type names exactly as the catalog spells them (see get_equipment → catalog_equipment), e.g. ["dumbbell", "barbell", "leverage machine"].'),
  id: z.string().optional().describe('Keep an existing profile\'s id to update it in place; omit for a new profile (one is generated).')
})

/** update_equipment_profiles — replace the whole profile list + filter settings. */
export const updateEquipmentProfiles = {
  name: 'update_equipment_profiles',
  description: 'Replace the user\'s equipment profiles wholesale — the same replace semantics as update_routine: profiles not listed are removed, so pass the complete desired list. Also sets which profile is active and whether the filter is on. The active filter hides library/picker exercises that need equipment missing from the active profile (body-weight exercises are never hidden). Use get_equipment first for valid equipment type names.',
  schema: {
    profiles: z.array(profileSchema).describe('The complete desired profile list.'),
    active_profile_id: z.string().nullable().optional().describe('Which profile is active. Must be one of the listed ids (or null = no active profile).'),
    filter_on: z.boolean().optional().describe('Turn the equipment filter on/off. Filtering without an active profile changes nothing — both switches matter.')
  },
  handler: ({ profiles, active_profile_id, filter_on }) => {
    const S = getState()
    if (!S) return noState()
    if (!profiles || !profiles.length) {
      const e = new Error('profiles must contain at least one profile — pass an empty equipment list per profile instead of deleting everything (or delete profiles in the app)')
      e.code = 'EINVAL'
      throw e
    }
    // Validate everything up front so a bad type never half-applies.
    const cleaned = profiles.map(p => ({ ...p, equipment: normalizeEquipmentList(p.equipment) }))
    const ids = cleaned.map(p => typeof p.id === 'string' && p.id ? p.id : null)
    if (active_profile_id && !ids.includes(active_profile_id)) {
      const e = new Error(`active_profile_id ${JSON.stringify(active_profile_id)} is not one of the listed profile ids`)
      e.code = 'EINVAL'
      throw e
    }
    const names = cleaned.map(p => p.name)
    if (new Set(names).size !== names.length) {
      const e = new Error('profile names must be unique')
      e.code = 'EINVAL'
      throw e
    }
    return writeState(st => {
      const next = cleaned.map((p, i) => ({
        id: ids[i] || 'eq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: p.name,
        equipment: p.equipment
      }))
      st.equipProfiles = next
      if (active_profile_id !== undefined) st.activeEquipId = active_profile_id
      if (filter_on !== undefined) st.equipFilterOn = filter_on
      // A deleted profile must not stay active — the app resolves activeEquipId against this
      // list and a dangling id means the filter silently stops matching anything.
      if (st.activeEquipId && !next.some(p => p.id === st.activeEquipId)) st.activeEquipId = null
      return st
    }).then(() => ({
      filter_on: filter_on ?? !!getState().equipFilterOn,
      active_profile_id: active_profile_id !== undefined ? active_profile_id : (getState().activeEquipId || null),
      profiles: getState().equipProfiles.map(p => ({ id: p.id, name: p.name, equipment: p.equipment, equipment_count: p.equipment.length }))
    }))
  }
}


/* ---------- registration list ---------- */

export const TOOLS = [
  listRoutines, getRoutine, previewSession, getWeekPlan, listWorkouts, getWorkout, getBodyweight, estimate1rm, muscleBalance,
  createRoutine, updateRoutine, deleteRoutine, progressExercise, swapExercise, scheduleDeload, cancelDeload,
  relabelWorkoutExercise, updateWorkoutSet, deleteWorkout, getEquipment, updateEquipmentProfiles
]

function noState() {
  return {
    error: 'no synced state yet — sign in at least once from a device so the openGym api can save a state file for this profile',
    unit: 'kg'
  }
}
