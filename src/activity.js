// activity.js — what actually happens INSIDE a session.
// ---------------------------------------------------------------------------
// sessions.js decides WHICH session runs, WHEN, and for HOW LONG. This file is
// the other half: given one session, it builds the concrete, timed recipe of
// micro-actions the phone performs — watch this reel for 14s, pause 1.2s, like
// (only sometimes), open a profile, maybe follow, keep scrolling… — and enforces
// the daily caps while it does it.
//
// Two things live here:
//   1. buildSessionScript() — PURE. Turns a session into an ordered action list
//      (the "what do they really do"). No phone, no clock: pass rand/now.
//   2. runSessionScript()   — walks that list and calls a tiny `actions` adapter
//      (openApp / watch / like / follow / …). THAT adapter is the only
//      phone-touching code, and it's yours to implement (WDA taps, etc.). A
//      `mockActions` is included so the whole thing runs with no phone.
//
// The split is the whole point: the human-like behaviour (counts, dwell times,
// probabilities, pacing, budget) is generic and lives here; the 9 primitive taps
// that press the glass are specific to your rig and live behind the adapter.

import { CAPS } from './limits.js';

// --- the behaviour model ----------------------------------------------------
// For each session type: what it consumes and how it behaves. Probabilities are
// keyed by warm-up phase (1–4) so week one is almost all passive watching and
// engagement/follows only creep in later — the same ramp the planner uses.
//
//   dwellSec   how long ONE item (reel/post/story) is looked at, [min,max]
//   pauseSec   the human pause between taps/swipes, [min,max]
//   rewatchP   chance of lingering on / rewatching an item
//   p.<action> chance PER ITEM of that action, by phase. `follow` only triggers
//              after a profile is opened (you follow from a profile, not a feed).
export const SESSION_BEHAVIOUR = {
  scroll_reels: {
    surface: 'reels', item: 'reel',
    dwellSec: [5, 34], pauseSec: [0.3, 2.2], rewatchP: 0.07,
    p: {
      like:        { 1: 0.00, 2: 0.06, 3: 0.10, 4: 0.14 },
      save:        { 1: 0.01, 2: 0.02, 3: 0.03, 4: 0.04 },
      comment:     { 1: 0.00, 2: 0.00, 3: 0.015, 4: 0.03 },
      openProfile: { 1: 0.02, 2: 0.04, 3: 0.05, 4: 0.06 },
      follow:      { 1: 0.00, 2: 0.00, 3: 0.25, 4: 0.30 }, // chance once a profile is open
    },
  },
  scroll_home: {
    surface: 'home', item: 'post',
    dwellSec: [3, 14], pauseSec: [0.4, 2.0], rewatchP: 0.02,
    p: {
      like:        { 1: 0.00, 2: 0.05, 3: 0.08, 4: 0.11 },
      save:        { 1: 0.00, 2: 0.01, 3: 0.02, 4: 0.03 },
      comment:     { 1: 0.00, 2: 0.00, 3: 0.01, 4: 0.02 },
      openProfile: { 1: 0.02, 2: 0.03, 3: 0.04, 4: 0.05 },
      follow:      { 1: 0.00, 2: 0.00, 3: 0.20, 4: 0.25 },
    },
  },
  watch_stories: {
    surface: 'stories', item: 'story', afk: true,
    dwellSec: [2, 9], pauseSec: [0.2, 1.1], rewatchP: 0.00,
    p: { // "AFK" — almost nothing but watching; a stray tap at most
      like:        { 1: 0.00, 2: 0.01, 3: 0.02, 4: 0.02 },
      save:        { 1: 0, 2: 0, 3: 0, 4: 0 },
      comment:     { 1: 0, 2: 0, 3: 0, 4: 0 },
      openProfile: { 1: 0.00, 2: 0.01, 3: 0.01, 4: 0.02 },
      follow:      { 1: 0, 2: 0, 3: 0.05, 4: 0.08 },
    },
  },
  search_explore: {
    surface: 'search', item: 'post', preamble: 'search',
    dwellSec: [3, 16], pauseSec: [0.4, 2.4], rewatchP: 0.03,
    p: {
      like:        { 1: 0.00, 2: 0.04, 3: 0.07, 4: 0.10 },
      save:        { 1: 0.01, 2: 0.02, 3: 0.03, 4: 0.04 },
      comment:     { 1: 0.00, 2: 0.00, 3: 0.01, 4: 0.02 },
      openProfile: { 1: 0.03, 2: 0.05, 3: 0.07, 4: 0.08 },
      follow:      { 1: 0.00, 2: 0.00, 3: 0.22, 4: 0.28 },
    },
  },
  engagement: {
    surface: 'reels', item: 'reel',
    dwellSec: [4, 20], pauseSec: [0.5, 2.6], rewatchP: 0.05,
    p: { // the "spicy" session — this is where most of the day's likes/comments happen
      like:        { 1: 0.00, 2: 0.18, 3: 0.28, 4: 0.36 },
      save:        { 1: 0.00, 2: 0.03, 3: 0.05, 4: 0.06 },
      comment:     { 1: 0.00, 2: 0.03, 3: 0.06, 4: 0.09 },
      openProfile: { 1: 0.00, 2: 0.06, 3: 0.09, 4: 0.11 },
      follow:      { 1: 0.00, 2: 0.10, 3: 0.30, 4: 0.35 },
    },
  },
  follow_list: {
    surface: 'profiles', item: 'profile', profileLoop: true,
    dwellSec: [4, 12], pauseSec: [0.6, 2.8], rewatchP: 0,
    p: { // walk profiles and follow a few; the follow prob here IS the per-item prob
      like:        { 1: 0.00, 2: 0.00, 3: 0.08, 4: 0.10 },
      save:        { 1: 0, 2: 0, 3: 0, 4: 0 },
      comment:     { 1: 0, 2: 0, 3: 0, 4: 0 },
      openProfile: { 1: 0, 2: 0, 3: 1, 4: 1 },           // every item IS a profile
      follow:      { 1: 0.00, 2: 0.00, 3: 0.45, 4: 0.55 },
    },
  },
};

