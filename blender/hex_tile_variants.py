"""
============================================================================
Cult.io — Variantes sculptées de la dalle hexagonale
----------------------------------------------------------------------------
hex_tile_base.py reproduit la dalle du moteur à l'identique : c'est le
gabarit, il ne bouge pas. Ce script-ci s'en sert de squelette et y ajoute le
seul modelé que le moteur peut réellement accepter.

CE QUI PEUT ÊTRE SCULPTÉ, ET POURQUOI PAS LE RESTE

  Le dessus reste PLAT. Ce n'est pas une facilité : le décor ne suit pas la
  géométrie de la dalle, il suit le champ de bruit de groundNoise.js
  (applyGroundFollow décale chaque prop de gLift(x,z)), et les unités se
  posent sur groundHeightAt() qui renvoie la hauteur logique de la tuile,
  donc un plan. Une bosse modelée dans le maillage ne serait connue ni de
  l'un ni de l'autre : les cailloux s'y enfonceraient et flotteraient dans
  les creux. Le modelé du dessus continue donc de venir du shader.

  Le FLANC est libre. Rien n'y est posé, et depuis que l'allongement de la
  jupe est passé dans le vertex shader (SKIRT_STRETCH_GLSL, hexmap.js) le
  maillage n'est plus étiré par l'échelle d'instance au-dessus de y = 0.
  Sous y = 0 il l'est toujours — c'est le but — donc le relief de flanc est
  dessiné en STRIES VERTICALES : un motif vertical reste lisible quand on
  l'allonge, un redan horizontal se transforme en bandeau mou.

  Le REBORD est libre dans le plan, à condition de ne mordre que vers
  l'intérieur : le contour à R = 4.1 est la collision et l'emboîtement des
  voisines. On l'entame donc par un BISEAU — le dessus s'arrête un peu avant
  R, et une petite facette redescend jusqu'au contour exact, à z = -CHAMFER_D.
  Deux tuiles voisines forment ainsi une rainure en V dont le fond est plein :
  la couture de l'hexagone se dessine sans jamais ouvrir sur le vide.

INVARIANTS REPRIS DU GABARIT (à ne pas casser)
  1. Le contour passe par les 6 coins à R = 4.1 exact, à z = -CHAMFER_D et
     plus bas. Le déplacement du flanc ne va JAMAIS vers l'extérieur.
  2. Le dessus marchable est à z = 0, partout.
  3. L'anneau du bas est à z = -CRUST_H et PLAT : c'est lui que le shader
     descend pour allonger la jupe.
  4. Le dessus reste subdivisé (le shader y déplace les sommets).
  5. Les faces du flanc gardent une normale peu verticale : le shader ne
     déplace que les sommets dont la normale monte (> 0.5).
  6. Teintes par sommet, pas de texture : la couleur de culte arrive par
     instanceColor et MULTIPLIE la couleur de sommet.

Usage
  blender --background --python blender/hex_tile_variants.py
    → écrit public/assets/models/tiles/<nom>.glb (+ le .blend de travail)
==========================================================================
"""
import bpy
import bmesh
import math
import os

# --- Constantes reprises telles quelles de src/hexmap.js ---------------------
HEX_R = 4.1        # circonrayon (HEX_R)
CRUST_H = 1.2      # épaisseur de la dalle (CRUST_H)
TOP_SUB = 8        # subdivision barycentrique par secteur (TOP_SUB)

# Couleurs de sommet de makeCrust(), en linéaire (three.js lit du linéaire).
C_SIDE = (0.42, 0.38, 0.34)
C_SIDE_BOT = (0.22, 0.20, 0.18)
C_BOT = (0.14, 0.14, 0.16)

# Résolution du pourtour : le dessus, le biseau, le flanc et le dessous la
# partagent, ce qui laisse le maillage soudé sans avoir à recoudre quoi que ce
# soit. 6 × TOP_SUB points, soit un point tous les ~0,5 unité.
PERIM = 6 * TOP_SUB


# ---------------------------------------------------------------------------
#  Bruit de valeur déterministe. Blender embarque numpy mais pas de bruit
#  scriptable pratique ; quelques lignes suffisent et le résultat est
#  reproductible d'une machine à l'autre, ce qui compte pour un asset commité.
# ---------------------------------------------------------------------------
def _hash2(x, y, seed):
    n = math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123
    return n - math.floor(n)


def _noise2(x, y, seed):
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    fx = fx * fx * (3.0 - 2.0 * fx)
    fy = fy * fy * (3.0 - 2.0 * fy)
    a = _hash2(ix, iy, seed)
    b = _hash2(ix + 1, iy, seed)
    c = _hash2(ix, iy + 1, seed)
    d = _hash2(ix + 1, iy + 1, seed)
    return (a + (b - a) * fx) + ((c - a) + (d - c) * fx - (b - a) * fx) * fy


