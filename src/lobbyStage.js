/* ============================ Scène 3D du salon ============================
   Les joueurs du salon en chair et en os, sur des socles lumineux, au lieu de
   vignettes dans des cadres.

   Deux partis pris qui expliquent la forme du code :

   1. ON RÉUTILISE LE RENDU DU JEU, MAIS SUR UN CALQUE À PART. Pas de second
      canvas ni de second WebGLRenderer — ce serait doubler la mémoire GPU pour
      cinq personnages. En revanche la scène du salon vit sur son propre calque
      (LAYER), que la caméra est seule à regarder quand le salon est ouvert.

      Sans ce calque, le salon partageait l'espace du monde : un arbre, une
      touffe d'herbe ou une tuile de l'île passait devant les personnages selon
      l'endroit où la caméra tombait. Les éloigner de la carte n'aurait fait que
      déplacer le problème ; les isoler le supprime. Le salon apporte donc aussi
      ses propres lumières — un éclairage ne touche que les calques qu'il
      partage avec l'objet.

   2. AUCUN TEXTE DANS LA SCÈNE. Les noms flottants sous les personnages ont
      été retirés : à cinq, ils se chevauchaient, masquaient les corps et
      recréaient exactement les cadres qu'on voulait supprimer. Tout ce qui
      s'écrit ou se règle vit dans le quai du bas et ne parle que du joueur
      SÉLECTIONNÉ ; on passe de l'un à l'autre à la flèche.

   Le module ne connaît ni le réseau ni l'interface : on lui donne des sièges,
   il rend des personnages. Toutes ses dépendances passent par le constructeur.
--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Mise en place : une VEDETTE devant, les autres derrière.

   Le personnage sélectionné s'avance seul au premier plan ; les quatre autres
   au plus restent en fond. Le piège évident est l'occultation — un corps au
   centre du premier plan cache exactement le milieu du second. Deux mesures
   s'en chargent, et il faut les garder ensemble :

   · le fond LAISSE LE CENTRE VIDE. Les places de fond se répartissent deux à
     gauche, deux à droite, avec un trou au milieu où se tient la vedette.
   · la vedette est PLUS BASSE dans le cadre. Elle est plus près de la caméra,
     qui regarde vers le bas : la perspective la descend naturellement, on
     accentue en la posant plus bas encore.

   Rien de tout ça n'est visible à la lecture des chiffres seuls, d'où le test
   d'occultation dans scripts/lobby-stage-test.mjs.
--------------------------------------------------------------------------- */

export const PODIUM_R = 1.45;
/** Hauteur cadrée : socle + personnage, avec un peu d'air. */
export const ROW_H = 3.4;
/** Combien de places le fond peut tenir. Au-delà, on ne montre pas tout. */
export const BACK_MAX = 4;

const FRONT_X = 0;       // la vedette est au centre — cible des regards du fond
const FRONT_Z = 4.6;     // avancée de la vedette
const FRONT_Y = -0.35;   // abaissement léger : trop bas gaspillait le haut de la zone libre
const BACK_Z = -1.6;
const FRONT_SCALE = 1.28;
const BACK_SCALE = 0.95;
/** Mise en place de repli, tant que le cadrage n'a rien mesuré. */
const DEFAULT_LAYOUT = { inner: 4.4, spread: 7.2 };

/**
 * Place d'un siège. Pure — testée hors navigateur.
 *
 * `layout` vient du cadrage et porte deux mesures, toutes deux en unités monde
 * au plan du fond :
 * · `inner`  x minimal pour être HORS de la silhouette de la vedette ;
 * · `spread` x maximal pour rester dans le champ.
 *
 * C'est ce qui permet à la caméra de ne jamais reculer. Au lieu d'éloigner
 * tout le monde pour faire tenir cinq personnages, le fond s'écarte juste
 * assez pour sortir de derrière la vedette, et se resserre s'il manque de
 * place. La vedette, elle, garde exactement la taille et la position qu'elle
 * aurait seule à l'écran.
 *
 * @param {number} rank  0 = vedette ; 1..4 = places de fond, de la plus proche
 *   du centre vers l'extérieur, en alternant gauche et droite.
 * @param {{inner:number, spread:number}} [layout]
 */
