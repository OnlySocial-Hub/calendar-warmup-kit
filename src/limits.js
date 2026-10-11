// limits.js — the rate limits and the "how busy should this account be" maths.
// ---------------------------------------------------------------------------
// Everything that decides HOW MUCH an account does in a day lives here, in one
// place, so it's easy to tune and easy to reason about. There are three layers:
//
//   1. hard caps        — ceilings nothing is ever allowed to cross (per account,
//                         per day). These keep a runaway loop or a bad config from
//                         hammering an account into a ban.
//   2. the warm-up ramp — how many SESSIONS a day an account runs while warming,
//                         which climbs gently over the two weeks.
//   3. the reach ramp   — once warm, how the daily plan grows or shrinks with a
//                         feedback signal (views): doing well → a bit more; getting
//                         flagged → back right off.
//
// Pure functions + a config object. No I/O, no phone code.

// --- 1. Hard caps (per account, per day) -----------------------------------
// 0 = unlimited for the engagement kinds (you opt in by setting a number); the
// post cap is always a real ceiling because posting is the visible, risky bit.
export const CAPS = {
  posts: 3,        // reels/stories published per account per day (the headline cap)
  follows: 20,     // follows per account per day
  likes: 80,       // likes per account per day
  comments: 8,     // comments per account per day
  dms: 0,          // cold DMs per account per day — 0 = OFF unless you deliberately set it
};

// --- Session cadence --------------------------------------------------------
// A "session" is one natural visit to the app (see sessions.js). Between sessions
// the phone RESTS for a human gap — never back-to-back. These bound both.
export const SESSION = {
  restMinMin: 30,          // shortest rest between sessions (minutes)
  restMaxMin: 90,          // longest rest between sessions (minutes)
  maxSessionsPerDay: 6,    // nothing ever runs more than this many sessions a day
  dayStartHour: 9,         // the account is only "awake" 9am…
  dayEndHour: 23,          // …to 11pm, local — no 4am activity
  minGapBetweenPostsMin: 10, // two posts for one account never land within 10 min
};

// --- Fleet-wide concurrency -------------------------------------------------
// One Mac drives many phones but can't sensibly run all of them at once (USB,
// CPU, and — more importantly — a hundred accounts all acting on the same minute
// is itself a pattern). The scheduler only lets this many phones be mid-session
// at a time; the rest wait their turn.
export const FLEET = {
  maxConcurrentSessions: 8,
};

// --- 2. The warm-up ramp ----------------------------------------------------
// Sessions per day while warming, by phase (see warmup.warmupPhase). Week one is
// light; it builds toward a normal cadence by graduation.
const WARMUP_SESSIONS_BY_PHASE = {
  1: { min: 1, max: 2 },   // settle in
  2: { min: 2, max: 3 },   // browsing
  3: { min: 2, max: 4 },   // establishing
};

// --- 3. The reach ramp (views -> sessions/posts) ----------------------------
// Once an account is warm, how hard it works follows how it's actually doing.
// `views` is a rolling reach signal you feed in (see engine.recordSignal) — e.g.
// average views across the last few posts. More reach earns a bigger daily plan
// (up to the hard caps); a flag/block signal drops it to the recovery tier.
//
// Tiers are deliberately coarse — this is a dial, not a controller.
const REACH_TIERS = [
  { name: 'recovery',   maxViews: -1,      sessionsPerDay: { min: 1, max: 2 }, postsPerDay: 0 }, // flagged / cooling down (only via views < 0)
  { name: 'new',        maxViews: 500,     sessionsPerDay: { min: 2, max: 3 }, postsPerDay: 1 },
  { name: 'growing',    maxViews: 5000,    sessionsPerDay: { min: 3, max: 4 }, postsPerDay: 2 },
  { name: 'performing', maxViews: Infinity, sessionsPerDay: { min: 3, max: 5 }, postsPerDay: 3 },
];

// Pick the reach tier for a views number. A negative views value is the signal
// for "this account is flagged" → the recovery tier (post nothing, act little).
export function reachTier(views = 0) {
  if (views < 0) return REACH_TIERS[0];
  for (const t of REACH_TIERS) if (views <= t.maxViews) return t;
  return REACH_TIERS[REACH_TIERS.length - 1];
}

// How many posts a day is this account allowed right now?
//   - still warming  -> 0 (posting is gated; see warmup.js)
//   - warm           -> its reach tier's postsPerDay, never above the hard cap
export function postsPerDay(phase, views = 0) {
  if (phase < 4) return 0;
  return Math.min(CAPS.posts, reachTier(views).postsPerDay);
}

// How many SESSIONS a day should this account run? Warm-up uses the phase ramp;
// a warm account uses its reach tier. Always clamped to maxSessionsPerDay.
export function sessionsPerDay(phase, views = 0, rand = Math.random) {
  const band = phase < 4 ? WARMUP_SESSIONS_BY_PHASE[phase] || { min: 1, max: 2 }
                         : reachTier(views).sessionsPerDay;
  const n = Math.round(band.min + rand() * (band.max - band.min));
  return Math.max(0, Math.min(SESSION.maxSessionsPerDay, n));
}

// A human rest gap (ms) between two sessions.
export function restGapMs(rand = Math.random) {
  const lo = SESSION.restMinMin, hi = SESSION.restMaxMin;
  return Math.round((lo + rand() * (hi - lo)) * 60000);
}

// --- Link-in-bio gate -------------------------------------------------------
// A fresh account with a link in its bio is a classic spam tell, so the link goes
// in LATE and only once the account has earned it: it must be (a) fully warmed,
// (b) have a few posts live, and (c) be showing real reach. Until all three are
// true, no link session is ever scheduled. See sessions.LINK_IN_BIO.
export const LINK_IN_BIO = {
  minPostsLive: 6,     // at least this many posts have gone out
  minAvgViews: 750,    // sustained reach, not a one-off
  // after it's set once we leave it alone unless you ask to refresh it
};

export function shouldSetLinkInBio(account, now = Date.now()) {
  if (!account || account.linkInBioSet) return false;              // already done
  if (!account.warmReadyAt || now < account.warmReadyAt) return false; // still warming
  const posts = Number(account.postsLive || 0);
  const views = Number(account.avgViews || 0);
  return posts >= LINK_IN_BIO.minPostsLive && views >= LINK_IN_BIO.minAvgViews;
}
