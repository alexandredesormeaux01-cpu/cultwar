/* ============================== Mini-map ============================== */
const mapCv = $('map'), mctx = mapCv.getContext('2d');
const GRAY_CSS = 'rgba(205,210,220,.55)';
function drawMinimap() {
  const W = mapCv.width, c = W / 2, s = (c - 7) / MAP_R;
  mctx.clearRect(0, 0, W, W);
  mctx.beginPath(); mctx.arc(c, c, c - 2, 0, 7);
  mctx.fillStyle = 'rgba(8, 16, 30, .6)'; mctx.fill();
  mctx.lineWidth = 2.5; mctx.strokeStyle = 'rgba(255,255,255,.4)'; mctx.stroke();
  // habitations : petits carrés qui aident à repérer la prochaine cible
  mctx.fillStyle = 'rgba(255,235,180,.85)';
  for (const h of houses) {
    if (!h.alive) continue;
    mctx.fillRect(c + h.x * s - 2, c + h.z * s - 2, 4, 4);
  }
  for (const a of agents) {
    mctx.fillStyle = a.f >= 0 ? factions[a.f].css : GRAY_CSS;
    mctx.fillRect(c + a.x * s - 1, c + a.z * s - 1, 2, 2);
  }
  for (const f of factions) {
    if (!f.alive) continue;
    mctx.beginPath();
    mctx.arc(c + f.leader.x * s, c + f.leader.z * s, f.i === 0 ? 5 : 4, 0, 7);
    mctx.fillStyle = f.css; mctx.fill();
    mctx.lineWidth = 1.6; mctx.strokeStyle = '#fff'; mctx.stroke();
  }
}