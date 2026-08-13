/* La règle de la mort (§10.5, règle 2) est du hasard, et le hasard ne se
   relit pas : un tirage qui retomberait toujours sur le même type, ou qui
   pencherait d'un côté, ne se verrait qu'après des dizaines de parties — et
   passerait pour de la malchance. On le mesure donc ici.

   Les invariants qui comptent, et ce qu'ils coûtent s'ils cassent :

   · UNE âme tombe, jamais zéro quand on porte quelque chose. Tirer parmi les
     quatre types au lieu de ceux réellement possédés donnerait un porteur qui
     meurt sans rien lâcher — on aurait tué pour rien.
   · celle qui tombe n'est PAS dans les dispersées. Sinon elle éclate et
     atterrit au sol en même temps : le butin serait dupliqué.
   · l'inventaire finit VIDE. Une âme oubliée dedans survivrait à la mort et se
     retrouverait portée au réapparaître.
   · le tirage est ÉQUITABLE. C'est tout l'intérêt de la règle : aucune façon
     de se couvrir, donc aucun type ne doit être plus sûr qu'un autre. */

globalThis.matchMedia = () => ({ matches: false });

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`); return; }
  console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  failures++;
}

const { addSoul, selectSlot, resetSouls, loseAllOnDeath, heldCount, inventory } =
  await import('../src/souls.js');
const { SOULS } = await import('../src/pillars.js');

/* --- La mort : une tombe, le reste éclate ------------------------------- */
console.log('mort — une âme tombe, les autres se dispersent');
{
  resetSouls();
  const nothing = loseAllOnDeath();
  check('sans rien porter, rien ne tombe',
        nothing.drop === -1 && nothing.scattered.length === 0);

  resetSouls();
  addSoul(1);
  const one = loseAllOnDeath();
  check('une seule âme portée : c\'est elle qui tombe', one.drop === 1);
  check('et rien n\'est dispersé', one.scattered.length === 0);

  resetSouls();
  for (let i = 0; i < SOULS.length; i++) addSoul(i);
  const all = loseAllOnDeath();
  check('quatre portées : une tombe', all.drop >= 0);
  check('les trois autres sont dispersées', all.scattered.length === SOULS.length - 1,
        `${all.scattered.length}`);
  check('celle qui tombe n\'est pas aussi dispersée',
        !all.scattered.includes(all.drop));
  check('l\'inventaire finit vide', heldCount() === 0);
  check('aucun emplacement ne reste marqué', inventory.held.every((h) => !h));
}

/* --- Le tirage est équitable -------------------------------------------- */
console.log('\nmort — le tirage ne favorise aucun type');
{
  const N = 20000;
  const counts = SOULS.map(() => 0);
  for (let k = 0; k < N; k++) {
    resetSouls();
    for (let i = 0; i < SOULS.length; i++) addSoul(i);
    /* La sélection ne doit plus rien protéger : on la fixe sur un type et on
       vérifie qu'il tombe aussi souvent que les autres. C'est exactement ce
       que l'ancienne règle garantissait, et qu'on a délibérément retiré. */
    selectSlot(0);
    counts[loseAllOnDeath().drop]++;
  }
  const exp = N / SOULS.length;
  const worst = Math.max(...counts.map((c) => Math.abs(c - exp) / exp));
  check('les quatre types tombent aussi souvent', worst < 0.06,
        `écart max ${(worst * 100).toFixed(1)} % — ${counts.join(' / ')}`);
  check('l\'âme sélectionnée n\'est plus protégée',
        Math.abs(counts[0] - exp) / exp < 0.06,
        `sélectionnée tombée ${counts[0]} fois pour ${exp} attendues`);
}

/* --- Un porteur partiel -------------------------------------------------- */
console.log('\nmort — tirage parmi ce qu\'on porte vraiment');
{
  /* Le piège : tirer parmi les quatre types puis écarter ce qu'on ne porte
     pas. Deux âmes sur quatre, et la moitié des morts ne lâcherait rien. */
  let empty = 0;
  const seen = new Set();
  for (let k = 0; k < 4000; k++) {
    resetSouls();
    addSoul(0); addSoul(3);
    const r = loseAllOnDeath();
    if (r.drop < 0) empty++;
    seen.add(r.drop);
  }
  check('un porteur lâche toujours une âme', empty === 0, `${empty} mort(s) à vide`);
  check('et jamais une âme qu\'il ne portait pas',
        [...seen].every((i) => i === 0 || i === 3), `vus : ${[...seen].join(',')}`);
  check('les deux types portés tombent l\'un et l\'autre', seen.size === 2);
}

console.log(failures ? `\n${failures} échec(s)` : '\nTout est vert.');
process.exit(failures ? 1 : 0);