// A tiny, generic sample comment pool so the demo can run end-to-end. Replace
// with your own list — or, in our bot, a vision model writes a comment from a
// screenshot of the post. Kept deliberately bland here; this kit is the brain,
// not the copywriting.
export const SAMPLE_COMMENTS = ['🔥🔥', 'love this', 'so good', 'need this', 'clean', '👏', 'this is great', 'saved!'];

// How much of the day's remaining engagement budget a SINGLE session may spend,
// so one session never blows the whole daily cap in one go. Clamped to what's
// actually left for the day (see sessionBudget / the engine's usage counters).
export const PER_SESSION_CEIL = { likes: 25, follows: 6, comments: 3 };

// Work out the budget for ONE session from what the account has left today.
// `usedToday` is { likes, follows, comments } already spent; CAPS are the daily
// ceilings (limits.js). Returns how many of each this session is allowed.
export function sessionBudget(usedToday = {}, caps = CAPS) {
  const left = (k) => Math.max(0, (caps[k] || 0) - (usedToday[k] || 0));
  return {
    likes:    Math.min(PER_SESSION_CEIL.likes, left('likes')),
    follows:  Math.min(PER_SESSION_CEIL.follows, left('follows')),
    comments: Math.min(PER_SESSION_CEIL.comments, left('comments')),
  };
}

const rnd = (a, b, rand) => a + rand() * (b - a);
const hit = (p, rand) => p > 0 && rand() < p;
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

