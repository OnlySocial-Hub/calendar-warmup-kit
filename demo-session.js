// demo-session.js — show EXACTLY what one session does, action by action.
//   node demo-session.js
//
// This is the "what do the sessions really do" view. It builds the concrete
// recipe for a few session types (via activity.buildSessionScript) and prints
// every action with its timing, then "runs" one against the mock device adapter
// so you can see the tally. Nothing here touches a phone.

import { buildSessionScript, describeScript, runSessionScript, sessionBudget, mockActions } from './src/activity.js';

// deterministic randomness so the output reads the same each run
const rand = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();

// A full day's engagement budget available (nothing spent yet today).
const budget = sessionBudget({ likes: 0, follows: 0, comments: 0 });

const examples = [
  { title: 'WARM account, Reels scroll (phase 4)', session: { type: 'scroll_reels', durationMin: 6 }, phase: 4 },
  { title: 'WARM account, Engagement session (phase 4)', session: { type: 'engagement', durationMin: 5 }, phase: 4 },
  { title: 'WARM account, Follow list (phase 4)', session: { type: 'follow_list', durationMin: 3 }, phase: 4 },
  { title: 'WEEK-ONE account, Reels scroll (phase 1 — watch only)', session: { type: 'scroll_reels', durationMin: 5 }, phase: 1 },
  { title: 'AFK, Watch Stories (phase 2)', session: { type: 'watch_stories', durationMin: 4 }, phase: 2 },
];

for (const ex of examples) {
  const script = buildSessionScript({ id: 'demo' }, ex.session, { phase: ex.phase, budget, rand });
  console.log('\n============================================================');
  console.log(ex.title);
  console.log('============================================================');
  console.log(describeScript(script));
}

// Run one of them against the mock "device" to show the executor + tally.
console.log('\n\n--- running the engagement session against the mock device ---');
const script = buildSessionScript({ id: 'demo' }, { type: 'engagement', durationMin: 5 }, { phase: 4, budget, rand });
const tally = await runSessionScript(script, mockActions);
console.log('tally:', tally);
console.log('\nSwap `mockActions` for your own adapter (openApp/watch/like/follow/…)');
console.log('and these same recipes drive a real phone. See src/activity.js.');
