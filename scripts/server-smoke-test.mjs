#!/usr/bin/env node
/* Test de connexion serveur Colyseus.
   Joint une room quickplay avec 2 clients, envoie des inputs, vérifie que
   les positions des Leaders bougent bien à distance. */

import { Client } from 'colyseus.js';

const URL = process.env.SERVER || 'ws://localhost:2567';
const client1 = new Client(URL);
const client2 = new Client(URL);

let pass = 0, fail = 0;
const assert = (c, m) => { c ? (pass++, console.log(`  ok  ${m}`)) : (fail++, console.error(`  FAIL ${m}`)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  console.log('== joining room ==');
  const r1 = await client1.joinOrCreate('quickplay', { name: 'Alice', leaderKey: 'monk' });
  const r2 = await client2.joinOrCreate('quickplay', { name: 'Bob', leaderKey: 'sorcerer' });
  assert(r1.roomId === r2.roomId, 'same room');

  await wait(300);
  assert(r1.state.leaders.size === 2, `2 leaders in state (got ${r1.state.leaders.size})`);

  console.log('== waiting for match start (5s lobby) ==');
  await wait(5500);
  assert(r1.state.phase === 'play', `phase = play (got ${r1.state.phase})`);

  console.log('== sending inputs ==');
  const myLeaderId = r1.sessionId;
  const before = { x: r1.state.leaders.get(myLeaderId).x, z: r1.state.leaders.get(myLeaderId).z };
  r1.send('input', { x: 1, z: 0, boost: false });
  await wait(500);
  const after = { x: r1.state.leaders.get(myLeaderId).x, z: r1.state.leaders.get(myLeaderId).z };
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  assert(moved > 1, `leader moved (${moved.toFixed(2)} units)`);

  console.log('== other client sees the move ==');
  const seenFromBob = r2.state.leaders.get(myLeaderId);
  assert(Math.abs(seenFromBob.x - after.x) < 0.5, 'bob sees alice at same x');

  await r1.leave();
  await r2.leave();
} catch (e) {
  fail++;
  console.error('  EXCEPTION', e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
