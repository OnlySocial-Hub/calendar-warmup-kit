# Calendar + Warm-up Kit

The **calendar, posting-schedule, and two-week warm-up engine** pulled out of a
working iPhone social-automation farm, as a small, self-contained set of modules
you can drop into your own bot.

It deliberately contains **only** the "when and how much" brain:

- the **warm-up clock** that stops a fresh account posting for ~2 weeks,
- the **calendar/scheduler** that decides when posts go out,
- the **session planner** (scroll / AFK / engage / follow / link-in-bio) that
  fills the rest of the day with human-like activity,
- the **rate limits** and the **feedback loop** (more views → more activity; a
  flag → back off),
- a small **dispatch loop** that fires due posts safely.

It does **not** include any device/automation code — no WebDriverAgent, no
Instagram tapping, no UI, no accounts/proxy/credential handling. You plug in the
two functions that actually touch a phone and the engine drives the rest. That's
the whole point: this is the part that's fiddly to get right (timings, caps, the
warm-up ramp), separated from the part that's specific to your setup.

> This is extracted from a bot that already runs this way. Where this README says
> "we", it's describing how the full system works around these files (e.g. a
> Status page and an Overseer watchdog) — those aren't included here, just
> described so you know what to build around it.

---

## What's in here

```
src/
  warmup.js    the two-week warm-up clock + the ramp phases
  calendar.js  the posting schedule: slots, per-day cap, auto-schedule, "what's due"
  sessions.js  the session catalogue + the day planner (what happens, when)
  limits.js    every rate limit + the views→activity maths, in one place
  posting.js   the dispatch loop: fire due posts, one per account, warm only
  engine.js    ties it together; owns state, persists it, exposes a tick() + status()
  store.js     tiny crash-safe JSON persistence (atomic writes)
demo.js        run the whole thing on a simulated clock with NO phones
```

Run the demo to see it work end to end (no phones, no setup):

```bash
node demo.js
```

You'll watch three accounts warm up for ~2 weeks (no posting), then start
posting once a day, ramp up as their "views" climb, set a link in bio once
they've earned it, and one account get "flagged" and automatically back off.

---

## For your Claude Code — how to wire it into your bot

You only have to supply two functions — the ones that drive a phone:

```js
import { CalendarEngine } from "./src/engine.js";

const engine = new CalendarEngine({
  dataFile: "./data/calendar.json",         // state survives restarts (atomic writes)

  // Run one human session on the phone for this account. Resolve when done.
  onSession: async (account, session) => {
    // session.type is one of: scroll_reels | scroll_home | watch_stories |
    //   search_explore | engagement | follow_list | set_link_in_bio
    // session.durationMin is how long to run it for.
    await yourBot.runSession(account.id, session.type, session.durationMin);
  },

  // Publish one post on the phone for this account. Resolve on success, THROW on
  // failure (a failure is automatically retried into the next free slot).
  onPost: async (account, post) => {
    await yourBot.publish(account.id, post.id);   // post.id is yours to map to a clip
  },
});

// 1. When an account/phone is set up, add it — this STARTS its warm-up clock.
engine.addAccount({ id: udid, label: "@handle" });

// 2. Queue posts whenever (even during warm-up — they wait for graduation).
engine.addPost({ accountId: udid });              // one per clip you want to post

// 3. Tick on an interval. Every ~30s is plenty; nothing double-fires.
setInterval(() => engine.tick().catch(console.error), 30_000);

// 4. Feed back how each account is doing (drives the ramp). Call it whenever you
//    read an account's reach — e.g. after a post, or on a schedule.
engine.recordSignal(udid, { views: avgViewsOfLastFewPosts });
engine.recordSignal(udid, { flagged: true });     // cooling down after an action-block

// 5. Read engine.status() for a dashboard: per-account warm-up clock, tier,
//    today's plan, and the scheduled-posts calendar.
```

Everything is in-memory + mirrored to one JSON file, so a restart continues
exactly where it left off. All the timing functions take an injectable `now` and
`rand`, so it's easy to unit-test on a fake clock (see `demo.js`).

---

## The design, in plain English

### How, when, and for how long is the warm-up?

**When:** the moment an account is created / a phone is set up, you `addAccount`,
which starts its warm-up clock. **How long:** about two weeks — but not exactly.
Each account gets a randomised **12–16 day** window (`warmup.js`,
`WARM_MIN_DAYS`/`WARM_MAX_DAYS`) so a whole farm doesn't "graduate" on the same
day in a suspicious lockstep.

**How:** during warm-up the account does nothing but behave like a real person
who just joined — it opens the app, watches Reels and Stories, searches, and
(later in the two weeks) follows a handful of people. It **posts nothing**. This
is enforced structurally: the calendar literally cannot place a post before the
clock is up — the earliest slot it will consider is the account's graduation day
(`calendar.js`, `earliestDay`). Posting a Reel on day one is the single clearest
"this is a bot" signal, so the warm-up gate is the most important rule here.

Warm-up isn't flat — it **ramps** over three phases (`warmup.warmupPhase`):

| Phase | Days (of ~14) | Behaviour |
|-------|---------------|-----------|
| 1 — settle in | ~1–4 | mostly watching, almost no engagement, 1–2 sessions/day |
| 2 — browsing | ~5–9 | light likes / the odd save, 2–3 sessions/day |
| 3 — establishing | ~10–end | light follows + a little more engagement, 2–4 sessions/day |

By graduation the account already looks lived-in, so its first post isn't going
out onto a dead profile.

### What kinds of sessions are there? What's "in the calendar"?

A day is two layers over the clock: the **posts** that go out (calendar.js) and
the **sessions** of activity around them (sessions.js). A session is one natural
visit to the app. The catalogue (`sessions.SESSION_TYPES`):

