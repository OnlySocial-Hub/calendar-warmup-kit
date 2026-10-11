// calendar.js — the posting calendar / scheduler.
// ---------------------------------------------------------------------------
// This decides WHEN each post goes out. The rules that make it look human:
//
//   • at most N posts per account per day (default 3 — the per-account cap),
//   • spread across the awake window (9am–11pm) at randomised, non-bunched times,
//   • never two posts for one account within 10 minutes,
//   • and — the important one — NOTHING is scheduled before the account has
//     finished its ~2-week warm-up. The calendar physically can't place a post
//     in the warm-up period; the earliest slot it will consider is the day the
//     warm-up clock is up.
//
// A `post` is a plain object: { id, account, when, status, createdAt, retries }.
//   status: 'draft' (no time yet) | 'scheduled' | 'posting' | 'posted' | 'failed'
// The functions take the account's list of posts and return/patch times. They're
// pure w.r.t. storage — the engine owns the array and persists it.

import { CAPS, SESSION } from './limits.js';
import { warmupStatus } from './warmup.js';

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const whenMs = (p) => (p.when ? new Date(p.when).getTime() : Infinity);
const isPending = (p) => p.status === 'scheduled' || p.status === 'draft' || !p.status;

// `perDay` randomised times across [startHour,endHour), one per even segment so
// they never bunch up. Returns Date objects on the given day, sorted.
export function spreadTimes(day, perDay, startHour = SESSION.dayStartHour, endHour = SESSION.dayEndHour, rand = Math.random) {
  const span = (endHour - startHour) / Math.max(1, perDay);
  const out = [];
  for (let i = 0; i < perDay; i++) {
    const hourF = startHour + i * span + rand() * span;
    const h = Math.floor(hourF);
    const m = Math.floor((hourF - h) * 60);
    const d = new Date(day); d.setHours(h, m, 0, 0);
    out.push(d);
  }
  return out.sort((a, b) => a - b);
}

// The earliest day the calendar may place a post for an account: today, or the
// warm-up ready date if that's still in the future. THIS is the warm-up gate.
function earliestDay(account, now) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const ready = account && account.warmReadyAt ? new Date(account.warmReadyAt) : null;
  if (ready && ready.getTime() > start.getTime()) { ready.setHours(0, 0, 0, 0); return ready; }
  return start;
}

// Schedule ONE post into the next FREE slot for its account, WITHOUT moving
// anything already scheduled — the gap-filler used as posts are added/imported or
// a failed one is retried. Respects the per-account daily cap, the warm-up gate,
// and the 10-minute spacing. Returns the ISO time set, or null if none fit the
// horizon. Mutates the post (sets when + status 'scheduled').
export function scheduleIntoNextSlot(posts, post, account, { perDay = CAPS.posts, now = Date.now(), rand = Math.random } = {}) {
  const cap = Math.max(1, perDay);
  const usedByDay = {};
  const taken = [];
  for (const o of posts) {
    if (o.id === post.id) continue;
    if (o.status !== 'scheduled' && o.status !== 'posting') continue;
    const t = whenMs(o);
    if (!Number.isFinite(t) || t <= now) continue;
    usedByDay[dayKey(new Date(t))] = (usedByDay[dayKey(new Date(t))] || 0) + 1;
    taken.push(t);
  }
  const day = earliestDay(account, now);
  for (let guard = 0; guard < 730; guard++) {
    const dk = dayKey(day);
    if ((usedByDay[dk] || 0) < cap) {
      for (const slot of spreadTimes(day, cap, SESSION.dayStartHour, SESSION.dayEndHour, rand)) {
        const t = slot.getTime();
        if (t <= now + 60000) continue;                                        // not in the past / imminent
        if (taken.some((x) => Math.abs(x - t) < SESSION.minGapBetweenPostsMin * 60000)) continue; // spacing
        post.when = slot.toISOString();
        post.status = 'scheduled';
        post.error = null;
        return post.when;
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

// Re-plan ALL of an account's pending posts (drafts + already-scheduled) from the
// earliest allowed day forward, at the cap. Use this for "Auto-schedule" / after
// the per-day cap changes. Newest upload first (what you added last goes next).
// Leaves posted/posting/failed posts untouched. Returns the list of {id, when}.
export function autoSchedule(posts, account, { perDay = CAPS.posts, now = Date.now(), rand = Math.random } = {}) {
  const cap = Math.max(1, perDay);
  const pending = posts.filter(isPending)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)));
  if (!pending.length) return [];

  // Days already committed by posts we are NOT re-planning (a live 'posting' one).
  const usedByDay = {};
  for (const o of posts) {
    if (isPending(o) || (o.status !== 'scheduled' && o.status !== 'posting')) continue;
    const t = whenMs(o);
    if (!Number.isFinite(t) || t <= now) continue;
    usedByDay[dayKey(new Date(t))] = (usedByDay[dayKey(new Date(t))] || 0) + 1;
  }

  const assigned = [];
  const day = earliestDay(account, now);
  let idx = 0;
  for (let guard = 0; guard < 730 && idx < pending.length; guard++) {
    const dk = dayKey(day);
    const used = usedByDay[dk] || 0;
    if (used < cap) {
      const slots = spreadTimes(day, cap, SESSION.dayStartHour, SESSION.dayEndHour, rand);
      for (let s = used; s < cap && idx < pending.length; s++) {
        const when = slots[s];
        if (when.getTime() <= now + 60000) continue;
        pending[idx].when = when.toISOString();
        pending[idx].status = 'scheduled';
        pending[idx].error = null;
        usedByDay[dk] = (usedByDay[dk] || 0) + 1;
        assigned.push({ id: pending[idx].id, when: pending[idx].when });
        idx++;
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return assigned;
}

// Which posts are due to go out right now (scheduled + their time has arrived).
export function dueItems(posts, now = Date.now()) {
  return posts.filter((p) => p.status === 'scheduled' && p.when && new Date(p.when).getTime() <= now);
}

// A read-only view for a Status / calendar UI: the account's warm-up state plus
// its scheduled posts grouped by day. No scheduling happens here.
export function calendarView(posts, account, { now = Date.now() } = {}) {
  const warm = warmupStatus(account, now);
  const byDay = {};
  for (const p of posts) {
    if (p.status !== 'scheduled' || !p.when) continue;
    const k = dayKey(new Date(p.when));
    (byDay[k] ||= []).push({ id: p.id, when: p.when });
  }
  for (const k in byDay) byDay[k].sort((a, b) => new Date(a.when) - new Date(b.when));
  return { warmup: warm, canPostFrom: earliestDay(account, now).toISOString(), days: byDay };
}
