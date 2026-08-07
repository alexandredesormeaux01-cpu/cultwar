/* Cartes hasard — intégrité du deck et du tirage.

   Le piège de ce système : une carte n'est qu'une fonction qui appelle une
   méthode de `ctx`. Une faute de frappe dans ce nom ne casse RIEN au chargement,
   ne casse rien au build, et ne se voit qu'au moment où un joueur ramasse cette
   carte-là — soit une partie sur cinq, en moyenne. On vérifie donc ici que
   chaque méthode appelée par une carte existe vraiment dans main.js. */
import { readFileSync } from 'node:fs';
import {
  CARD_DECK, CARD_BY_ID, CARD_BUDGET, CARD_FIRST_T, CARD_LAST_T,
  pickCard, buildCardSchedule, applyCard, bannerTone,
} from '../src/sim/cards.js';
import { MATCH_DUR } from '../src/sim/constants.js';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  ÉCHEC  ' + label); }
};

console.log('\n== intégrité du deck ==');
{
  const ids = CARD_DECK.map((c) => c.id);
  ok('au moins 20 cartes', CARD_DECK.length >= 20);
  ok('aucun id en double', new Set(ids).size === ids.length);
  ok('index cohérent avec le deck', Object.keys(CARD_BY_ID).length === CARD_DECK.length);

  const tones = new Set(['good', 'bad', 'chaos']);
  const scopes = new Set(['self', 'all']);
  ok('tous les champs sont remplis', CARD_DECK.every((c) =>
    c.id && c.icon && c.title && c.blurb && typeof c.apply === 'function'));
  ok('tons valides', CARD_DECK.every((c) => tones.has(c.tone)));
  ok('portées valides', CARD_DECK.every((c) => scopes.has(c.scope)));
  ok('poids strictement positifs', CARD_DECK.every((c) => c.weight > 0));

  /* `major` allonge la pause (6 s au lieu de 5) et appuie la secousse. Il n'a de
     sens que sur une carte collective, puisque seules celles-là mettent le jeu
     en pause : une carte individuelle marquée `major` promettrait une emphase
     que le bandeau ne peut pas tenir. */
  ok('aucune carte individuelle n\'est majeure',
    CARD_DECK.every((c) => !c.major || c.scope === 'all'));

  /* Le texte doit se lire vite : 5 s de pause pour un effet collectif, moins de
     3 s de bandeau pour un effet individuel. Un titre à rallonge ou un blurb de
     trois lignes ne serait pas lu — et l'intérêt de l'annonce disparaîtrait. */
  const longTitle = CARD_DECK.filter((c) => c.title.length > 24);
  const longBlurb = CARD_DECK.filter((c) => c.blurb.length > 72);
  for (const c of [...longTitle, ...longBlurb]) console.log(`    trop long : ${c.id}`);
  ok('titres lisibles d\'un coup d\'œil (≤ 24 car.)', longTitle.length === 0);
  ok('explications lisibles en une ligne (≤ 72 car.)', longBlurb.length === 0);
}

console.log('\n== équilibre du deck ==');
{
  const by = (k, v) => CARD_DECK.filter((c) => c[k] === v).length;
  const self = by('scope', 'self'), all = by('scope', 'all');
  const good = by('tone', 'good'), bad = by('tone', 'bad'), chaos = by('tone', 'chaos');
  console.log(`  individuel ${self} | collectif ${all}`);
  console.log(`  bon ${good} | mauvais ${bad} | chaos ${chaos}`);

  ok('les deux portées sont fournies', self >= 8 && all >= 8);
  /* Le pari doit être réel : si le deck penchait franchement du bon côté,
     foncer sur chaque carte serait toujours le bon choix et il n'y aurait plus
     de décision à prendre. */
  const risky = bad + chaos;
  ok('au moins autant de risque que de récompense', risky >= good);
  ok('le mauvais pur reste minoritaire', bad < CARD_DECK.length / 2);
}

console.log('\n== toutes les cartes appellent des effets qui existent ==');
{
  /* Méthodes réellement définies côté main.js. On lit les deux littéraux
     d'objet — cardCtx étend eventCtx, les deux sont donc valides. */
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const defined = new Set();
  for (const name of ['eventCtx', 'cardCtx']) {
    const start = src.indexOf(`const ${name} = {`);
    if (start < 0) continue;
    /* Fin du littéral : la première ligne qui referme en colonne 0. */
    const end = src.indexOf('\n};', start);
    const body = src.slice(start, end < 0 ? src.length : end);
    for (const m of body.matchAll(/^\s{2}(\w+)\s*\(/gm)) defined.add(m[1]);
  }
  ok('les contextes d\'effets ont été trouvés dans main.js', defined.size > 15);

  /* Proxy : toute propriété lue est enregistrée et rendue appelable. Les cartes
     s'exécutent donc pour de vrai, sans qu'aucun effet ne se produise. */
  const missing = [];
  for (const c of CARD_DECK) {
    const called = [];
    const ctx = new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        called.push(prop);
        return () => {};
      },
      has: () => true,
    });
    applyCard(c, ctx, { i: 1, cult: { name: 'Test' }, leader: { x: 0, z: 0 } });
    if (!called.length) missing.push(`${c.id} → n'appelle aucun effet`);
    for (const name of called) {
      if (!defined.has(name)) missing.push(`${c.id} → ctx.${name}() n'existe pas`);
    }
  }
  for (const m of missing) console.log('    ' + m);
  ok('aucun effet manquant', missing.length === 0);
}

