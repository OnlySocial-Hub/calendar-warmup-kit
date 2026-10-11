// posting.js — the dispatch loop that actually fires due posts.
// ---------------------------------------------------------------------------
// The calendar decides WHEN; this decides what happens when a slot arrives. It is
// deliberately small and defensive, because posting is the one thing you can't
// take back:
//
//   • ONE post per account per tick. If two of an account's posts ever come due
//     together (common after any downtime, when a backlog fires at once), only
//     the first goes; the rest stay scheduled and fire on later ticks. A post is
//     never interrupted by another post.
//   • Only runs when the account is warm (the calendar already enforces this, but
//     the dispatcher re-checks — belt and braces).
//   • Fleet concurrency: at most N accounts mid-post at any instant.
//   • A failed post isn't lost — it's put back into the next free slot (up to a
//     retry ceiling) so a transient glitch just tries again tomorrow.
//
// YOUR integration supplies `onPost(account, post)` — the function that drives the
// phone to publish. It should resolve on success and reject/throw on failure.
// Everything else (what a "post" is, how a phone is driven) stays in your bot.

import { FLEET } from './limits.js';
import { scheduleIntoNextSlot, dueItems } from './calendar.js';
import { canPost } from './warmup.js';

const MAX_RETRIES = 30; // a post slips to the next day this many times before it's left Failed

// Accounts currently mid-post (ids). Module-level so overlapping ticks can't
// double-fire the same account or blow past the fleet concurrency cap.
const busy = new Set();

// Run one scheduler tick. `getPosts(accountId)` returns that account's post array
// (the same array the calendar mutates); `accounts` is the list of account
// objects (need id + warmReadyAt). Returns a small summary of what it kicked off.
export async function tick({ accounts, getPosts, onPost, now = Date.now(), rand = Math.random }) {
  const started = [];
  for (const account of accounts) {
    if (busy.size >= FLEET.maxConcurrentSessions) break;   // fleet is full — the rest wait
    if (busy.has(account.id)) continue;                    // this account is already posting
    if (!canPost(account, now)) continue;                  // still warming — never fires (calendar won't place these anyway)

    const posts = getPosts(account.id) || [];
    const due = dueItems(posts, now).sort((a, b) => new Date(a.when) - new Date(b.when));
    if (!due.length) continue;

    const post = due[0]; // exactly ONE per account per tick
    busy.add(account.id);
    post.status = 'posting';
    started.push({ account: account.id, post: post.id });

    // Fire and forget within the tick — the loop moves on to other accounts while
    // this one publishes. (Don't await here, or the fleet runs one-at-a-time.)
    Promise.resolve()
      .then(() => onPost(account, post))
      .then(() => { post.status = 'posted'; post.postedAt = Date.now(); post.when = ''; })
      .catch((err) => {
        post.retries = Number(post.retries || 0) + 1;
        post.lastError = String(err && (err.message || err));
        if (post.retries <= MAX_RETRIES) {
          post.status = 'scheduled';
          // next free slot (tomorrow onward) — never stomps existing schedule
          if (!scheduleIntoNextSlot(posts, post, account, { now: Date.now(), rand })) post.status = 'failed';
        } else {
          post.status = 'failed';
        }
      })
      .finally(() => { busy.delete(account.id); });
  }
  return { started, busy: busy.size };
}

// Exposed so a Status view / tests can see who's mid-post without reaching inside.
export function postingNow() { return [...busy]; }
