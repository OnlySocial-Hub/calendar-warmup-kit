// sessions.js — the session catalogue + the day planner.
// ---------------------------------------------------------------------------
// A "session" is one natural visit to the app. The calendar is really two things
// laid over a day: the POSTS an account publishes (calendar.js) and the SESSIONS
// of human-like activity around them (here). A warm account on a normal day might
// do: a morning scroll, watch some stories over lunch, a little engagement in the
// evening, with its one scheduled post dropped somewhere in the middle — each
// separated by a 30–90 min rest.
//
// Each session type is just a recipe of what to do and how long; the actual
// driving (tapping the phone) is YOUR code — the planner only decides WHICH
// sessions happen, WHEN, and HOW MANY. That keeps this file phone-agnostic.

import { SESSION, sessionsPerDay, restGapMs, shouldSetLinkInBio } from './limits.js';
import { warmupPhase } from './warmup.js';

// The catalogue. `weightByPhase` biases what gets picked while warming (week one
// is almost all passive watching; engagement and follows only creep in later).
// `durationMin` is the random window a session runs for.
export const SESSION_TYPES = {
  scroll_reels:   { id: 'scroll_reels',   label: 'Scroll Reels',        kind: 'browse',  durationMin: [3, 8],  weightByPhase: { 1: 5, 2: 5, 3: 4, 4: 4 } },
  scroll_home:    { id: 'scroll_home',    label: 'Scroll the home feed', kind: 'browse',  durationMin: [2, 5],  weightByPhase: { 1: 3, 2: 3, 3: 3, 4: 3 } },
  watch_stories:  { id: 'watch_stories',  label: 'Watch Stories (AFK)',  kind: 'afk',     durationMin: [2, 6],  weightByPhase: { 1: 3, 2: 3, 3: 2, 4: 2 } },
  search_explore: { id: 'search_explore', label: 'Search & explore',     kind: 'browse',  durationMin: [2, 5],  weightByPhase: { 1: 2, 2: 2, 3: 2, 4: 2 } },
  engagement:     { id: 'engagement',     label: 'Engage (like/comment)', kind: 'engage', durationMin: [3, 7],  weightByPhase: { 1: 0, 2: 1, 3: 2, 4: 3 } },
  follow_list:    { id: 'follow_list',    label: 'Follow a few accounts', kind: 'grow',   durationMin: [2, 4],  weightByPhase: { 1: 0, 2: 0, 3: 1, 4: 1 } },
};

// The "AFK" session is just watch_stories/scroll with no engagement — the account
// is "on their phone" doing nothing interesting. It matters: a day that's ALL
// action and no idle watching reads as a bot. The planner always keeps some.
export const AFK_SESSION = 'watch_stories';

// A one-off session that adds the link to the bio. It is NEVER in the normal
// rotation — it's injected once, and only when limits.shouldSetLinkInBio() says
// the account has earned it (warm + enough posts live + real reach).
export const LINK_IN_BIO = { id: 'set_link_in_bio', label: 'Set link in bio', kind: 'profile', durationMin: [1, 2] };

// Weighted pick from the catalogue for a given warm-up phase (1–4).
function pickType(phase, rand) {
  const entries = Object.values(SESSION_TYPES)
    .map((t) => [t, t.weightByPhase[phase] || 0])
    .filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (!total) return SESSION_TYPES[AFK_SESSION];
  let r = rand() * total;
  for (const [t, w] of entries) { if ((r -= w) <= 0) return t; }
  return entries[0][0];
}

function rnd(a, b, rand) { return a + rand() * (b - a); }

// Build ONE day's session plan for an account. Returns an ordered list of
// sessions, each with a start time and a duration, spaced by human rests across
// the awake window. Posts are scheduled separately (calendar.js); the engine
// slots any due post into one of these gaps. `phase` comes from warmup.warmupPhase,
// `views` is the reach signal. Pure: pass `rand`/`now` for deterministic tests.
export function planDay(account, { now = Date.now(), views = 0, rand = Math.random } = {}) {
  const phase = warmupPhase(account, now);
  const count = sessionsPerDay(phase, views, rand);
  if (count <= 0) return [];

  // Start somewhere in the first couple of hours of the awake window, then walk
  // forward one rest-gap at a time. If we spill past the end of the day, stop —
  // a real person doesn't cram; the leftover simply doesn't happen today.
  const day = new Date(now);
  let t = new Date(day); t.setHours(SESSION.dayStartHour, Math.floor(rnd(0, 120, rand)), 0, 0);
  if (t.getTime() < now) t = new Date(now + Math.round(rnd(2, 20, rand)) * 60000);
  const endOfDay = new Date(day); endOfDay.setHours(SESSION.dayEndHour, 0, 0, 0);

  const out = [];
  // Guarantee at least one purely-passive AFK session a day (see AFK_SESSION).
  let needAfk = true;
  for (let i = 0; i < count; i++) {
    if (t.getTime() > endOfDay.getTime()) break;
    const type = (i === count - 1 && needAfk) ? SESSION_TYPES[AFK_SESSION] : pickType(phase, rand);
    if (type.id === AFK_SESSION) needAfk = false;
    const [lo, hi] = type.durationMin;
    const durationMin = Math.round(rnd(lo, hi, rand));
    out.push({ type: type.id, label: type.label, kind: type.kind, at: t.toISOString(), durationMin });
    // advance by this session's length + a human rest
    t = new Date(t.getTime() + durationMin * 60000 + restGapMs(rand));
  }

  // Graduation extra: if the account has just earned its bio link, inject the
  // one-off link session near the start of the day (before it posts).
  if (shouldSetLinkInBio(account, now) && out.length) {
    out.unshift({ type: LINK_IN_BIO.id, label: LINK_IN_BIO.label, kind: LINK_IN_BIO.kind, at: out[0].at, durationMin: 1, once: true });
  }
  return out;
}