export function seatPos(rank, layout = DEFAULT_LAYOUT) {
  if (rank <= 0) return { x: 0, y: FRONT_Y, z: FRONT_Z, scale: FRONT_SCALE };
  /* Alternance : 1→gauche, 2→droite, 3→plus à gauche, 4→plus à droite. Le
     fond reste ainsi équilibré quel que soit le nombre de joueurs, au lieu de
     se remplir d'un seul côté. */
  const step = Math.ceil(rank / 2);           // 1,1,2,2
  const side = (rank % 2 === 1) ? -1 : 1;
  const inner = Math.max(2.2, layout.inner ?? DEFAULT_LAYOUT.inner);
  /* Les places extérieures ne s'éloignent que si la place existe. Quand elle
     manque, elles se collent aux intérieures : deux personnages qui se
     chevauchent un peu restent lisibles, un personnage caché derrière la
     vedette ne l'est pas — c'est l'arbitrage. */
  const outer = Math.max(inner + PODIUM_R * BACK_SCALE * 1.3,
    layout.spread ?? DEFAULT_LAYOUT.spread);
  const x = side * (step === 1 ? inner : outer);
  /* Les places extérieures reculent un peu : la rangée s'incurve vers la
     caméra, comme une photo de groupe. */
  const z = BACK_Z - (step - 1) * 0.9;
  return { x, y: 0, z, scale: BACK_SCALE };
}

/**
 * Où poser la caméra pour que la rangée tombe dans la ZONE LIBRE de l'écran —
 * la portion que le panneau du salon ne recouvre pas.
 *
 * Extraite du module et rendue PURE parce que c'est exactement ici qu'était le
 * défaut : un simple décalage latéral plaçait les personnages derrière le
 * panneau dès que sa taille changeait. Le calcul est vérifiable sans
 * navigateur (voir scripts/lobby-stage-test.mjs), et il le doit — c'est le
 * seul moyen de prouver qu'aucun personnage ne se cache sous l'interface.
 *
 * @param {object} o
 * @param {number} o.count   nombre de joueurs
 * @param {number} o.fov     champ vertical de la caméra, en degrés
 * @param {number} o.aspect  rapport du canvas
 * @param {{x,y,w,h}} o.free zone libre, en pixels
 * @param {number} o.vw      largeur du canvas
 * @param {number} o.vh      hauteur du canvas
 * @param {number} [o.drift] décalage latéral. Laissé à 0 : le cadrage est
 *   VERROUILLÉ, seule change l'identité du personnage au premier plan. Une
 *   caméra qui dérive donne l'impression que la scène bouge toute seule et
 *   empêche de comparer deux personnages à la même place.
 * @returns {{pos:{x,y,z}, target:{x,y,z}, dist:number}} relatif à l'origine
 *   de la scène.
 */
