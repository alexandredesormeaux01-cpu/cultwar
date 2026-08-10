/**
 * Élection du nouvel hôte — vérification headless.
 *
 * Ce qu'on cherche à prouver n'est pas qu'un « bon » joueur est choisi, mais
 * que TOUS les survivants en choisissent le même, chacun de son côté et sans
 * se parler. Un désaccord scinderait le salon : deux hôtes, deux parties.
 *
 * Lancer :  node scripts/succession-test.mjs
 */
import { successionOrder } from '../src/net/client.js';

let failed = 0;
function check(label, cond) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`);
  if (!cond) failed++;
}

const human = (id, seatIndex, extra = {}) =>
  ({ id, kind: 'human', seatIndex, inMatch: true, ...extra });

/* -- 1. Le siège le plus bas hérite, et les bots ne sont jamais candidats. -- */
{
  const slots = [
    human('host', 0), human('carol', 3), human('bob', 1),
    { id: 'bot_1', kind: 'bot', seatIndex: 2, inMatch: true },
  ];
  const order = successionOrder(slots, 'host');
  check('l\'hôte sortant est exclu', !order.some(s => s.id === 'host'));
  check('les IA ne peuvent pas hériter', !order.some(s => s.kind === 'bot'));
  check('le plus petit seatIndex hérite', order[0].id === 'bob');
}

/* -- 2. Le cœur : même verdict quel que soit l'ordre des sièges reçus.
      Chaque client construit sa Map d'un flux différent, l'ordre d'itération
      n'est donc pas garanti d'un pair à l'autre. -- */
{
  const base = [
    human('host', 0), human('zoe', 2), human('adam', 2), human('mia', 5),
  ];
  const shuffles = [
    [0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2],
  ];
  const verdicts = shuffles.map(
    (order) => successionOrder(order.map(i => base[i]), 'host')[0].id
  );
  check(`verdict identique quel que soit l'ordre (${verdicts.join(', ')})`,
    new Set(verdicts).size === 1);
  check('seatIndex à égalité : départage stable par ID', verdicts[0] === 'adam');
}

/* -- 3. Un siège déjà tombé ne peut pas hériter : on élirait un fantôme et le
      salon resterait orphelin. -- */
{
  const slots = [human('host', 0), human('bob', 1, { gone: true }), human('carol', 2)];
  const order = successionOrder(slots, 'host');
  check('un siège déconnecté est écarté', order[0].id === 'carol');
}

/* -- 4. Qui joue encore passe devant : sa boucle de simulation tourne déjà. -- */
{
  const slots = [
    human('host', 0),
    human('bob', 1, { inMatch: false }),   // a quitté la manche
    human('carol', 4, { inMatch: true }),  // joue encore
  ];
  const order = successionOrder(slots, 'host');
  check('un joueur en manche passe devant un siège plus bas mais sorti',
    order[0].id === 'carol');
  check('celui qui a quitté reste éligible en second', order[1].id === 'bob');
}

/* -- 5. Dernier survivant, et salon vide. -- */
{
  check('seul rescapé : il hérite',
    successionOrder([human('host', 0), human('solo', 1)], 'host')[0].id === 'solo');
  check('plus personne : aucun héritier',
    successionOrder([human('host', 0)], 'host').length === 0);
}

console.log(failed ? `\n${failed} échec(s)` : '\nTout passe.');
process.exit(failed ? 1 : 0);