// --- build the recipe -------------------------------------------------------
// Turn one session into an ordered list of timed actions. PURE: pass rand.
//
//   account   (unused today, but kept so per-account tempo can key off it)
//   session   { type, durationMin, ... } from sessions.planDay
//   opts      { phase (1–4), budget {likes,follows,comments}, rand }
//
// Returns { type, surface, actions: [...], planned: {...} }. Each action is
// one of:
//   { do:'open_app', surface, pauseMs }
//   { do:'search', term, pauseMs }                 (search_explore only)
//   { do:'watch', target, ms, pauseMs }            dwell on one item
//   { do:'like' | 'save' | 'comment' | 'open_profile' | 'follow' | 'back', ... }
//   { do:'idle', ms, pauseMs }                     pure AFK watching
//   { do:'set_link', pauseMs }                     the one-off bio link
//   { do:'close_app', pauseMs }
// `pauseMs` is the human pause BEFORE that action. `ms` is how long the action
// itself takes (dwell / idle). planned tallies what the recipe intends to do, so
// the engine can bill it against the daily caps.
export function buildSessionScript(account, session, { phase = 1, budget = sessionBudget(), rand = Math.random } = {}) {
  const b = SESSION_BEHAVIOUR[session.type];
  const planned = { watch: 0, like: 0, save: 0, comment: 0, follow: 0, openProfile: 0, idleSec: 0 };
  const actions = [];
  const pause = () => Math.round(rnd((b?.pauseSec?.[0] ?? 0.4), (b?.pauseSec?.[1] ?? 2), rand) * 1000);

  // The one-off profile action — not a feed session at all.
  if (session.type === 'set_link_in_bio' || !b) {
    actions.push({ do: 'open_app', surface: 'profile', pauseMs: Math.round(rnd(0.8, 2.5, rand) * 1000) });
    if (session.type === 'set_link_in_bio') actions.push({ do: 'set_link', pauseMs: Math.round(rnd(1, 3, rand) * 1000) });
    actions.push({ do: 'close_app', pauseMs: pause() });
    return { type: session.type, surface: 'profile', actions, planned };
  }

  const targetMs = Math.max(30000, (session.durationMin || 3) * 60000);
  const left = { ...budget };

  actions.push({ do: 'open_app', surface: b.surface, pauseMs: Math.round(rnd(0.8, 3, rand) * 1000) });
  if (b.preamble === 'search') {
    actions.push({ do: 'search', term: '(your niche term)', pauseMs: Math.round(rnd(1, 3, rand) * 1000) });
    actions.push({ do: 'open_result', pauseMs: Math.round(rnd(0.6, 2, rand) * 1000) });
  }

  // Walk items until the duration is used up (with a hard safety cap on count).
  let elapsed = actions.reduce((s, a) => s + (a.pauseMs || 0) + (a.ms || 0), 0);
  const maxItems = 400;
  for (let i = 0; i < maxItems && elapsed < targetMs; i++) {
    const dwellMs = Math.round(rnd(b.dwellSec[0], b.dwellSec[1], rand) * 1000) * (hit(b.rewatchP, rand) ? 2 : 1);

    if (b.afk) {
      // AFK: just watch, almost never touch. Model it as an idle watch of one item.
      actions.push({ do: 'idle', target: b.item, ms: dwellMs, pauseMs: pause() });
      planned.idleSec += Math.round(dwellMs / 1000);
    } else {
      actions.push({ do: 'watch', target: b.item, ms: dwellMs, pauseMs: pause() });
      planned.watch++;
    }

    // engagement rolls, each gated by phase probability AND remaining budget
    if (!b.afk && hit(b.p.like[phase], rand) && left.likes > 0) {
      actions.push({ do: 'like', pauseMs: Math.round(rnd(0.2, 1.2, rand) * 1000) }); left.likes--; planned.like++;
    }
    if (hit(b.p.save[phase], rand)) { actions.push({ do: 'save', pauseMs: Math.round(rnd(0.2, 1, rand) * 1000) }); planned.save++; }
    if (hit(b.p.comment[phase], rand) && left.comments > 0) {
      actions.push({ do: 'comment', text: pick(SAMPLE_COMMENTS, rand), pauseMs: Math.round(rnd(2, 6, rand) * 1000) });
      left.comments--; planned.comment++;
    }

    // open a profile, and from there maybe follow — follows only happen on a profile
    const onProfile = b.profileLoop || hit(b.p.openProfile[phase], rand);
    if (onProfile) {
      if (!b.profileLoop) { actions.push({ do: 'open_profile', pauseMs: Math.round(rnd(0.6, 2, rand) * 1000) }); planned.openProfile++; }
      else planned.openProfile++;
      if (hit(b.p.follow[phase], rand) && left.follows > 0) {
        actions.push({ do: 'follow', pauseMs: Math.round(rnd(0.8, 2.5, rand) * 1000) }); left.follows--; planned.follow++;
      }
      if (!b.profileLoop) actions.push({ do: 'back', pauseMs: Math.round(rnd(0.4, 1.5, rand) * 1000) });
    }

    elapsed = actions.reduce((s, a) => s + (a.pauseMs || 0) + (a.ms || 0), 0);
  }

  actions.push({ do: 'close_app', pauseMs: pause() });
  return { type: session.type, surface: b.surface, actions, planned };
}

