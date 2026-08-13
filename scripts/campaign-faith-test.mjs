/* Vérifie le CÂBLAGE de la campagne v3 (le PAYS est l'unité) sur les vraies
   structures de sauvegarde : save.conq[iso] = couleur, save.conqPop[iso] = fidèles.

   Le simulateur d'équilibrage (campaign-balance-sim.mjs) valide le modèle sur un
   monde synthétique ; il ne touche jamais au format réel du save. Ce test-ci fait
   l'inverse : petit monde, mais les vrais objets manipulés par le jeu.

   Ce qu'on prouve :
     1. la maturation fait croître les fidèles sans dépasser le plafond ;
     2. la pression frontalière abaisse ce plafond, et le reflux fait redescendre ;
     3. le déversement CONSERVE la foi (elle se déplace, elle ne se duplique pas) ;
     4. une terre barbare voisine finit par basculer, et le gris n'attaque jamais ;
     5. la prédication érode puis retourne un pays rival ;
     6. le budget de clergé limite les conversions par tour ;
     7. la décapitation effondre l'empire, exile le berceau, et la latence tient. */

globalThis.matchMedia = () => ({ matches: false });
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { __faithTest: T } = await import('../src/progression.js');
const { FAITH, DECAP, faithTick, maybeDecapitate, ensureSeats, countryPop, countriesOf } = T;

const PLAYER = '#ff2e7e';      // couleur du joueur (CULTS[0])
const RIVAL = '#00c8ff';       // culte Sélénie
const NEUTRAL = '#8b93a7';

let fails = 0;
const check = (label, cond, detail = '') => {
  if (!cond) { fails++; console.log(`  ÉCHEC — ${label}${detail ? ` (${detail})` : ''}`); }
  else console.log(`  ok — ${label}`);
};

/* Hors du navigateur, WORLDS n'a que la carte de repli (5 pays sans voisinage
   réel). On déclare donc un petit monde d'essai bâti sur du VRAI voisinage
   (NEIGHBORS relie FRA à ESP, DEU, ITA, BEL, CHE…). */
const A = 'FRA';
const NB = ['ESP', 'DEU', 'ITA', 'BEL', 'CHE'];
const FAR = 'RUS';                       // sans frontière commune avec A
T.primeWorlds([
  { iso: A, name: 'France', pop: 67e6, lat: 0.81, lon: 0.04 },
  ...NB.map((iso, i) => ({ iso, name: iso, pop: 50e6 + i * 1e6, lat: 0.8, lon: 0.05 + i * 0.01 })),
  { iso: FAR, name: 'Russie', pop: 144e6, lat: 1.0, lon: 0.7 },
]);
const B = NB[0], C = FAR;

function makeSave(owners) {
  const conq = {}, conqPop = {};
  for (const [iso, color] of Object.entries(owners)) { conq[iso] = color; conqPop[iso] = 0; }
  return {
    playerColor: PLAYER, playerName: 'Test', religionName: 'Testisme',
    conq, conqPop, skills: {}, ai: {}, worldTurn: 0, seats: {}, decapAt: {},
    discovered: {}, seeded: true,
  };
}
const total = (s) => Object.values(s.conqPop).reduce((a, b) => a + b, 0);

/* ---- 1. Maturation : ça pousse, et ça plafonne ---- */
{
  const s = makeSave({ [A]: PLAYER });
  s.conqPop[A] = countryPop(A) * 0.12;
  const before = s.conqPop[A];
  faithTick(s);
  check('la maturation fait croître un pays tenu', s.conqPop[A] > before);

  for (let i = 0; i < 300; i++) faithTick(s);
  const pct = s.conqPop[A] / countryPop(A);
  check('la maturation ne dépasse jamais le plafond', pct <= FAITH.CAP_BASE + 1e-6,
    `pct=${pct.toFixed(3)}`);
}

/* ---- 2. Pression frontalière et reflux ---- */
{
  const calm = makeSave({ [A]: PLAYER });
  const pressed = makeSave({ [A]: PLAYER });
  // On entoure A de rivaux : son plafond doit chuter.
  for (const n of T.neighborsOf(A)) pressed.conq[n] = RIVAL;
  check('la pression frontalière abaisse le plafond',
    T.faithCap(pressed, A, PLAYER) < T.faithCap(calm, A, PLAYER),
    `${T.faithCap(pressed, A, PLAYER).toFixed(2)} < ${T.faithCap(calm, A, PLAYER).toFixed(2)}`);

  // Un pays saturé au-dessus de son nouveau plafond doit refluer.
  pressed.conqPop[A] = countryPop(A) * 0.95;
  const before = pressed.conqPop[A];
  faithTick(pressed);
  check('le reflux fait redescendre un pays encerclé', pressed.conqPop[A] < before,
    `${Math.round(before)} → ${Math.round(pressed.conqPop[A])}`);
}

