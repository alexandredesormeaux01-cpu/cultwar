/* ============================== Mini-map ============================== */
const mapCv = $('map'), mctx = mapCv.getContext('2d');
const GRAY_CSS = 'rgba(205,210,220,.5)';
let miniGrad = null, miniGradW = 0;
function drawMinimap() {
  const W = mapCv.width, c = W / 2, k = W / 150, s = (c - 6 * k) / MAP_R;
  mctx.clearRect(0, 0, W, W);

  // --- Disque de fond façon radar (clip circulaire) ---
  mctx.save();
  mctx.beginPath(); mctx.arc(c, c, c - 2 * k, 0, 7); mctx.clip();

  if (!miniGrad || miniGradW !== W) {
    const g = mctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(18,30,52,.94)');
    g.addColorStop(0.65, 'rgba(9,16,32,.94)');
    g.addColorStop(1, 'rgba(3,7,16,.96)');
    miniGrad = g; miniGradW = W;
  }
  mctx.fillStyle = miniGrad; mctx.fillRect(0, 0, W, W);

  /* --- Silhouette de l'île : chaque tuile en hexagone plein. C'est la seule
         lecture fiable des brèches, donc elle passe avant tout le reste. --- */
  if (island) {
    const hr = HEX_R * s;
    mctx.strokeStyle = 'rgba(120,180,255,.16)';
    mctx.lineWidth = 0.8 * k;
    for (const t of island.tiles) {
      const tx = c + t.x * s, tz = c + t.z * s;
      mctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = tx + Math.cos(a) * hr, pz = tz + Math.sin(a) * hr;
        if (i === 0) mctx.moveTo(px, pz); else mctx.lineTo(px, pz);
      }
      mctx.closePath();
      // les sanctuaires se repèrent d'un coup d'œil : c'est un objectif de carte
      mctx.fillStyle = t.role === 'sanctuary' ? 'rgba(255,208,120,.22)' : 'rgba(96,150,215,.16)';
      mctx.fill();
      mctx.stroke();
    }
  }

  // balayage radar (léger, tournant)
  const sweep = (elapsed * 0.8) % (Math.PI * 2);
  const sg = mctx.createRadialGradient(c, c, 0, c, c, c);
  sg.addColorStop(0, 'rgba(130,200,255,.14)');
  sg.addColorStop(1, 'rgba(130,200,255,0)');
  mctx.fillStyle = sg;
  mctx.beginPath(); mctx.moveTo(c, c); mctx.arc(c, c, c, sweep, sweep + 0.55); mctx.closePath(); mctx.fill();

  // --- Habitations : losanges dorés ---
  for (const h of houses) {
    if (!h.alive) continue;
    const r = 2.4 * k;
    mctx.save();
    mctx.translate(c + h.x * s, c + h.z * s); mctx.rotate(Math.PI / 4);
    mctx.fillStyle = 'rgba(255,224,120,.95)';
    mctx.fillRect(-r, -r, r * 2, r * 2);
    mctx.restore();
  }

  // --- Sanctuaires : pastilles à la couleur du propriétaire ---
  for (const sh of shrines) {
    const x = c + sh.x * s, z = c + sh.z * s;
    mctx.beginPath(); mctx.arc(x, z, 3.4 * k, 0, 7);
    mctx.fillStyle = sh.owner >= 0 ? factions[sh.owner].css : 'rgba(230,236,248,.85)';
    mctx.fill();
    mctx.lineWidth = 1.2 * k; mctx.strokeStyle = 'rgba(255,255,255,.8)'; mctx.stroke();
  }

  // --- Bases fortifiées : anneau + porte + relique centrale ---
  if (teams.length) {
    for (const t of teams) {
      const bx = c + t.baseX * s, bz = c + t.baseZ * s;
      const rr = t.wallR * s;
      mctx.beginPath();
      mctx.arc(bx, bz, rr, t.gateAng + t.gateHalf, t.gateAng - t.gateHalf + Math.PI * 2);
      mctx.strokeStyle = t.css;
      mctx.lineWidth = 2.2 * k;
      mctx.globalAlpha = 0.85;
      mctx.stroke();
      mctx.globalAlpha = 1;
      // autel de dépôt au centre
      mctx.fillStyle = '#ffe259';
      mctx.beginPath(); mctx.arc(bx, bz, 2.2 * k, 0, 7); mctx.fill();
    }
  }

  // --- Sceptiques : la ressource à récolter, tous gris ---
  const dot = 1.7 * k;
  mctx.fillStyle = GRAY_CSS;
  mctx.globalAlpha = 0.65;
  for (const a of agents) {
    if (a.dead) continue;
    mctx.fillRect(c + a.x * s - dot / 2, c + a.z * s - dot / 2, dot, dot);
  }
  mctx.globalAlpha = 1;

  // --- Leaders : pastilles lumineuses ---
  for (const f of factions) {
    if (!f.alive) continue;
    const x = c + f.leader.x * s, z = c + f.leader.z * s;
    const me = f.i === 0;
    mctx.beginPath(); mctx.arc(x, z, (me ? 5.5 : 4) * k, 0, 7);
    mctx.fillStyle = f.css;
    mctx.shadowColor = f.css; mctx.shadowBlur = (me ? 9 : 5) * k;
    mctx.fill();
    mctx.shadowBlur = 0;
    mctx.lineWidth = 1.6 * k; mctx.strokeStyle = '#fff'; mctx.stroke();
  }
  // anneau pulsant autour de notre Leader
  const meF = factions[0];
  if (meF && meF.alive) {
    const x = c + meF.leader.x * s, z = c + meF.leader.z * s;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4);
    mctx.beginPath(); mctx.arc(x, z, (7 + pulse * 3.5) * k, 0, 7);
    mctx.strokeStyle = `rgba(255,255,255,${0.45 - pulse * 0.32})`;
    mctx.lineWidth = 1.4 * k; mctx.stroke();
  }
  mctx.restore();

  // --- Bordures extérieures (double anneau) ---
  mctx.beginPath(); mctx.arc(c, c, c - 4.5 * k, 0, 7);
  mctx.lineWidth = 1 * k; mctx.strokeStyle = 'rgba(130,190,255,.35)'; mctx.stroke();
  mctx.beginPath(); mctx.arc(c, c, c - 2 * k, 0, 7);
  mctx.lineWidth = 2.5 * k; mctx.strokeStyle = 'rgba(255,255,255,.55)'; mctx.stroke();
}