#!/usr/bin/env node
/* Test du salon multijoueur Colyseus.
   Couvre le parcours réel : l'hôte CRÉE un salon, l'invité le REJOINT par code,
   l'hôte ajoute une IA puis lance — et on vérifie que tout le monde partage la
   même room, la même graine de monde et les mêmes positions de Leader. */

import { Client } from 'colyseus.js';

const URL = process.env.SERVER || 'ws://localhost:2567';

let pass = 0, fail = 0;
const assert = (c, m) => { c ? (pass++, console.log(`  ok  ${m}`)) : (fail++, console.error(`  FAIL ${m}`)); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const code = 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();

let host, guest;
try {
  console.log(`== salon ${code} : création + rejoint par code ==`);
  host = await new Client(URL).create('quickplay', { name: 'Alice', leaderKey: 'monk', code });
  guest = await new Client(URL).join('quickplay', { name: 'Bob', leaderKey: 'sorcerer', code });
  assert(host.roomId === guest.roomId, 'les deux joueurs sont dans la MÊME room');

  await wait(300);
  assert(host.state.slots.size === 2, `2 places occupées (got ${host.state.slots.size})`);
  assert(host.state.leaders.size === 0, 'aucun Leader avant le lancement (phase lobby)');
  assert(host.state.hostSessionId === host.sessionId, 'le créateur est hôte');

  console.log('== un code inconnu ne doit PAS créer de salon fantôme ==');
  let joinFailed = false;
  try {
    await new Client(URL).join('quickplay', { name: 'Zoé', leaderKey: 'monk', code: 'ZZZZ' });
  } catch (_) { joinFailed = true; }
  assert(joinFailed, 'join sur un code inexistant est rejeté');

  console.log('== IA ajoutée par l’hôte ==');
  host.send('addBot', { difficulty: 'hard' });
  await wait(400);
  assert(host.state.slots.size === 3, `3 places dont 1 IA (got ${host.state.slots.size})`);
  let botId = null;
  guest.state.slots.forEach((s, id) => { if (s.kind === 'bot') botId = id; });
  assert(!!botId, 'l’invité voit l’IA du salon');

  console.log('== un invité ne peut pas piloter le salon ==');
  guest.send('addBot', { difficulty: 'easy' });
  await wait(300);
  assert(host.state.slots.size === 3, 'addBot ignoré pour un non-hôte');

  console.log('== lancement du match ==');
  host.send('startMatch');
  await wait(500);
  assert(host.state.phase === 'play', `phase = play (got ${host.state.phase})`);
  assert(host.state.leaders.size === 3, `3 Leaders en jeu (got ${host.state.leaders.size})`);
  assert(host.state.seed === guest.state.seed && host.state.seed > 0,
    `même graine de monde (${host.state.seed})`);
  assert(!!host.state.biome && host.state.biome === guest.state.biome,
    `même biome (${host.state.biome})`);
  const seats = [];
  host.state.leaders.forEach((l) => seats.push(l.seatIndex));
  assert(new Set(seats).size === 3, 'places distinctes (bases réparties pareil partout)');

  console.log('== déplacement du joueur ==');
  const me = () => host.state.leaders.get(host.sessionId);
  const before = { x: me().x, z: me().z };
  host.send('input', { x: 1, z: 0, boost: false });
  await wait(600);
  const moved = Math.hypot(me().x - before.x, me().z - before.z);
  assert(moved > 1, `mon Leader avance (${moved.toFixed(2)} u)`);
  assert(Math.abs(guest.state.leaders.get(host.sessionId).x - me().x) < 0.6,
    'l’invité voit ma position');

  console.log('== l’IA est simulée par le serveur (et ne plante pas le tick) ==');
  const bot0 = { x: host.state.leaders.get(botId).x, z: host.state.leaders.get(botId).z };
  const tick0 = host.state.tick;
  await wait(900);
  const botNow = host.state.leaders.get(botId);
  const botMoved = Math.hypot(botNow.x - bot0.x, botNow.z - bot0.z);
  assert(host.state.tick > tick0 + 5, `la boucle serveur tourne (tick ${tick0} → ${host.state.tick})`);
  assert(botMoved > 0.5, `l’IA bouge côté serveur (${botMoved.toFixed(2)} u)`);
  assert(Math.abs(guest.state.leaders.get(botId).x - botNow.x) < 0.6,
    'les deux clients voient l’IA au même endroit');

  console.log('== score : chacun le sien, l’hôte pour les IA ==');
  host.send('stats', { sessionId: host.sessionId, count: 12, grisAbs: 7, score: 4242, pct: 31.5 });
  host.send('stats', { sessionId: botId, count: 5, grisAbs: 2, score: 999, pct: 9 });
  guest.send('stats', { sessionId: host.sessionId, count: 0, grisAbs: 0, score: 1, pct: 0 });
  await wait(400);
  assert(guest.state.leaders.get(host.sessionId).score === 4242, 'mon score est partagé tel quel');
  assert(guest.state.leaders.get(botId).score === 999, 'l’hôte fait autorité sur le score des IA');

  console.log('== salon déjà lancé : on ne peut plus le rejoindre ==');
  let lateJoinFailed = false;
  try {
    await new Client(URL).join('quickplay', { name: 'Retard', leaderKey: 'monk', code });
  } catch (_) { lateJoinFailed = true; }
  assert(lateJoinFailed, 'join refusé pendant le match');

  console.log('== départ du dernier humain : plus d’IA fantôme ==');
  await guest.leave();
  await host.leave();
  host = guest = null;
  await wait(600);
  let ghost = false;
  try {
    await new Client(URL).join('quickplay', { name: 'Neuf', leaderKey: 'monk', code });
    ghost = true;
  } catch (_) { /* attendu : la room est partie avec ses IA */ }
  assert(!ghost, 'le salon vidé ne survit pas avec ses IA');
} catch (e) {
  fail++;
  console.error('  EXCEPTION', e);
} finally {
  // Pas de await : une room déjà fermée ne résout jamais sa promesse de sortie.
  try { host?.leave(); } catch (_) {}
  try { guest?.leave(); } catch (_) {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
