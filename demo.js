// demo.js — run the whole calendar with NO phones, on a simulated clock.
//   node demo.js
//
// It creates three accounts, queues posts, then fast-forwards ~20 days a few
// hours at a time, printing what the engine decides each day: warm-up progress,
// how many sessions fire, when posting starts, how the plan grows with "views",
// how a flagged account backs off, and when the link-in-bio session appears.
// Nothing here touches a real device — onSession/onPost just tally what happened.

import { CalendarEngine } from './src/engine.js';
import { runSessionScript, mockActions } from './src/activity.js';

const DAY = 86400000;
const flush = () => new Promise((r) => setTimeout(r, 0)); // let posting promises settle

// Count what fires, per account, each simulated day.
let tally = {};
const slot = (id) => (tally[id] ||= { sessions: 0, posts: 0, likes: 0, follows: 0, link: false });
const bump = (id, k) => { const t = slot(id); t[k] = k === 'link' ? true : t[k] + 1; };

const engine = new CalendarEngine({
  // deterministic-ish randomness so the demo reads the same-ish each run
  rand: (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })(),
  // Run the session's real action recipe (activity.js) against the no-op device,
  // and tally the engagement it produced — so the likes/follows columns below are
  // what the sessions actually did, not just a plan.
  onSession: async (a, s) => {
    bump(a.id, 'sessions');
    if (s.type === 'set_link_in_bio') bump(a.id, 'link');
    const did = await runSessionScript(s.script, mockActions);
    const t = slot(a.id); t.likes += did.liked; t.follows += did.followed;
  },
  onPost: (a) => { bump(a.id, 'posts'); return Promise.resolve(); },
});

const t0 = Date.parse('2026-01-01T08:00:00');
const A = engine.addAccount({ id: 'nova', label: 'nova' }, t0);
const B = engine.addAccount({ id: 'echo', label: 'echo' }, t0);
const C = engine.addAccount({ id: 'wren', label: 'wren' }, t0);
for (const acct of [A, B, C]) for (let i = 0; i < 12; i++) engine.addPost({ accountId: acct.id }, t0);

console.log('Warm-up windows (days):',
  engine.accounts().map((a) => `${a.label} ${Math.round((a.warmReadyAt - a.warmStartedAt) / DAY)}`).join('  '));
console.log('\nday  acct   warmup           tier        sessions  posts  likes  follows');
console.log('---  ----   ---------------  ----------  --------  -----  -----  -------');

for (let day = 0; day < 22; day++) {
  tally = {};
  const dayStart = t0 + day * DAY;
  // step through the day every ~90 min so sessions/posts come due naturally
  for (let now = dayStart; now < dayStart + DAY; now += 90 * 60000) {
    await engine.tick(now);
    await flush();
  }
  // a believable reach signal: nothing until an account has posted, then it grows;
  // flag "echo" on day 17 to show the recovery back-off.
  const signalAt = dayStart + DAY - 1;
  for (const a of engine.accounts()) {
    if (a.postsLive > 0) engine.recordSignal(a.id, { views: Math.min(8000, a.postsLive * 420) }, signalAt);
    if (a.id === 'echo' && day === 17) engine.recordSignal(a.id, { flagged: true }, signalAt);
  }
  const st = engine.status(dayStart + DAY - 1);
  for (const s of st) {
    const t = tally[s.id] || { sessions: 0, posts: 0, likes: 0, follows: 0, link: false };
    const warm = s.warmup.ready ? 'posting' : `warming ${s.warmup.dayOf}/${s.warmup.totalDays}`;
    console.log(
      String(day + 1).padStart(3), ' ',
      s.label.padEnd(5), ' ',
      warm.padEnd(15), ' ',
      s.tier.padEnd(10), ' ',
      String(t.sessions).padStart(6), '  ',
      String(t.posts).padStart(4), '  ',
      String(t.likes).padStart(4), '  ',
      String(t.follows).padStart(5),
      t.link ? '  ← link-in-bio set' : (s.flagged ? '  (flagged → recovery)' : ''),
    );
  }
  console.log('');
}
console.log('Done. Notice: no posts fire until an account finishes warm-up; the');
console.log('session count climbs through warm-up and with reach; the link-in-bio');
console.log('session only appears after graduation + enough posts + real views.');