export function frameRow({ count, fov, aspect, free, vw, vh, drift = 0 }) {
  const W = Math.max(1, vw), H = Math.max(1, vh);
  const fx = free ? free.x : 0, fy = free ? free.y : 0;
  const fw = free ? Math.max(40, free.w) : W;
  const fh = free ? Math.max(40, free.h) : H;

  const tan = Math.tan((fov * Math.PI) / 180 / 2);
  /* Fractions du champ réellement visibles dans la zone libre. Tout le calcul
     passe par elles : cadrer sur le canvas entier mettrait les personnages
     derrière le panneau. */
  const fracW = Math.max(0.2, aspect) * (fw / W);
  const fracH = fh / H;

  /* --- Cadrage sur la SEULE vedette, quel que soit le nombre de joueurs ---
     C'est la règle : la vue est toujours celle qu'on aurait à un joueur.
     Reculer pour faire tenir le fond rapetissait tout le monde dès qu'une IA
     arrivait. C'est le fond qui se resserre, pas la caméra qui s'éloigne.

     Le recul se mesure DEPUIS LE PLAN DE LA VEDETTE, pas depuis l'origine :
     elle se tient FRONT_Z en avant, donc bien plus près de l'objectif qu'un
     calcul à l'origine ne le suppose. C'est ce qui la faisait déborder de
     l'écran sur les fenêtres étroites. */
  const starW = PODIUM_R * 2 * FRONT_SCALE;
  const starH = ROW_H * FRONT_SCALE;
  /* Marges d'air autour de la vedette : plus elles sont grandes, plus la
     caméra recule et plus le personnage paraît petit.

     Deux jeux, parce que les deux formats ne butent pas sur la même limite.
     En portrait c'est la LARGEUR qui contraint, et il faut de la marge
     latérale pour loger le fond de part et d'autre. En 16:9 la largeur est
     abondante et c'est la HAUTEUR qui décide : un cadrage serré y collait la
     vedette et son socle au premier plan, énormes. On desserre donc surtout
     la marge verticale sur grand écran. */
  const wide = aspect >= 1.35;
  const marginW = wide ? 2.15 : 2.4;
  const marginH = wide ? 1.55 : 1.35;
  const needW = (starW * marginW / 2) / (tan * fracW);
  const needH = (starH * marginH / 2) / (tan * fracH);
  const camToStar = Math.max(3.8, needW, needH);
  const dist = camToStar + FRONT_Z;

  /* Décalage pour amener la vedette au centre de la zone libre : d'abord en
     coordonnées normalisées, puis converti en unités monde à SON plan. */
  const cx = fx + fw / 2, cy = fy + fh / 2;
  const ndcX = (cx - W / 2) / (W / 2);
  const ndcY = -(cy - H / 2) / (H / 2);
  const halfH = camToStar * tan;
  const halfW = halfH * aspect;
  /* Déplacer la caméra fait glisser le sujet en sens inverse : pour l'amener à
     droite, on recule vers la gauche. */
  const offX = -ndcX * halfW;
  const offY = -ndcY * halfH;

  /* On vise un peu sous le milieu de la vedette : avec une caméra haute, viser
     trop haut ferait regarder par-dessus les têtes ; trop bas, on ne verrait
     que des crânes. */
  const aimY = FRONT_Y + starH * 0.42;
  /* Hauteur relative au recul. Un peu moins plongeant qu'avant : à grande
     taille à l'écran, trop de plongée écrasait les silhouettes. */
  const CAM_H = 0.42;
  const pos = {
    x: drift + offX,
    y: aimY + camToStar * CAM_H + offY,
    z: dist,
  };

  /* --- Mise en place du fond, dérivée du cadrage ---
     `inner` : la vedette est plus PRÈS de la caméra, donc plus large à l'écran
     qu'en unités monde. Pour savoir à partir d'où le fond en sort, on projette
     sa silhouette sur le plan du fond — un simple rapport de distances — et on
     ajoute le rayon d'un socle de fond. Sans ce calcul, les places intérieures
     se retrouvaient pile derrière elle.
     `spread` : jusqu'où on peut aller sans sortir du champ. */
  const camToBack = camToStar + (FRONT_Z - BACK_Z);
  const starAtBack = PODIUM_R * FRONT_SCALE * (camToBack / camToStar);
  const inner = starAtBack + PODIUM_R * BACK_SCALE + 0.35;
  const backHalfW = camToBack * tan * fracW;
  /* Marge un peu plus large que le rayon du socle : les places extérieures
     doivent rester identifiables, pas juste leur centre. */
  const spread = backHalfW - PODIUM_R * BACK_SCALE * 1.15;

  return {
    pos,
    /* Cible translatée du MÊME décalage : l'orientation reste inchangée, seul
       le cadrage bouge. Tourner la caméra déformerait la rangée. */
    target: { x: pos.x - drift * 0.6, y: aimY + offY, z: FRONT_Z },
    dist,
    layout: { inner, spread },
  };
}

