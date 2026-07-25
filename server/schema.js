/* Colyseus schemas — les objets synchronisés serveur → clients.
   Chaque changement de champ est envoyé en delta binaire. Garder au strict
   minimum ce qui est vraiment nécessaire côté client pour rendre. */

import { Schema, MapSchema, type } from '@colyseus/schema';

export class LeaderState extends Schema {
  constructor() {
    super();
    this.sessionId = '';
    this.playerName = '';
    this.leaderKey = 'monk';
    this.cultColor = 0xffffff;
    this.cultSym = '❤';
    this.x = 0;
    this.z = 0;
    this.dx = 0;
    this.dz = 0;
    this.face = 0;
    this.count = 0;
    this.fuel = 100;
    this.boostT = 0;
    this.alive = true;
    this.grisAbs = 0;
  }
}
type('string')(LeaderState.prototype, 'sessionId');
type('string')(LeaderState.prototype, 'playerName');
type('string')(LeaderState.prototype, 'leaderKey');
type('uint32')(LeaderState.prototype, 'cultColor');
type('string')(LeaderState.prototype, 'cultSym');
type('float32')(LeaderState.prototype, 'x');
type('float32')(LeaderState.prototype, 'z');
type('float32')(LeaderState.prototype, 'dx');
type('float32')(LeaderState.prototype, 'dz');
type('float32')(LeaderState.prototype, 'face');
type('uint16')(LeaderState.prototype, 'count');
type('float32')(LeaderState.prototype, 'fuel');
type('float32')(LeaderState.prototype, 'boostT');
type('boolean')(LeaderState.prototype, 'alive');
type('uint16')(LeaderState.prototype, 'grisAbs');

export class QuickplayState extends Schema {
  constructor() {
    super();
    this.leaders = new MapSchema();   // sessionId → LeaderState
    this.tick = 0;
    this.elapsed = 0;
    this.matchDur = 120;
    this.phase = 'lobby';   // lobby | play | over
  }
}
type({ map: LeaderState })(QuickplayState.prototype, 'leaders');
type('uint32')(QuickplayState.prototype, 'tick');
type('float32')(QuickplayState.prototype, 'elapsed');
type('float32')(QuickplayState.prototype, 'matchDur');
type('string')(QuickplayState.prototype, 'phase');
