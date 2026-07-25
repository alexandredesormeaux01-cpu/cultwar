/* Colyseus schemas — objets synchronisés serveur → clients. */

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

export class LobbySlot extends Schema {
  constructor() {
    super();
    this.id = '';
    this.kind = 'human';       // human | bot
    this.sessionId = '';
    this.name = '';
    this.leaderKey = 'monk';
    this.difficulty = 'normal'; // easy | normal | hard (bots)
    this.cultColor = 0xffffff;
    this.cultSym = '❤';
    this.isHost = false;
  }
}
defineTypes(LobbySlot, {
  id: 'string',
  kind: 'string',
  sessionId: 'string',
  name: 'string',
  leaderKey: 'string',
  difficulty: 'string',
  cultColor: 'uint32',
  cultSym: 'string',
  isHost: 'boolean',
});

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
    this.isBot = false;
    this.difficulty = 'normal';
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
  isBot: 'boolean',
  difficulty: 'string',
});

export class QuickplayState extends Schema {
  constructor() {
    super();
    this.slots = new MapSchema();
    this.leaders = new MapSchema();
    this.hostSessionId = '';
    this.code = '';
    this.tick = 0;
    this.elapsed = 0;
    this.matchDur = 120;
    this.phase = 'lobby';
  }
}
defineTypes(QuickplayState, {
  slots: { map: LobbySlot },
  leaders: { map: LeaderState },
  hostSessionId: 'string',
  code: 'string',
  tick: 'uint32',
  elapsed: 'float32',
  matchDur: 'float32',
  phase: 'string',
});
