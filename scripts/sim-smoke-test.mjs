#!/usr/bin/env node
/* Test de fumée du moteur headless.
   But : prouver que src/sim/* se charge et tourne dans Node pur, sans
   Three.js, sans DOM, sans navigateur. C'est le pré-requis pour le futur
   serveur Colyseus (Phase 2).

   Ce test ne remplace pas encore la boucle update() complète — les
   sous-tâches 1c.6-9 sont encore côté main.js. Ce qu'on valide :
   - Les 9 modules sim se chargent en Node
   - Les factories créent des objets pleins
   - Le RNG seedé est déterministe
   - Les helpers purs (leader speed, disciple XP) donnent les bonnes valeurs */

import { createRng } from '../src/sim/rng.js';
import * as constants from '../src/sim/constants.js';
import {
  createSimState, createAgent, resetAgent, createFaction, createTeam, createShrine,
} from '../src/sim/state.js';
import {
  discXpNeed, discSpeedMul, discPaintMul, discSpd, discXpFrac,
} from '../src/sim/disciples.js';
import { leaderSpeed, discipleCap, inOwnBase } from '../src/sim/leader.js';
import { aiThink, paintMixAround, AI_TUNING } from '../src/sim/ai.js';
import { createEffects } from '../src/sim/effects.js';
import { stepLeaders, stepLeaderRepulsion } from '../src/sim/leader-tick.js';
import { stepCrowd } from '../src/sim/crowd-tick.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok  ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

section('constants chargées');
assert(constants.MAP_R === 60, 'MAP_R = 60');
assert(constants.NB_FACTIONS === 3, 'NB_FACTIONS = 3');
assert(constants.CONV_R === 3.15, 'CONV_R = 3.15');

section('RNG seedé déterministe');
{
  const a = createRng(42), b = createRng(42);
  const seq1 = [a.next(), a.next(), a.next(), a.next(), a.next()];
  const seq2 = [b.next(), b.next(), b.next(), b.next(), b.next()];
  assert(JSON.stringify(seq1) === JSON.stringify(seq2), 'même seed → même séquence');
  const c = createRng(43);
  const s3 = c.next();
  assert(s3 !== seq1[0], 'seed différent → séquence différente');
  // Sérialisation : e reprend là où d s'est arrêté
  const d = createRng(42);
  d.next(); d.next();
  const st = d.getState();
  const e = createRng(1); e.setState(st);
  assert(e.next() === d.next(), 'setState/getState restaure la séquence');
}

section('factories d\'état');
{
  const s = createSimState(7);
  assert(s.seed === 7, 'seed stocké');
  assert(Array.isArray(s.agents), 'agents = []');
  assert(Array.isArray(s.factions), 'factions = []');
  assert(s.grayCount === 0, 'grayCount = 0');

  const a = createAgent(5, 1.5, -3.2, 0, 1.1);
  assert(a.id === 5, 'agent id');
  assert(a.x === 1.5 && a.z === -3.2, 'agent pos');
  assert(a.discipleOf === -1, 'agent gris par défaut');
  assert(a.dead === false, 'agent vivant');

  resetAgent(a, 10, 20, Math.PI);
  assert(a.x === 10 && a.z === 20, 'reset agent pos');
  assert(a.face === Math.PI, 'reset agent face');
  assert(a.pop === 0.001, 'reset agent pop');

  const cult = { c: 0xff00ff, name: 'Test', sym: '❤' };
  const f = createFaction(0, 0, cult, 'monk', 0, 0, { fuel: 100 });
  assert(f.i === 0, 'faction i');
  assert(f.leader.x === 0 && f.leader.z === 0, 'faction leader pos');
  assert(f.fuel === 100, 'faction fuel');
  assert(f.count === 0, 'faction count = 0');
  assert(f.alive === true, 'faction vivante');
  assert(f.css === '#ff00ff', 'faction css');

  const t = createTeam(0, 30, -20, 7.2, 1.4, 0, 0.5, cult);
  assert(t.baseX === 30 && t.baseZ === -20, 'team base pos');
  assert(t.wallR === 7.2, 'team wallR');
}

section('disciple helpers');
assert(discXpNeed(1) === 30, 'discXpNeed(1) = 30');
assert(discXpNeed(2) === 45, 'discXpNeed(2) = 45');
assert(discXpNeed(3) === 0, 'discXpNeed(3) = 0');
{
  const a1 = { discLvl: 1 }, a2 = { discLvl: 2 }, a3 = { discLvl: 3 };
  assert(discSpeedMul(a1) === 1, 'disc lvl 1 = 1x');
  assert(Math.abs(discSpeedMul(a2) - 1.1) < 1e-9, 'disc lvl 2 = 1.1x');
  assert(Math.abs(discSpeedMul(a3) - 1.32) < 1e-9, 'disc lvl 3 = 1.32x');
  assert(discSpd(a1) === constants.DISC_SPD, 'discSpd lvl 1');
}

section('leader helpers avec ctx');
{
  const ctx = {
    skillMods: { speedMaxMult: 1, speedMinMult: 1, discipleMaxBonus: 0 },
    paintOwnerAt: () => -1,
  };
  const f = createFaction(0, 0, { c: 0, name: '', sym: '' }, 'monk', 0, 0);
  const v = leaderSpeed(f, ctx);
  assert(v === constants.V_MAX, `leader vide → V_MAX (${v})`);
  f.count = constants.N_REF;
  const v2 = leaderSpeed(f, ctx);
  assert(Math.abs(v2 - constants.V_MIN) < 1e-9, `leader plein → V_MIN (${v2})`);

  assert(discipleCap(f, ctx) === constants.DISCIPLE_MAX_BASE, 'discipleCap base');

  const teams = [{ baseX: 0, baseZ: 0, wallR: 7.2 }];
  assert(inOwnBase(f, teams) === true, 'leader à sa base');
  f.leader.x = 20;
  assert(inOwnBase(f, teams) === false, 'leader hors base');
}

section('effects (no-op par défaut)');
{
  const eff = createEffects();
  // Aucun crash sur no-op
  eff.agentColor(1, 0xff0000);
  eff.shock(0, 0, 0xffffff, 3, 0.3);
  eff.sound('test');
  // Émission + drain
  eff.emit('foo', { x: 1 });
  eff.emit('bar', { y: 2 });
  const drained = eff.drain();
  assert(drained.length === 2, 'drain 2 events');
  assert(drained[0].type === 'foo' && drained[0].data.x === 1, 'event content');
  const emptyDrain = eff.drain();
  assert(emptyDrain.length === 0, 'drain vidé après drain');
  // install
  let called = 0;
  eff.install({ agentColor: () => { called++; } });
  eff.agentColor(1, 0xff0000);
  assert(called === 1, 'install remplace le no-op');
}

section('modules chargés');
assert(typeof aiThink === 'function', 'aiThink importé');
assert(typeof paintMixAround === 'function', 'paintMixAround importé');
assert(typeof AI_TUNING.normal === 'object', 'AI_TUNING.normal');
assert(typeof stepLeaders === 'function', 'stepLeaders importé');
assert(typeof stepLeaderRepulsion === 'function', 'stepLeaderRepulsion importé');
assert(typeof stepCrowd === 'function', 'stepCrowd importé');

/* -------- Verdict -------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