// A one-line human summary of what a recipe intends to do.
export function summariseScript(script) {
  const p = script.planned || {};
  const bits = [];
  if (p.watch) bits.push(`${p.watch} watched`);
  if (p.idleSec) bits.push(`${p.idleSec}s AFK`);
  if (p.like) bits.push(`${p.like} liked`);
  if (p.comment) bits.push(`${p.comment} commented`);
  if (p.save) bits.push(`${p.save} saved`);
  if (p.follow) bits.push(`${p.follow} followed`);
  return bits.join(', ') || 'nothing';
}

// A readable, timed printout of the whole recipe — for seeing exactly what a
// session does. `node demo-session.js` uses this.
export function describeScript(script) {
  const lines = [`session: ${script.type}  (surface: ${script.surface})`];
  let t = 0;
  for (const a of script.actions) {
    t += (a.pauseMs || 0);
    const at = `${String(Math.floor(t / 60000)).padStart(2, '0')}:${String(Math.floor((t / 1000) % 60)).padStart(2, '0')}`;
    let desc = a.do;
    if (a.do === 'watch' || a.do === 'idle') desc = `${a.do} ${a.target} for ${(a.ms / 1000).toFixed(1)}s`;
    if (a.do === 'comment') desc = `comment "${a.text}"`;
    if (a.do === 'search') desc = `search "${a.term}"`;
    lines.push(`  ${at}  (+${((a.pauseMs || 0) / 1000).toFixed(1)}s) ${desc}`);
    t += (a.ms || 0);
  }
  lines.push(`  ——— total ~${(t / 60000).toFixed(1)} min · ${summariseScript(script)}`);
  return lines.join('\n');
}

// --- run the recipe against a device --------------------------------------
// Walk the script and call the adapter. The adapter is the ONLY phone-touching
// code — implement each method with your own taps (WDA, go-ios, whatever). Every
// method is optional and may be async; missing ones are skipped. `pause(ms)` is
// where the human rest between actions happens (your adapter can add its own
// jitter); `watch/idle(target, ms)` should block for ~ms.
//
// Returns a tally of what actually ran.
export async function runSessionScript(script, actions = mockActions, { onStep } = {}) {
  const tally = { watched: 0, idleSec: 0, liked: 0, saved: 0, commented: 0, followed: 0, openedProfile: 0 };
  for (const step of script.actions) {
    if (step.pauseMs && actions.pause) await actions.pause(step.pauseMs);
    switch (step.do) {
      case 'open_app':     await actions.openApp?.(step.surface); break;
      case 'search':       await actions.search?.(step.term); break;
      case 'open_result':  await actions.openResult?.(); break;
      case 'watch':        await actions.watch?.(step.target, step.ms); tally.watched++; break;
      case 'idle':         await actions.idle?.(step.ms); tally.idleSec += Math.round((step.ms || 0) / 1000); break;
      case 'like':         await actions.like?.(); tally.liked++; break;
      case 'save':         await actions.save?.(); tally.saved++; break;
      case 'comment':      await actions.comment?.(step.text); tally.commented++; break;
      case 'open_profile': await actions.openProfile?.(); tally.openedProfile++; break;
      case 'follow':       await actions.follow?.(); tally.followed++; break;
      case 'back':         await actions.back?.(); break;
      case 'set_link':     await actions.setLinkInBio?.(); break;
      case 'close_app':    await actions.closeApp?.(); break;
      default: break;
    }
    if (onStep) onStep(step);
  }
  return tally;
}

// A no-op adapter so the kit runs with no phone. Swap in your real one. `pause`
// resolves instantly here so the demo doesn't actually wait minutes; `watch`
// does nothing. Your real adapter makes pause/watch actually take the time.
export const mockActions = {
  async pause() {}, async openApp() {}, async search() {}, async openResult() {},
  async watch() {}, async idle() {}, async like() {}, async save() {}, async comment() {},
  async openProfile() {}, async follow() {}, async back() {}, async setLinkInBio() {}, async closeApp() {},
};
