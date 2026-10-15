// engine.js — the piece that ties it together (the "architecture").
// ---------------------------------------------------------------------------
// One small, single-process engine owns the whole calendar:
//
//   accounts  → each with its warm-up clock + a reach signal (avgViews, flagged)
//   posts     → each bound to an account, with a scheduled time + status
//   a tick    → called on an interval (every ~30s in production). Each tick it
//               (1) makes sure every account has today's SESSION plan, fires any
//                   session whose time has come (watch / scroll / engage / the
//                   one-off link-in-bio), and
//               (2) fires any POST that's due, one per account, warm accounts only.
//
// State is held in memory and mirrored to one crash-safe JSON file (store.js), so
// a restart continues exactly where it left off. It's deliberately host-agnostic:
// you inject `onSession(account, session)` and `onPost(account, post)` — the only
// two functions that touch a real phone. In this kit they default to console logs
// so the whole thing runs with no phones at all (see demo.js).
//
// In our own bot this same shape is what the Status page reads (per-phone warm-up
// clock, today's plan, what's scheduled) and what the Overseer watchdog watches
// over. None of that UI is included here — just the engine behind it.

import { startWarmup, warmupStatus, warmupPhase } from './warmup.js';
import { planDay } from './sessions.js';
import { scheduleIntoNextSlot, autoSchedule, calendarView } from './calendar.js';
import { tick as postingTick, postingNow } from './posting.js';
import { reachTier, postsPerDay, CAPS } from './limits.js';
import { buildSessionScript, runSessionScript, sessionBudget, summariseScript, mockActions } from './activity.js';
import { writeJsonAtomic, readJsonSafe } from './store.js';

const dayKey = (now) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
let _seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

export class CalendarEngine {
  // opts: { dataFile?, onSession?, onPost?, actions?, rand?, now? }
  //   actions:   your device adapter (activity.js) — the ~9 primitive taps. When
  //              given, the DEFAULT onSession runs each session's recipe against
  //              it. Omit it and sessions run against a no-op mock (so the kit
  //              works with no phone). Ignored if you pass your own onSession.
  constructor(opts = {}) {
    this.dataFile = opts.dataFile || null;
    this.actions = opts.actions || mockActions;
    // Default session handler: EXECUTE the session's action recipe (activity.js)
    // against the device adapter. session.script is built per-fire in tick().
    this.onSession = opts.onSession || (async (acct, s) => {
      const tally = await runSessionScript(s.script, this.actions);
      console.log(`[session] ${acct.label}: ${s.label} (${s.durationMin}m) — ${summariseScript(s.script)}`);
      return tally;
    });
    this.onPost = opts.onPost || ((acct, p) => { console.log(`[post] ${acct.label}: publishing ${p.id}`); return Promise.resolve(); });
    this.rand = opts.rand || Math.random;
    this.state = { accounts: {}, posts: {} };
    this._sessionBusy = new Set();
    if (this.dataFile) this.state = readJsonSafe(this.dataFile, this.state);
  }

  _save() { if (this.dataFile) { try { writeJsonAtomic(this.dataFile, this.state); } catch { /* soft */ } } }

  // --- accounts ------------------------------------------------------------
  // Add an account and START its two-week warm-up clock immediately. Until that
  // clock is up, the calendar will not place a single post for it.
  addAccount({ id, label } = {}, now = Date.now()) {
    const aid = id || nextId('acct');
    this.state.accounts[aid] = {
      id: aid, label: label || aid,
      ...startWarmup(now, this.rand),
      avgViews: 0, postsLive: 0, flagged: false, linkInBioSet: false,
      plan: null,
    };
    this._save();
    return this.state.accounts[aid];
  }

  account(id) { return this.state.accounts[id] || null; }
  accounts() { return Object.values(this.state.accounts); }
  postsFor(accountId) { return Object.values(this.state.posts).filter((p) => p.account === accountId); }

  // Feed back how an account is doing. `views` is a rolling reach number (e.g. the
  // average views of its last few posts); `flagged` cools it right down (recovery
  // tier: posts nothing, acts little) until you clear it. This is the loop that
  // makes "more views → more sessions/posts, a flag → fewer" happen.
  recordSignal(accountId, { views, flagged } = {}, now = Date.now()) {
    const a = this.account(accountId);
    if (!a) return;
    if (typeof views === 'number') a.avgViews = Math.max(0, views);
    if (typeof flagged === 'boolean') a.flagged = flagged;
    // Re-plan the calendar to the new allowance so the feedback loop is real:
    // more views → the queue re-spreads denser (up to the hard cap); a flag →
    // allowance 0, so scheduled posts are pulled back to drafts (it posts nothing
    // until you clear the flag, then it re-plans again).
    const cap = this._allowance(a, now);
    if (cap <= 0) {
      for (const p of this.postsFor(accountId)) if (p.status === 'scheduled') { p.status = 'draft'; p.when = ''; }
    } else {
      autoSchedule(this.postsFor(accountId), a, { perDay: cap, now, rand: this.rand });
    }
    this._save();
  }

  // The reach signal the limits maths actually reads: a flagged account reports
  // negative views, which maps to the recovery tier.
  _signalViews(a) { return a.flagged ? -1 : Number(a.avgViews || 0); }

