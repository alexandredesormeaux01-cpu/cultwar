/* Colyseus schemas — objets synchronisés serveur → clients.
   defineTypes (API JS) plutôt que les décorateurs TypeScript. */

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

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
defineTypes(LeaderState, {
  sessionId: 'string',
  playerName: 'string',
  leaderKey: 'string',
  cultColor: 'uint32',
  cultSym: 'string',
  x: 'float32',
  z: 'float32',
  dx: 'float32',
  dz: 'float32',
  face: 'float32',
  count: 'uint16',
  fuel: 'float32',
  boostT: 'float32',
  alive: 'boolean',
  grisAbs: 'uint16',
});

export class QuickplayState extends Schema {
  constructor() {
    super();
    this.leaders = new MapSchema();
    this.tick = 0;
    this.elapsed = 0;
    this.matchDur = 120;
    this.phase = 'lobby';
  }
}
defineTypes(QuickplayState, {
  leaders: { map: LeaderState },
  tick: 'uint32',
  elapsed: 'float32',
  matchDur: 'float32',
  phase: 'string',
});