/* Calque réservé au salon. 0 = décor, 1 = personnages (Leaders + foule) —
   voir LAYER_CHARS dans main.js. Le salon DOIT rester sur un troisième calque :
   sinon `camera.layers.set(LAYER)` laisse voir les villageois et esprits du
   hub, qui vivent aussi sur le 1. */
export const LAYER = 2;

export function createLobbyStage({ THREE, scene, makeLeaderGroup, disposeGroup, makePaintMaterial, origin }) {
  const root = new THREE.Group();
  root.visible = false;
  root.position.copy(origin || new THREE.Vector3(0, 0, 0));
  scene.add(root);

  /** Bascule tout un sous-arbre sur le calque du salon. */
  function toLayer(obj) {
    obj.traverse((o) => o.layers.set(LAYER));
  }

  /* Lumières propres à la scène. Celles du jeu vivent sur le calque 0 et
     n'éclaireraient donc rien ici : sans ces trois-là, les personnages
     seraient des silhouettes noires. Studio un peu plus clair qu'avant —
     le fond sombre faisait lire la scène comme un trou noir. */
  const keyLight = new THREE.DirectionalLight(0xfff4e4, 2.65);
  keyLight.position.set(4, 7, 8);
  const rimLight = new THREE.DirectionalLight(0xb0c8ff, 1.55);
  rimLight.position.set(-6, 4, -5);
  const fillLight = new THREE.HemisphereLight(0xe4eeff, 0x3a4568, 1.45);
  for (const l of [keyLight, rimLight, fillLight]) { toLayer(l); root.add(l); }

  /* Une entrée par siège, indexée par son id : c'est la clé qui permet de ne
     PAS reconstruire un personnage à chaque message du salon. Le lobby se
     redessine dès qu'un joueur change de couleur à l'autre bout du réseau ;
     recloner un modèle riggé à cette cadence provoquerait une saccade visible
     à chaque fois. */
  const seats = new Map();   // id → { grp, podium, ring, goal, rank, … }
  /** Ordre du salon, indépendant des rangs de mise en scène. */
  let order = [];
  let count = 0;
  let time = 0;
  /* Demi-largeur disponible pour le fond, mesurée par le cadrage à chaque
     image. C'est la variable qui remplace le recul de caméra : quand la
     fenêtre rétrécit, le fond se resserre au lieu que tout le monde
     s'éloigne. */
  let layout = { inner: 4.4, spread: 7.2 };
  /* Siège mis en avant. La sélection se lit SUR LE PERSONNAGE — il s'avance,
     son socle s'illumine, les autres s'effacent — plutôt que par un cadre
     autour d'une vignette. C'est tout l'intérêt d'avoir des corps en 3D. */
  let selectedId = null;

  const podiumGeo = new THREE.CylinderGeometry(PODIUM_R, PODIUM_R * 1.12, 0.28, 40);
  const ringGeo = new THREE.TorusGeometry(PODIUM_R * 1.02, 0.055, 8, 48);
  const glowGeo = new THREE.CircleGeometry(PODIUM_R * 2.1, 40);
  /* Embase sombre, sous chaque socle. Elle appartient au SIÈGE et non à la
     scène : le sol commun ne pouvait pas faire ce travail, puisque la vedette
     est descendue de FRONT_Y et le traversait — d'où une ellipse noire sous
     elle seule, et rien sous les autres. Portée par le groupe, l'embase suit
     la place et l'échelle du personnage, donc tout le monde est posé pareil. */
  const baseGeo = new THREE.CircleGeometry(PODIUM_R * 1.75, 40);
  /* Disque de peinture : diamètre = plateau du cylindre. */
  const paintGeo = new THREE.CircleGeometry(PODIUM_R * 0.98, 64);

  function disposePaint(seat) {
    if (!seat.paint) return;
    const mat = seat.paint.material;
    if (mat) {
      if (mat.map) mat.map.dispose();
      mat.dispose();
    }
    seat.grp.remove(seat.paint);
    seat.paint = null;
  }

  function setPaint(seat, hex) {
    if (!makePaintMaterial) return;
    disposePaint(seat);
    const paint = new THREE.Mesh(paintGeo, makePaintMaterial(hex));
    paint.rotation.x = -Math.PI / 2;
    /* Juste au-dessus du plateau du cylindre (centre à 0.14, demi-hauteur 0.14). */
    paint.position.y = 0.285;
    paint.renderOrder = 2;
    paint.visible = false;
    seat.grp.add(paint);
    toLayer(paint);
    seat.paint = paint;
  }

  /* ---- Décor ----
     Sans lui, les personnages se découpaient sur la vallée du menu : ciel
     clair, arbres verts, tuiles jaunes. Un moine beige sur de l'herbe beige ne
     se lit pas, et la couleur du culte se perdait dans le décor.

     Un rideau sombre derrière la scène règle le problème une fois pour toutes,
     quel que soit le biome affiché derrière. Il est peint dans un canevas
     plutôt que chargé : quelques dizaines de lignes valent mieux qu'un asset
     de plus à télécharger, et le dégradé suit exactement la mise en place —
     halo au centre, là où se tient la vedette. */
  function backdropTexture() {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const c = cv.getContext('2d');
    /* Halo plus clair : on garde le contraste autour de la vedette sans
       plonger le reste dans le noir. */
    const g = c.createRadialGradient(128, 96, 8, 128, 150, 200);
    g.addColorStop(0, '#6a7eb8');
    g.addColorStop(0.35, '#3d4f7a');
    g.addColorStop(0.7, '#243456');
    g.addColorStop(1, '#141c32');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  const backdropTex = backdropTexture();
  /* Assez large et haut pour couvrir le champ à la distance de cadrage la plus
     grande (cinq joueurs sur écran étroit). Trop juste, on verrait la vallée
     réapparaître sur les bords. */
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 46),
    new THREE.MeshBasicMaterial({ map: backdropTex, depthWrite: false, fog: false }),
  );
  backdrop.position.set(0, 9, -22);
  toLayer(backdrop);
  root.add(backdrop);

  /* Sol : un disque qui reçoit les halos des socles et ancre les personnages.
     Un peu plus clair que le rideau pour ne pas les faire flotter dans le vide. */
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(26, 48),
    new THREE.MeshBasicMaterial({ color: 0x1a243c, depthWrite: false, fog: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  /* SOUS la vedette, qui est descendue de FRONT_Y. Au ras de zéro, ce plan la
     traversait : on voyait une ellipse noire découpée autour d'elle seule,
     alors que le fond, posé à zéro, restait suspendu au-dessus. */
  floor.position.y = FRONT_Y - 0.35;
  toLayer(floor);
  root.add(floor);

  function buildSeat(slot, rank) {
    const hex = (slot.cultColor >>> 0) & 0xffffff;
    const col = new THREE.Color(hex);
    const g = new THREE.Group();

    /* Ombre portée d'abord : sous le socle, elle l'ancre au sol. Non éclairée
       et sans écriture de profondeur — c'est une tache, pas un objet. */
    const base = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({
      color: 0x05070e, transparent: true, opacity: 0.62,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0.004;
    g.add(base);

    const podium = new THREE.Mesh(podiumGeo, new THREE.MeshStandardMaterial({
      color: 0x1b2233, roughness: 0.65, metalness: 0.15,
    }));
    podium.position.y = 0.14;
    podium.receiveShadow = true;
    g.add(podium);

    /* Anneau et halo dans la couleur du culte : c'est ce qui identifie le
       joueur maintenant que son cadre a disparu. Non éclairés (Basic), pour
       qu'ils tiennent leur teinte quelle que soit la lumière du décor. */
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.95,
    }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.3;
    g.add(ring);

    const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.14,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    g.add(glow);

    const body = makeLeaderGroup({ c: hex }, slot.leaderKey || 'monk');
    body.position.y = 0.28;
    /* Anneau d'influence et bouclier sont des indicateurs de COMBAT : au salon
       ils n'informent de rien et viennent brouiller le socle, qui porte déjà
       la couleur du culte. Même geste que dans le Hub. */
    if (body.userData.ring) body.userData.ring.visible = false;
    if (body.userData.shield) body.userData.shield.visible = false;
    /* Cristal de culte : utile en partie, où il signale l'appartenance de loin.
       Au salon il flotte au-dessus de chaque tête sans rien apprendre — la
       couleur est déjà portée par le socle et son halo — et il attire l'œil
       hors du personnage, qui est justement ce qu'on vient regarder. */
    if (body.userData.crystal) body.userData.crystal.visible = false;
    g.add(body);

    const p = seatPos(rank, layout);
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(p.scale);
    /* Après l'ajout des enfants : le personnage cloné arrive avec ses propres
       meshes, il faut les basculer eux aussi ou ils resteraient invisibles. */
    toLayer(g);
    root.add(g);

    const seat = {
      grp: g, body, podium, ring, glow, base, paint: null,
      key: slot.leaderKey || 'monk',
      colorHex: hex,
      /* Place VISÉE. Le siège y glisse au lieu d'y sauter : quand la sélection
         change, toute la rangée se réorganise, et un déplacement instantané
         ferait clignoter cinq personnages d'un coup. */
      goal: p,
      rank,
      /* Déphasage du balancement : sans lui, cinq personnages respirent en
         parfaite synchronisation et l'ensemble ressemble à un mécanisme. */
      phase: rank * 1.7,
    };
    setPaint(seat, hex);
    return seat;
  }

  function tint(seat, hex) {
    const col = new THREE.Color(hex);
    seat.ring.material.color.copy(col);
    seat.glow.material.color.copy(col);
    seat.colorHex = hex;
    setPaint(seat, hex);
  }

  function dropSeat(seat) {
    root.remove(seat.grp);
    /* Le personnage est un clone : sa géométrie et ses matériaux lui
       appartiennent, il faut les libérer. Socle, anneau et halo partagent
       des géométries de module, on ne dispose que leurs matériaux. */
    if (disposeGroup) disposeGroup(seat.body);
    disposePaint(seat);
    seat.podium.material.dispose();
    seat.ring.material.dispose();
    seat.glow.material.dispose();
    seat.base.material.dispose();
  }

  return {
    /** Le salon 3D est-il à l'écran ? */
    get active() { return root.visible; },

    /**
     * @param {boolean} on
     * @param {object} [camera] à passer pour rendre la caméra au monde en
     *   sortant. Sans ça elle resterait braquée sur le calque du salon et le
     *   jeu ne rendrait plus rien du tout — panne noire, difficile à relier à
     *   sa cause.
     */
    setActive(on, camera) {
      root.visible = !!on;
      if (!on && camera) camera.layers.set(0);
    },

    /**
     * Aligne la scène sur les sièges reçus.
     *
     * Diff plutôt que reconstruction : on ne recrée un personnage que si son
     * modèle a changé. Un changement de couleur ne fait que reteinter, et un
     * simple réordonnancement ne fait que déplacer.
     */
    sync(slots) {
      order = (slots || []).map(s => s.id);
      count = order.length;
      const seen = new Set();

      /* Le sélectionné prend le rang 0 (la vedette) ; les autres se rangent
         derrière dans l'ordre du salon. Sans sélection, c'est le premier siège
         qui monte devant — la scène n'est jamais sans vedette, sinon le trou
         central du fond resterait béant. */
      const sel = selectedId && (slots || []).some(s => s.id === selectedId)
        ? selectedId : order[0];
      const ranked = [];
      for (const s of (slots || [])) if (s.id === sel) ranked.push(s);
      for (const s of (slots || [])) if (s.id !== sel) ranked.push(s);

      ranked.forEach((slot, rank) => {
        seen.add(slot.id);
        const key = slot.leaderKey || 'monk';
        const hex = (slot.cultColor >>> 0) & 0xffffff;
        let seat = seats.get(slot.id);

        if (seat && seat.key !== key) { dropSeat(seat); seats.delete(slot.id); seat = null; }
        if (!seat) {
          seat = buildSeat(slot, rank);
          seats.set(slot.id, seat);
        } else if (seat.colorHex !== hex) {
          tint(seat, hex);
        } else if (!seat.paint) {
          setPaint(seat, hex);
        }
        seat.rank = rank;
        seat.goal = seatPos(rank, layout);
        seat.slot = slot;
        /* Au-delà des places du fond, on masque : mieux vaut ne pas montrer un
           joueur que l'empiler sur un autre. Ne peut arriver que si la limite
           de sièges du salon dépasse un jour BACK_MAX + 1. */
        seat.grp.visible = rank <= BACK_MAX;
      });

      for (const [id, seat] of [...seats]) {
        if (seen.has(id)) continue;
        dropSeat(seat);
        seats.delete(id);
      }
      if (selectedId && !seats.has(selectedId)) selectedId = null;
    },

    /** Rebâtit tout : à appeler quand un modèle de personnage vient d'arriver. */
    rebuild(slots) {
      for (const [, seat] of seats) dropSeat(seat);
      seats.clear();
      this.sync(slots);
    },

    /** Met un siège en vedette. Déclenche la réorganisation au prochain sync. */
    setSelected(id, slots) {
      if (!seats.has(id)) return;
      selectedId = id;
      if (slots) this.sync(slots);
    },
    get selected() { return selectedId; },

    /** Id du siège voisin dans l'ordre du salon — la navigation gauche/droite. */
    neighbour(id, dir) {
      if (!order.length) return null;
      const at = order.indexOf(id);
      if (at < 0) return order[0];
      /* Enroulement : la rangée est un carrousel, arriver au bout doit
         ramener au début plutôt que bloquer. */
      return order[(at + dir + order.length) % order.length];
    },

    update(dt) {
      if (!root.visible) return;
      time += dt;
      const k = Math.min(1, dt * 6);
      for (const [id, seat] of seats) {
        const on = id === selectedId;
        const g = seat.goal;

        /* Glissement amorti vers la place visée. Quand la sélection change,
           TOUTE la rangée se réorganise : un déplacement instantané ferait
           clignoter cinq personnages d'un coup. */
        seat.grp.position.x += (g.x - seat.grp.position.x) * k;
        seat.grp.position.y += (g.y - seat.grp.position.y) * k;
        seat.grp.position.z += (g.z - seat.grp.position.z) * k;
        const s = seat.grp.scale.x + (g.scale - seat.grp.scale.x) * k;
        seat.grp.scale.setScalar(s);

        /* Orientation. La vedette regarde la caméra ; le fond se TOURNE VERS
           ELLE. C'est ce qui fait une assemblée plutôt qu'un alignement de
           figurines : les regards convergent sur celui qu'on est en train de
           consulter, et le changement de sélection se lit même du coin de
           l'œil, tout le monde pivotant d'un cran.

           L'angle se mesure depuis la place VISÉE et non la place courante :
           pendant le glissement, les deux diffèrent, et suivre la position
           courante ferait osciller le regard jusqu'à l'arrivée. */
        const faceStar = on ? 0 : Math.atan2(FRONT_X - g.x, FRONT_Z - g.z);
        /* Léger balancement autour de cette orientation. Les modèles n'ont pas
           de clip d'attente — seulement marche, course et sprint — jouer une
           marche sur place donnerait des pieds qui glissent ; ce mouvement du
           buste suffit à ce que la rangée paraisse vivante. */
        const sway = on ? 0 : Math.sin(time * 0.25 + seat.phase) * 0.12;
        /* Écart le plus court : sans ce repli, un personnage passant de -170°
           à +170° ferait un tour complet sur lui-même. */
        let d = (faceStar + sway) - seat.grp.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        seat.grp.rotation.y += d * k;
        seat.body.position.y = 0.28 + Math.sin(time * 1.4 + seat.phase) * 0.035;

        /* Socle : celui de la vedette bat fort, ceux du fond s'éteignent à
           demi. C'est ce qui dit qui est sélectionné, maintenant que les
           étiquettes ont disparu. */
        const pulse = 0.72 + Math.sin(time * 1.9 + seat.phase) * 0.22;
        const tgtRing = pulse * (on ? 1 : 0.4);
        const tgtGlow = on ? 0.34 : 0.08;
        seat.ring.material.opacity += (tgtRing - seat.ring.material.opacity) * k;
        seat.glow.material.opacity += (tgtGlow - seat.glow.material.opacity) * k;

        /* Peinture : uniquement sous la vedette — aperçu de la flaque de culte
           telle qu'elle sera en partie. Les places de fond restent sobres. */
        if (seat.paint) {
          seat.paint.visible = on;
          const tgtPaint = on ? 0.95 : 0;
          seat.paint.material.opacity += (tgtPaint - seat.paint.material.opacity) * k;
        }

      }
    },

    /**
     * Cadre la rangée dans la ZONE LIBRE de l'écran — la portion que le
     * panneau du salon ne recouvre pas.
     *
     * Un simple décalage latéral ne suffisait pas : selon la taille de la
     * fenêtre, le panneau mange tantôt la moitié gauche, tantôt les deux tiers
     * du bas, et les personnages finissaient derrière lui. On calcule donc le
     * recul pour que la rangée tienne dans cette zone, puis on translate la
     * caméra — sans la tourner — pour que son centre y tombe.
     *
     * @param {{x:number,y:number,w:number,h:number}} free  zone libre, en
     *   pixels CSS. Omise = tout l'écran.
     * @param {number} vw largeur du canvas
     * @param {number} vh hauteur du canvas
     */
    applyCamera(camera, free, vw, vh) {
      const r = frameRow({
        count, fov: camera.fov, aspect: camera.aspect,
        free, vw, vh,   // drift laissé à 0 : cadrage verrouillé
      });
      /* La largeur disponible dépend du cadrage, qui dépend de la fenêtre : on
         la relit ici et on remet les places à jour. `update` les rejoint en
         glissant, donc un redimensionnement replace le fond sans à-coup. */
      if (Math.abs(r.layout.inner - layout.inner) > 0.01
          || Math.abs(r.layout.spread - layout.spread) > 0.01) {
        layout = r.layout;
        for (const [, seat] of seats) seat.goal = seatPos(seat.rank, layout);
      }
      /* La caméra ne regarde QUE le calque du salon : c'est ce qui garantit
         qu'aucun arbre ni relief de la carte ne passe devant les personnages. */
      camera.layers.set(LAYER);
      camera.position.set(
        root.position.x + r.pos.x,
        root.position.y + r.pos.y,
        root.position.z + r.pos.z,
      );
      camera.lookAt(
        root.position.x + r.target.x,
        root.position.y + r.target.y,
        root.position.z + r.target.z,
      );
    },

    dispose() {
      for (const [, seat] of seats) dropSeat(seat);
      seats.clear();
      scene.remove(root);
      podiumGeo.dispose(); ringGeo.dispose(); glowGeo.dispose(); paintGeo.dispose();
      backdrop.geometry.dispose(); backdrop.material.dispose(); backdropTex.dispose();
      floor.geometry.dispose(); floor.material.dispose();
    },
  };
}