  // How many posts/day this account is allowed to be scheduled at RIGHT NOW. This
  // is the dial behind "more views → more posts": a warming account plans at the
  // post-graduation starting rate (so its queue lays out from graduation day), a
  // warm account uses its reach tier, and a flagged one is 0 (post nothing).
  _allowance(a, now = Date.now()) {
    if (a.flagged) return 0;
    const phase = warmupPhase(a, now);
    if (phase < 4) return postsPerDay(4, 0);                 // starting ("new") rate, from graduation
    return postsPerDay(phase, this._signalViews(a));
  }

  // --- posts ---------------------------------------------------------------
  // Queue a post for an account (as a draft) and drop it into the next free slot.
  // Returns the post. If the account is still warming, the earliest slot is its
  // graduation day — so you can queue posts during warm-up and they simply wait.
  addPost({ accountId, id } = {}, now = Date.now()) {
    const a = this.account(accountId);
    if (!a) throw new Error(`unknown account ${accountId}`);
    const pid = id || nextId('post');
    const post = { id: pid, account: accountId, when: '', status: 'draft', createdAt: now, retries: 0 };
    this.state.posts[pid] = post;
    scheduleIntoNextSlot(this.postsFor(accountId), post, a, { perDay: this._allowance(a, now) || 1, now, rand: this.rand });
    this._save();
    return post;
  }

  // Re-plan one account's whole pending queue at the cap (the "Auto-schedule"
  // button). perDay falls back to the global cap.
  autoSchedule(accountId, { perDay = CAPS.posts, now = Date.now() } = {}) {
    const a = this.account(accountId); if (!a) return [];
    const r = autoSchedule(this.postsFor(accountId), a, { perDay, now, rand: this.rand });
    this._save();
    return r;
  }

  // --- the tick ------------------------------------------------------------
  // Call this on an interval. It fires due SESSIONS and due POSTS. Safe to call
  // as often as you like (every 30s is plenty); nothing double-fires.
  async tick(now = Date.now()) {
    // 1) sessions — make sure each account has today's plan, fire what's due.
    for (const a of this.accounts()) {
      const today = dayKey(now);
      if (!a.plan || a.plan.day !== today) {
        a.plan = { day: today, sessions: planDay(a, { now, views: this._signalViews(a), rand: this.rand }), firedIdx: -1 };
      }
      if (!a.usage || a.usage.day !== today) a.usage = { day: today, likes: 0, follows: 0, comments: 0 }; // caps reset daily
      if (this._sessionBusy.has(a.id) || postingNow().includes(a.id)) continue; // phone busy
      const idx = a.plan.sessions.findIndex((s, i) => i > a.plan.firedIdx && new Date(s.at).getTime() <= now);
      if (idx < 0) continue;
      const session = a.plan.sessions[idx];
      a.plan.firedIdx = idx;
      if (session.once && session.type === 'set_link_in_bio') a.linkInBioSet = true; // one-off, never re-scheduled

      // Expand the session into its concrete action recipe, budgeted by what the
      // account has left under today's caps, then bill the plan against the daily
      // counters so a later session this day sees the reduced budget.
      const phase = warmupPhase(a, now);
      const script = buildSessionScript(a, session, { phase, budget: sessionBudget(a.usage), rand: this.rand, now });
      a.usage.likes += script.planned.like;
      a.usage.follows += script.planned.follow;
      a.usage.comments += script.planned.comment;
      const fired = { ...session, script };

      this._sessionBusy.add(a.id);
      Promise.resolve()
        .then(() => this.onSession(a, fired))
        .catch((e) => console.warn(`[session] ${a.label}: ${session.label} failed — ${e && (e.message || e)}`))
        .finally(() => { this._sessionBusy.delete(a.id); this._save(); });
    }
    // 2) posts — one per account, warm accounts only, fleet-capped.
    const summary = await postingTick({
      accounts: this.accounts(),
      getPosts: (id) => this.postsFor(id),
      onPost: (acct, post) => Promise.resolve(this.onPost(acct, post)).then(() => { acct.postsLive = Number(acct.postsLive || 0) + 1; }),
      now, rand: this.rand,
    });
    this._save();
    return summary;
  }

  // --- read-only views for a Status page ----------------------------------
  status(now = Date.now()) {
    return this.accounts().map((a) => {
      const w = warmupStatus(a, now);
      return {
        id: a.id, label: a.label,
        warmup: w,
        phase: warmupPhase(a, now),
        tier: reachTier(this._signalViews(a)).name,
        avgViews: a.avgViews, flagged: a.flagged,
        postsLive: a.postsLive, linkInBioSet: a.linkInBioSet,
        calendar: calendarView(this.postsFor(a.id), a, { now }),
        todaysPlan: (a.plan && a.plan.day === dayKey(now)) ? a.plan.sessions : [],
        // engagement spent today vs the daily caps (counters reset each day).
        today: (a.usage && a.usage.day === dayKey(now))
          ? { likes: a.usage.likes, follows: a.usage.follows, comments: a.usage.comments }
          : { likes: 0, follows: 0, comments: 0 },
        caps: { likes: CAPS.likes, follows: CAPS.follows, comments: CAPS.comments, posts: CAPS.posts },
      };
    });
  }
}