console.log('\n== couleur du bandeau ==');
{
  const tones = new Set(['good', 'bad', 'chaos']);
  ok('un ton valide pour toute carte, des deux points de vue',
    CARD_DECK.every((c) => tones.has(bannerTone(c, true)) && tones.has(bannerTone(c, false))));

  /* Celui qui ramasse voit toujours la carte telle qu'elle est. */
  ok('le ramasseur voit le ton réel',
    CARD_DECK.every((c) => bannerTone(c, true) === c.tone));

  /* Un malus individuel encaissé par un rival est une bonne nouvelle. */
  const selfBad = CARD_DECK.find((c) => c.scope === 'self' && c.tone === 'bad');
  const selfGood = CARD_DECK.find((c) => c.scope === 'self' && c.tone === 'good');
  ok('le malus d\'un rival s\'affiche en vert', bannerTone(selfBad, false) === 'good');
  ok('le bonus d\'un rival s\'affiche en rouge', bannerTone(selfGood, false) === 'bad');

  /* Un effet collectif frappe le joueur aussi : rien à inverser. */
  ok('les cartes collectives gardent leur ton pour tout le monde',
    CARD_DECK.filter((c) => c.scope === 'all')
      .every((c) => bannerTone(c, false) === c.tone && bannerTone(c, true) === c.tone));

  ok('le chaos reste du chaos des deux côtés',
    CARD_DECK.filter((c) => c.tone === 'chaos')
      .every((c) => bannerTone(c, false) === 'chaos'));
}

console.log('\n== tirage ==');
{
  const seen = new Map();
  for (let i = 0; i < 40000; i++) {
    const c = pickCard();
    ok0(c);
    seen.set(c.id, (seen.get(c.id) || 0) + 1);
  }
  function ok0(c) { if (!c) { fail++; console.log('  ÉCHEC  tirage nul'); } }
  ok('toutes les cartes sortent au moins une fois', seen.size === CARD_DECK.length);

  /* Pur hasard demandé : à poids égal, aucune carte ne doit dominer. On borne
     largement — c'est un garde-fou contre une pondération cassée, pas un test
     de qualité du générateur. */
  const equal = CARD_DECK.filter((c) => c.weight === 1).map((c) => seen.get(c.id));
  const lo = Math.min(...equal), hi = Math.max(...equal);
  console.log(`  cartes à poids 1 : ${lo} → ${hi} sorties sur 40 000`);
  ok('pas de carte privilégiée', hi / lo < 1.35);

  /* Dépondération des répétitions : la dernière sortie doit devenir rare. */
  const target = CARD_DECK[0].id;
  let repeats = 0;
  for (let i = 0; i < 20000; i++) {
    if (pickCard(Math.random, [target]).id === target) repeats++;
  }
  const base = 20000 / CARD_DECK.length;
  console.log(`  carte fraîchement sortie : ${repeats} retirages (base ~${Math.round(base)})`);
  ok('une carte qui vient de sortir est nettement plus rare', repeats < base * 0.6);
}

console.log('\n== rythme ==');
{
  ok('budget de 5 à 6 cartes par partie', CARD_BUDGET >= 5 && CARD_BUDGET <= 6);
  ok('la première laisse le temps de s\'installer', CARD_FIRST_T >= 20);
  ok('la dernière laisse le temps d\'agir', MATCH_DUR - CARD_LAST_T >= 45);

  let lo = Infinity, hi = -Infinity, minGap = Infinity;
  for (let i = 0; i < 5000; i++) {
    const s = buildCardSchedule();
    if (s.length !== CARD_BUDGET) { fail++; console.log('  ÉCHEC  calendrier incomplet'); break; }
    lo = Math.min(lo, s[0]);
    hi = Math.max(hi, s[s.length - 1]);
    for (let k = 1; k < s.length; k++) minGap = Math.min(minGap, s[k] - s[k - 1]);
  }
  console.log(`  premier créneau ${lo.toFixed(1)} s | dernier ${hi.toFixed(1)} s | écart mini ${minGap.toFixed(1)} s`);
  ok('tous les créneaux tiennent dans la partie', hi < MATCH_DUR - 40);
  /* La demande était explicite : surtout pas une carte toutes les dix secondes. */
  ok('jamais moins de 25 s entre deux créneaux', minGap >= 25);

  /* ---- Simulation d'une partie entière ----
     C'est le test qui manquait la première fois : compter les créneaux sans
     tenir compte du TRAJET jusqu'à la carte donnait un rythme théorique que la
     partie réelle n'atteignait jamais. On rejoue donc la boucle de main.js,
     avec un délai de ramassage, y compris très pessimiste. */
  function playMatch(pickDelay) {
    const sched = buildCardSchedule();
    let next = 0, card = null, taken = 0, lastTake = 0;
    for (let t = 0; t < MATCH_DUR; t += 0.1) {
      if (card !== null) {
        if (t - card >= pickDelay) { card = null; taken++; lastTake = t; }
        continue;                                  // jamais deux cartes à la fois
      }
      if (next < sched.length && t >= sched[next]) { card = t; next++; }
    }
    return { taken, lastTake };
  }

  for (const [label, delay, min] of [
    ['ramassage immédiat', 0, 6],
    ['trajet 12 s (typique)', 12, 6],
    ['trajet 25 s (carte loin, disputée)', 25, 5],
    ['trajet 40 s (personne ne se presse)', 40, 4],
  ]) {
    const r = playMatch(delay);
    console.log(`  ${label.padEnd(36)} ${r.taken} cartes, dernière prise à ${r.lastTake.toFixed(0)} s`);
    ok(`${label} : au moins ${min} cartes ramassées`, r.taken >= min);
    ok(`${label} : la dernière tombe avant la fin`, r.lastTake > 0 && r.lastTake < MATCH_DUR - 10);
  }
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