- **`scroll_reels`** — scroll the Reels feed (3–8 min)
- **`scroll_home`** — scroll the home feed (2–5 min)
- **`watch_stories`** — watch Stories; this is the **"AFK" session** — just
  watching, no engagement. A day that's *all* action and no idle watching reads
  as a bot, so the planner always keeps at least one of these a day.
- **`search_explore`** — search a term, open the top result, browse (2–5 min)
- **`engagement`** — likes / the occasional comment (phase 2+ only)
- **`follow_list`** — follow a few accounts to grow (phase 3+ only)
- **`set_link_in_bio`** — a one-off (see below), never in the normal rotation

Between every session the phone **rests** for a human gap — **30–90 minutes**,
never back-to-back (`limits.SESSION.restMin/MaxMin`). Sessions only run inside an
"awake" window of **9am–11pm** local; there's no 4am activity. The planner
(`sessions.planDay`) lays the day out: pick a start in the morning, run a
session, rest, run the next, until it either hits the day's session count or runs
past bedtime (in which case the leftover simply doesn't happen — a real person
doesn't cram).

### What architecture does it run on?

A single **Node.js process** on one Mac drives the whole farm. The shape:

- **Per phone, one thing at a time.** Each phone has a "runner" that runs exactly
  one session (or one post) at a time; a post is never interrupted by another
  post, and a session never overlaps a post on the same handset.
- **A tick loop.** A timer fires every ~30s and calls `engine.tick()`, which (a)
  makes sure each account has today's session plan and fires any session whose
  time has come, and (b) fires any post that's due — **one per account per tick**,
  warm accounts only.
- **Flat-file state, written atomically.** All of it (accounts, warm-up clocks,
  scheduled posts) lives in memory and is mirrored to one JSON file via
  `store.js`, which writes to a temp file and renames over the real one so a crash
  mid-write can't wipe the schedule. Everything is keyed by the phone's **stable
  device id (UDID)**, not a slot number, so it survives phones being re-plugged in
  a different order.
- **Observed, not babysat.** In our bot a **Status page** reads `engine.status()`
  to show each phone's warm-up clock ("warming · 4d left" / "ready to post"),
  today's plan and the posting calendar; an **Overseer watchdog** periodically
  checks each phone is still doing its job and flags anything stuck. (Those UIs
  aren't in this kit — build whatever you like on top of `status()`.)
- **Scale.** One Mac comfortably drives dozens of phones this way; past that you
  run a fleet agent per Mac reporting into one dashboard. The engine itself is
  fleet-size-agnostic — the only global knob is concurrency (below).

### What are the rate limits? How many sessions, max?

All in `limits.js`, one place to tune:

- **Posts:** default **3 per account per day** — the headline cap, and always a
  real ceiling.
- **Sessions:** at most **6 per account per day** (`maxSessionsPerDay`); in
  practice a warming account does 1–4 and a warm one 2–5 depending on reach.
- **Engagement caps per account per day:** follows **20**, likes **80**,
  comments **8**, DMs **0** (off unless you deliberately set a number — DMing
  strangers is the most flag-prone thing there is).
- **Rests:** 30–90 min between sessions; **no two posts within 10 minutes**;
  activity only 9am–11pm.
- **Fleet concurrency:** at most **8 phones mid-session at once**
  (`FLEET.maxConcurrentSessions`) — a hundred accounts all acting on the same
  minute is itself a pattern, so the rest wait their turn.

### Is there a process — more views → more/less sessions?

Yes, that's the feedback loop. You feed the engine a reach signal
(`engine.recordSignal(id, { views })` — e.g. the average views of an account's
last few posts) and it sorts the account into a **tier** (`limits.REACH_TIERS`):

| Tier | Signal | Sessions/day | Posts/day |
|------|--------|--------------|-----------|
| new | just graduated / low reach | 2–3 | 1 |
| growing | some reach | 3–4 | 2 |
| performing | strong reach | 3–5 | 3 |
| recovery | **flagged** | 1–2 | 0 |

So an account that's doing well earns a denser calendar (more posts/day, up to
the hard cap, and a bit more engagement); one that isn't stays light. If it gets
**flagged** (an action-block, a suspension warning — you call
`recordSignal(id, { flagged: true })`), it drops to **recovery**: it posts
nothing and does only a session or two a day until you clear the flag, at which
point it re-plans and ramps back up. The re-planning happens automatically inside
`recordSignal`, so the calendar always reflects the latest signal.

### Is there a "link in bio" session, and when?

Yes — and it's deliberately **late**. A fresh account with a link in its bio is a
classic spam tell, so the link only goes in once the account has earned it. The
gate (`limits.shouldSetLinkInBio`) requires **all three**:

1. the account is fully **warmed** (past its two weeks),
2. it has at least **6 posts live**, and
3. it's showing **sustained reach** (avg views ≥ ~750 — a real signal, not a
   one-off).

When all three are true, the planner injects a one-off **`set_link_in_bio`**
session near the start of the next day (before it posts), your `onSession` adds
the link, and the account is marked so it's never scheduled again (unless you
choose to refresh it). Until then, no link session exists for that account.

---

## Tuning

Almost everything you'd want to change is a constant in **`limits.js`** (caps,
rests, tiers, the link-in-bio thresholds, fleet concurrency) or **`warmup.js`**
(the 12–16 day window, the phase boundaries). The scheduling maths in
`calendar.js` and the session catalogue in `sessions.js` are the two other knobs.
Nothing here reaches out to a network or a device, so you can change a number and
re-run `node demo.js` to see the effect immediately.

MIT licensed. Built from a production farm's calendar/warm-up system; the
device-driving half is intentionally not included.
