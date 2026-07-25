import { Client } from 'colyseus.js';

const url = process.argv[2] || 'wss://cultwar.fly.dev';
console.log('probe', url);

const c = new Client(url);
const room = await c.joinOrCreate('quickplay', { name: 'Probe', leaderKey: 'monk' });
console.log('joined', room.roomId, room.sessionId);

await new Promise((r) => setTimeout(r, 2000));
const st = room.state;
console.log({
  phase: st.phase,
  tick: st.tick,
  matchDur: st.matchDur,
  leaders: st.leaders?.size,
  keys: Object.keys(st),
});
if (st.leaders) {
  st.leaders.forEach((v, k) => {
    console.log('leader', k, {
      name: v.playerName,
      x: v.x,
      z: v.z,
      key: v.leaderKey,
    });
  });
}
await room.leave(true);