def _fbm2(x, y, seed, octaves=3):
    s, amp, norm = 0.0, 0.5, 0.0
    for _ in range(octaves):
        s += amp * _noise2(x, y, seed)
        norm += amp
        x *= 2.07
        y *= 2.07
        amp *= 0.5
    return s / norm


def _ring_noise(t, y, seed, freq, yfreq, octaves=3):
    """Bruit PÉRIODIQUE le long du pourtour.

    t est la position sur le tour, dans [0, 1). Un bruit lu directement sur t
    ne recolle pas en t = 1 : la dernière colonne de sommets du flanc sauterait
    par rapport à la première, et une fente s'ouvrirait sur toute la hauteur de
    la jupe. On lit donc le bruit sur le CERCLE (cos, sin), ce qui est continu
    par construction.
    """
    a = t * math.tau
    return _fbm2(math.cos(a) * freq + y * 0.017,
                 math.sin(a) * freq + y * yfreq, seed, octaves)


# ---------------------------------------------------------------------------
#  Profil d'une variante — c'est ce qu'on fera varier par biome.
# ---------------------------------------------------------------------------
class Profile:
    def __init__(self, name, seed=1,
                 chamfer=0.14, chamfer_var=0.06, chamfer_d=0.11,
                 side_rings=5, side_amp=0.16, side_freq=3.4, side_yfreq=0.55,
                 ledge=0.0, ledge_z=0.45):
        self.name = name
        self.seed = seed
        # Biseau du rebord : retrait moyen du dessus, son irrégularité, et la
        # profondeur à laquelle la facette rejoint le contour exact.
        self.chamfer = chamfer
        self.chamfer_var = chamfer_var
        self.chamfer_d = chamfer_d
        # Flanc : nombre d'anneaux, amplitude du retrait, et les fréquences du
        # bruit. side_yfreq faible = stries verticales (voir l'entête).
        self.side_rings = side_rings
        self.side_amp = side_amp
        self.side_freq = side_freq
        self.side_yfreq = side_yfreq
        # Ressaut : un décrochement franc à mi-hauteur, qui fait lire une
        # strate. 0 = pas de ressaut.
        self.ledge = ledge
        self.ledge_z = ledge_z


def perim_point(k):
    """Point k du pourtour nominal, sur l'hexagone flat-top de rayon HEX_R.

    Y inversé : Blender est Z-up, three.js Y-up, et l'export glTF envoie
    Blender Y → three −Z. On pose donc X = R·cos a, Y = −R·sin a pour retomber
    sur les sommets du code (x = R·cos a, z = R·sin a).
    """
    edge = k // TOP_SUB
    f = (k % TOP_SUB) / TOP_SUB
    a0 = (edge / 6.0) * math.tau
    a1 = ((edge + 1) / 6.0) * math.tau
    ax, ay = HEX_R * math.cos(a0), -HEX_R * math.sin(a0)
    bx, by = HEX_R * math.cos(a1), -HEX_R * math.sin(a1)
    return (ax + (bx - ax) * f, ay + (by - ay) * f)


