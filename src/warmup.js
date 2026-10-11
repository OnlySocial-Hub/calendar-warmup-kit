// warmup.js — the two-week warm-up clock that gates posting.
// ---------------------------------------------------------------------------
// A brand-new account (or a fresh phone) is NOT allowed to post. It first spends
// ~2 weeks behaving like a real person who just made an account: opening the app,
// watching Reels and Stories, searching, following a handful of people — and
// nothing else. Posting a Reel on day one is the single biggest "this is a bot"
// signal there is, so the calendar refuses to schedule anything until the clock
// below says the account is warm.
//
// The clock is per-account and deliberately a little different every time
// (12–16 days, not a hard 14) so a whole farm doesn't "graduate" on the same day
// in a suspicious lockstep. Everything here is pure data + time math — no I/O —
// so it's trivial to drop into any store.

const DAY = 86400000;

// Warm-up baseline ≈ 2 weeks, with natural variance each time.
export const WARM_MIN_DAYS = 12;
export const WARM_MAX_DAYS = 16;

// Start (or restart) the warm-up clock on an account. Call this the moment the
// account is created / the phone is set up. Returns the fields to store on it.
// `rand` is injectable so a test can make it deterministic.
export function startWarmup(now = Date.now(), rand = Math.random) {
  const days = WARM_MIN_DAYS + rand() * (WARM_MAX_DAYS - WARM_MIN_DAYS);
  return {
    warmStartedAt: now,
    warmReadyAt: now + Math.round(days * DAY),
  };
}

// How far through warm-up is this account? Returns a small status object the
// Status page (and the scheduler) read. `account` just needs warmStartedAt /
// warmReadyAt (null/undefined = never warmed = treat as not ready).
export function warmupStatus(account, now = Date.now()) {
  const startedAt = account && account.warmStartedAt;
  const readyAt = account && account.warmReadyAt;
  if (!startedAt || !readyAt) {
    return { state: 'cold', ready: false, dayOf: 0, totalDays: 0, daysLeft: null, progress: 0 };
  }
  const total = Math.max(1, readyAt - startedAt);
  const elapsed = Math.min(total, Math.max(0, now - startedAt));
  const ready = now >= readyAt;
  return {
    state: ready ? 'warm' : 'warming',
    ready,
    dayOf: Math.floor(elapsed / DAY) + 1,                 // "day 3 of 14"
    totalDays: Math.round(total / DAY),
    daysLeft: Math.max(0, Math.ceil((readyAt - now) / DAY)),
    progress: elapsed / total,                            // 0..1
  };
}

// The gate the calendar checks before it will schedule ANY post for an account.
export function canPost(account, now = Date.now()) {
  return warmupStatus(account, now).ready;
}

// Warm-up is not flat — it ramps. Week one is light and almost all passive
// (watch, don't touch); week two adds a little engagement and the first small
// follows, so by graduation the account already looks lived-in. This returns the
// "phase" for a given point in warm-up, which sessions.js uses to pick how many
// sessions to run and how spicy they're allowed to be.
//
//   phase 1 (day 1–4):   settle in — mostly watching, almost no engagement
//   phase 2 (day 5–9):   browsing — light likes, the occasional save
//   phase 3 (day 10–end): establishing — light follows + a touch more engagement
export function warmupPhase(account, now = Date.now()) {
  const s = warmupStatus(account, now);
  if (s.state === 'cold') return 0;
  if (s.ready) return 4;                 // graduated — normal posting cadence
  const frac = s.progress;
  if (frac < 0.3) return 1;
  if (frac < 0.65) return 2;
  return 3;
}