/* ---- 3 & 4. Déversement : conservation, puis conversion d'une terre barbare ---- */
{
  const nb = T.neighborsOf(A)[0];
  const s = makeSave({ [A]: PLAYER, [nb]: NEUTRAL });
  s.conqPop[A] = countryPop(A) * 0.90;
  const before = total(s);
  faithTick(s);
  const maxGrowth = countryPop(A) * FAITH.GROWTH_RATE;
  check('le déversement ne duplique pas la foi', total(s) - before <= maxGrowth + 1,
    `Δ=${Math.round(total(s) - before)}`);

  let turns = 0;
  while (s.conq[nb] === NEUTRAL && turns++ < 200) faithTick(s);
  check('une terre barbare voisine finit par basculer', s.conq[nb] === PLAYER,
    `après ${turns} tours`);
  check('le pays converti reçoit bien des fidèles', s.conqPop[nb] > 0);

  // Le gris n'a aucune agence : il ne peut jamais reprendre un pays.
  const grey = makeSave({ [A]: PLAYER, [nb]: NEUTRAL });
  grey.conqPop[A] = countryPop(A) * 0.05;
  for (let i = 0; i < 50; i++) faithTick(grey);
  check('les terres barbares ne prennent jamais rien', grey.conq[A] === PLAYER);
}

/* ---- 5. Prédication : érosion puis retournement d'un pays rival ---- */
{
  const nb = T.neighborsOf(A)[0];
  const s = makeSave({ [A]: PLAYER, [nb]: RIVAL });
  s.conqPop[A] = countryPop(A) * 0.90;
  s.conqPop[nb] = countryPop(nb) * 0.50;
  const before = s.conqPop[nb];
  faithTick(s);
  check('la prédication érode les fidèles rivaux', s.conqPop[nb] < before,
    `${Math.round(before)} → ${Math.round(s.conqPop[nb])}`);

  let turns = 0;
  while (s.conq[nb] === RIVAL && turns++ < 400) faithTick(s);
  check('un pays rival finit par se convertir', s.conq[nb] === PLAYER, `après ${turns} tours`);
}

/* ---- 6. Budget de clergé ---- */
{
  const nbs = T.neighborsOf(A).slice(0, 4);
  if (nbs.length >= 3) {
    const owners = { [A]: PLAYER };
    for (const n of nbs) owners[n] = NEUTRAL;
    const s = makeSave(owners);
    // Plusieurs pays du joueur saturés, tous voisins de barbares.
    s.conqPop[A] = countryPop(A) * 0.95;
    faithTick(s);
    const converted = nbs.filter((n) => s.conq[n] === PLAYER).length;
    check('le budget de clergé limite les conversions par tour',
      converted <= FAITH.CLERGY, `${converted} converties, budget=${FAITH.CLERGY}`);
  } else {
    console.log('  (pas assez de voisins dans la carte de repli : test sauté)');
  }
}

/* ---- 7. Décapitation : effondrement, exil, latence ---- */
{
  const s = makeSave({ [A]: PLAYER, [B]: RIVAL, [C]: RIVAL });
  s.conqPop[B] = countryPop(B) * 0.8;
  s.conqPop[C] = countryPop(C) * 0.5;
  ensureSeats(s);
  s.seats[RIVAL] = B;
  s.worldTurn = 100;

  const before = countriesOf(s, RIVAL);
  s.conq[B] = PLAYER;                       // le joueur prend le berceau
  const res = maybeDecapitate(s, B, RIVAL, PLAYER);
  check('prendre le berceau déclenche la décapitation', !!res, JSON.stringify(res));
  check('l\'empire de la victime s\'effondre', countriesOf(s, RIVAL) < before,
    `${before} → ${countriesOf(s, RIVAL)}`);
  check('le berceau a été exilé ailleurs', s.seats[RIVAL] !== B,
    String(s.seats[RIVAL]));

  if (s.seats[RIVAL]) {
    const seat = s.seats[RIVAL];
    s.conq[seat] = PLAYER;
    check('la latence empêche de refarmer le même culte',
      maybeDecapitate(s, seat, RIVAL, PLAYER) === null);
    s.worldTurn += DECAP.COOLDOWN + 1;
    s.conq[seat] = RIVAL;                   // il le reprend, on le rebrise
    s.conq[seat] = PLAYER;
    check('passé la latence, la décapitation redevient possible',
      maybeDecapitate(s, seat, RIVAL, PLAYER) !== null);
  } else {
    console.log('  (culte entièrement dissous : latence non applicable)');
  }
}

console.log(fails ? `\n${fails} test(s) en échec\n` : '\nTous les tests passent\n');
process.exit(fails ? 1 : 0);