def build_variant(prof):
    verts = []
    index = {}

    def vert(x, y, z):
        k = (round(x, 5), round(y, 5), round(z, 5))
        if k not in index:
            index[k] = len(verts)
            verts.append((x, y, z))
        return index[k]

    faces = []
    TOP, SIDE, BOT, RIM = 'top', 'side', 'bot', 'rim'

    # --- Retrait du biseau, un par point du pourtour ------------------------
    # Irrégulier : c'est lui qui fait lire un bord érodé plutôt qu'une pièce
    # découpée à l'emporte-pièce. Toujours positif — on ne sort jamais de R.
    chamf = []
    for k in range(PERIM):
        n = _ring_noise(k / PERIM, 0.0, prof.seed + 11, 2.6, 0.0)
        chamf.append(max(0.0, prof.chamfer + (n - 0.5) * 2.0 * prof.chamfer_var))

    def inset_point(k):
        """Point k du pourtour, rentré de son retrait de biseau.

        Retrait RADIAL : au milieu d'une arête il est perpendiculaire à
        celle-ci, dans un coin il suit la diagonale. L'arête s'incurve donc
        très légèrement (~0,02 pour un retrait de 0,14), sans conséquence, et
        ça évite d'avoir à traiter les coins à part.
        """
        px, py = perim_point(k)
        r = math.hypot(px, py)
        s = (r - chamf[k]) / r
        return (px * s, py * s)

    # --- Dessus : grille barycentrique par secteur, comme le gabarit --------
    # Seul l'anneau extérieur change : il est rentré du retrait de biseau. Il
    # est hors de la zone qui compte — le shader éteint son relief avant
    # LIFT_FADE_OUT = 3,15 et aucun prop n'est placé au-delà de ~1,95 — donc le
    # rentrer ne désaligne rien.
    for i in range(6):
        a0 = (i / 6.0) * math.tau
        a1 = ((i + 1) / 6.0) * math.tau
        ax, ay = HEX_R * math.cos(a0), -HEX_R * math.sin(a0)
        bx, by = HEX_R * math.cos(a1), -HEX_R * math.sin(a1)
        grid = {}
        for u in range(TOP_SUB + 1):
            for v in range(TOP_SUB + 1 - u):
                if u + v == TOP_SUB:
                    # sur le pourtour : point k = i·TOP_SUB + v, rentré
                    x, y = inset_point((i * TOP_SUB + v) % PERIM)
                else:
                    x = (ax * u + bx * v) / TOP_SUB
                    y = (ay * u + by * v) / TOP_SUB
                grid[(u, v)] = vert(x, y, 0.0)
        for u in range(TOP_SUB):
            for v in range(TOP_SUB - u):
                faces.append(((grid[(u, v)], grid[(u, v + 1)], grid[(u + 1, v)]), TOP))
                if u + v + 1 < TOP_SUB:
                    faces.append(((grid[(u + 1, v)], grid[(u, v + 1)],
                                   grid[(u + 1, v + 1)]), TOP))

    # --- Anneaux du pourtour ------------------------------------------------
    # r0 : bord rentré du dessus, à z = 0.
    # r1 : contour EXACT à R, à z = -chamfer_d. C'est lui la collision.
    ring_top = [vert(*inset_point(k), 0.0) for k in range(PERIM)]
    ring_rim = [vert(*perim_point(k), -prof.chamfer_d) for k in range(PERIM)]

    # Biseau : la facette qui relie les deux. Rainure en V à fond plein entre
    # deux tuiles voisines.
    for k in range(PERIM):
        j = (k + 1) % PERIM
        faces.append(((ring_top[k], ring_top[j], ring_rim[j], ring_rim[k]), RIM))

    # --- Flanc : anneaux successifs, rentrés par un bruit à stries verticales
    prev = ring_rim
    z0, z1 = -prof.chamfer_d, -CRUST_H
    for ri in range(1, prof.side_rings + 1):
        f = ri / prof.side_rings
        z = z0 + (z1 - z0) * f
        last = (ri == prof.side_rings)
        cur = []
        for k in range(PERIM):
            px, py = perim_point(k)
            if last:
                # Anneau du bas : nominal et plat. Invariant 3 — c'est lui que
                # le shader descend, un anneau déformé se verrait s'étirer.
                cur.append(vert(px, py, -CRUST_H))
                continue
            # Extinction aux deux bouts : on recolle au contour exact en haut
            # (emboîtement) et à l'anneau nominal en bas.
            taper = math.sin(f * math.pi) ** 0.7
            n = _ring_noise(k / PERIM, z, prof.seed, prof.side_freq, prof.side_yfreq)
            d = (n * prof.side_amp) * taper
            if prof.ledge > 0.0 and f > prof.ledge_z:
                d += prof.ledge * taper
            r = math.hypot(px, py)
            s = (r - d) / r          # toujours RENTRANT : jamais au-delà de R
            cur.append(vert(px * s, py * s, z))
        for k in range(PERIM):
            j = (k + 1) % PERIM
            faces.append(((prev[k], prev[j], cur[j], cur[k]), SIDE))
        prev = cur

    # --- Dessous : éventail sur l'anneau du bas. Plat, et il le reste. ------
    cbot = vert(0.0, 0.0, -CRUST_H)
    for k in range(PERIM):
        j = (k + 1) % PERIM
        faces.append(((cbot, prev[k], prev[j]), BOT))

    # --- Assemblage ---------------------------------------------------------
    mesh = bpy.data.meshes.new(prof.name)
    mesh.from_pydata(verts, [], [f[0] for f in faces])
    mesh.update()

    obj = bpy.data.objects.new(prof.name, mesh)
    bpy.context.collection.objects.link(obj)

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    # Dessus lisse (il sera déplacé par le shader) ; biseau, flanc et dessous à
    # facettes, c'est ce qui donne la roche.
    for poly, (_, kind) in zip(mesh.polygons, faces):
        poly.use_smooth = (kind == TOP)

    # --- Teintes par coin de face : un sommet du rebord est clair côté dessus
    #     et sombre côté biseau, d'où le domaine FACE_CORNER. ----------------
    attr = mesh.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='CORNER')
    for poly, (_, kind) in zip(mesh.polygons, faces):
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            if kind == TOP:
                dist = min(1.0, math.hypot(co.x, co.y) / HEX_R)
                sh = max(0.82, 1.04 - dist * dist * 0.14)
                c = (sh, sh, sh)
            elif kind == RIM:
                # Arête vive éclairée : le biseau attrape la lumière, c'est ce
                # qui dessine la couture de l'hexagone vu de dessus.
                c = (0.62, 0.58, 0.52) if co.z > -1e-5 else C_SIDE
            elif kind == SIDE:
                # Dégradé du haut du flanc vers sa base.
                f = min(1.0, max(0.0, -co.z / CRUST_H))
                c = tuple(C_SIDE[i] + (C_SIDE_BOT[i] - C_SIDE[i]) * f for i in range(3))
            else:
                c = C_BOT
            attr.data[li].color = (c[0], c[1], c[2], 1.0)

    # --- Groupes de sommets : repères de sculpt, pas lus par le moteur ------
    g_bot = obj.vertex_groups.new(name='skirt_bottom')
    g_rim = obj.vertex_groups.new(name='rim')
    g_top = obj.vertex_groups.new(name='top')
    for v in mesh.vertices:
        if abs(v.co.z + CRUST_H) < 1e-5:
            g_bot.add([v.index], 1.0, 'REPLACE')
        elif abs(v.co.z) < 1e-5:
            g_top.add([v.index], 1.0, 'REPLACE')
        elif abs(v.co.z + prof.chamfer_d) < 1e-5:
            g_rim.add([v.index], 1.0, 'REPLACE')

    mat = bpy.data.materials.new('hex_crust')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Roughness'].default_value = 1.0
        if 'Specular IOR Level' in bsdf.inputs:
            bsdf.inputs['Specular IOR Level'].default_value = 0.0
        cattr = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        cattr.layer_name = 'Col'
        cattr.location = (-300, 200)
        mat.node_tree.links.new(cattr.outputs['Color'], bsdf.inputs['Base Color'])
    mesh.materials.append(mat)

    return obj


def check_invariants(obj, prof):
    """Vérifie sur le maillage produit ce que l'entête promet.

    Sculpter à l'aveugle une dalle qui doit s'emboîter au centième, c'est la
    garantie de s'en apercevoir en jeu trois variantes plus tard. On échoue ici.
    """
    m = obj.data
    errs = []
    apothem = HEX_R * math.cos(math.pi / 6)

    top_z = [v.co.z for v in m.vertices if v.co.z > -1e-5]
    if any(abs(z) > 1e-5 for z in top_z):
        errs.append('des sommets du dessus ne sont pas à z = 0')

    bot = [v for v in m.vertices if abs(v.co.z + CRUST_H) < 1e-4]
    if not bot:
        errs.append('aucun sommet sur l’anneau du bas')

    # Rien ne dépasse le contour : on teste la distance signée à chaque arête.
    worst = 0.0
    for v in m.vertices:
        for i in range(6):
            a = ((i + 0.5) / 6.0) * math.tau       # normale d'arête flat-top
            d = v.co.x * math.cos(a) - v.co.y * math.sin(a)
            worst = max(worst, d - apothem)
    if worst > 1e-4:
        errs.append(f'le maillage sort du contour de {worst:.4f}')

    # Le contour exact doit rester atteint, sinon les tuiles ne se touchent plus.
    reach = max(math.hypot(v.co.x, v.co.y) for v in m.vertices)
    if reach < HEX_R - 1e-4:
        errs.append(f'le contour n’atteint plus R : {reach:.4f} < {HEX_R}')

    if errs:
        raise SystemExit('[hex_tile] INVARIANT CASSÉ (%s) :\n  - %s'
                         % (prof.name, '\n  - '.join(errs)))
    print(f'[hex_tile] {prof.name} : invariants OK '
          f'(contour {reach:.4f}, débord {worst:+.5f})')


def export(obj, prof, root):
    out_dir = os.path.join(root, 'public', 'assets', 'models', 'tiles')
    os.makedirs(out_dir, exist_ok=True)
    glb = os.path.join(out_dir, prof.name + '.glb')

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
    )
    print(f'[hex_tile] {prof.name} : {len(obj.data.vertices)} sommets, '
          f'{len(obj.data.polygons)} faces → {glb}')
    return glb


# --- Variante témoin : flanc rocheux, rebord érodé ---------------------------
VARIANTS = [
    Profile('hex_rock_01', seed=3,
            chamfer=0.16, chamfer_var=0.07, chamfer_d=0.12,
            side_rings=6, side_amp=0.22, side_freq=3.8, side_yfreq=0.5,
            ledge=0.06, ledge_z=0.55),
]


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for prof in VARIANTS:
        obj = build_variant(prof)
        check_invariants(obj, prof)
        export(obj, prof, root)
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(root, 'blender', 'hex_tile_variants.blend'))


main()
