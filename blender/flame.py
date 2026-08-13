"""
============================================================================
Cult.io — Flamme stylisée en coques superposées
----------------------------------------------------------------------------
Reproduit la recette de la « flamme animée » cel-shadée : pas de simulation,
pas de texture, pas de volumétrique. Un empilement de COQUES en goutte,
concentriques, chacune un peu plus petite et plus chaude que celle qui
l'entoure. L'œil lit la superposition comme un dégradé de température, et
l'additive blending du moteur fait le reste.

POURQUOI LA GÉOMÉTRIE ICI ET L'ANIMATION LÀ-BAS

  Les shaders Blender ne passent pas la porte du glTF. Tout ce qui bouge ou
  s'illumine doit donc être redit en GLSL côté moteur (src/flame.js). Ce
  script ne produit que ce qui NE bouge pas : la silhouette des coques, leur
  teinte de base, et surtout les deux coordonnées dont le vertex shader a
  besoin pour animer la chose sans rien deviner.

  Le partage est net :
    - ici        → forme et UV de pilotage ;
    - flame.js   → ondulation, scintillement, rampe de couleur, additive.

  La COULEUR n'est délibérément pas ici. Une première version cuisait la
  palette dans COLOR_0 ; le moteur ne pouvait alors que la multiplier, et une
  flamme bleue en sortait blanche. Les teintes sont donc reconstruites côté
  moteur à partir du seul rang de coque, et n'importe quelle couleur d'âme
  devient possible.

LE CONTRAT AVEC LE SHADER (à ne pas casser)
  1. uv.x = t, hauteur normalisée 0 (base) → 1 (pointe). Le shader s'en sert
     pour doser l'ondulation : nulle en bas — la flamme est accrochée à sa
     mèche — maximale à la pointe.
  2. uv.y = rang de la coque, (L + 0.5) / LAYERS, de l'extérieur (0) vers le
     cœur (1). Sert à déphaser les coques : sans ce décalage elles ondulent
     à l'unisson et le volume s'aplatit.
  3. La flamme est construite selon +Z, base à z = 0, hauteur totale 1, et
     exportée en Y-up : le moteur reçoit une flamme d'une unité de haut posée
     sur l'origine, qu'il lui suffit de mettre à l'échelle.
  4. Rayon nul en z = 0 et en z = 1 (goutte fermée aux deux bouts) : aucune
     face ouverte, donc pas de bord franc quand l'additive empile les coques.

Usage
  blender --background --python blender/flame.py
    → écrit public/assets/models/flame.glb (+ le .blend de travail)
==========================================================================
"""
import bpy
import math
import os

# --- Résolution --------------------------------------------------------------
# 5 coques × 20 secteurs × 14 anneaux ≈ 2.8k triangles. Le modèle de référence
# en fait 11.8k ; on tient largement dessous parce que la silhouette est portée
# par le profil et les godrons, pas par la densité.
LAYERS = 5
SEG = 20      # secteurs angulaires
RINGS = 14    # anneaux entre la base et la pointe


def profile(t):
    """Rayon de la goutte à la hauteur normalisée t (0 en bas, 1 en haut).

    sin(pi·t)^0.6 donnerait une amande symétrique, ventre à mi-hauteur — une
    forme d'œil, pas de flamme. On pré-déforme donc la hauteur en t^0.65, ce
    qui ramène le ventre vers t ≈ 0.35 : masse en bas, effilement long vers la
    pointe. C'est ce déséquilibre qui fait lire « flamme » plutôt que « bulle ».
    """
    t = min(max(t, 0.0), 1.0)
    return math.sin(math.pi * (t ** 0.65)) ** 0.6


def godron(theta, t, layer):
    """Facteur de godronnage : les cannelures verticales du pourtour.

    Elles vrillent avec la hauteur (le +twist·t) — une cannelure droite fait
    une lanterne, une cannelure vrillée fait une langue de feu. Chaque coque a
    son propre nombre de lobes et sa propre vrille, sinon les cannelures se
    superposent exactement et les coques intérieures disparaissent derrière.
    """
    lobes = 5 + layer                      # 5, 6, 7, 8, 9 — jamais en phase
    twist = 1.1 + 0.35 * layer
    amp = 0.16 * (1.0 - 0.12 * layer)      # le cœur reste plus lisse
    # L'amplitude s'éteint aux deux pointes : sinon les cannelures ouvrent la
    # goutte là où le rayon tend vers zéro et la pointe se met à fourcher.
    fade = math.sin(math.pi * t) ** 0.5
    return 1.0 + amp * fade * math.cos(lobes * theta + twist * t * math.tau)


def build_shell(layer):
    """Sommets, faces et UV d'une coque. Repère local +Z, base en 0."""
    # Chaque coque est un peu plus étroite ET un peu plus courte que celle qui
    # l'enveloppe : la pointe de chaque langue reste visible au lieu de percer
    # la coque suivante. C'est ce décalage qui donne l'étagement de couleur.
    radius = 0.30 * (1.0 - 0.155 * layer)
    height = 1.00 * (1.0 - 0.130 * layer)

    verts, uvs = [], []

    # Pointe basse : le rayon est nul en t = 0, un seul sommet suffit.
    verts.append((0.0, 0.0, 0.0))
    uvs.append((0.0, (layer + 0.5) / LAYERS))

    for j in range(1, RINGS):
        t = j / RINGS
        r = profile(t) * radius
        for k in range(SEG):
            theta = (k / SEG) * math.tau
            rr = r * godron(theta, t, layer)
            verts.append((rr * math.cos(theta), rr * math.sin(theta), t * height))
            uvs.append((t, (layer + 0.5) / LAYERS))

    # Pointe haute.
    apex = len(verts)
    verts.append((0.0, 0.0, height))
    uvs.append((1.0, (layer + 0.5) / LAYERS))

    faces = []
    ring0 = 1  # index du premier sommet du premier anneau

    # Éventail de la base.
    for k in range(SEG):
        faces.append((0, ring0 + k, ring0 + (k + 1) % SEG))

    # Quads entre anneaux consécutifs.
    for j in range(RINGS - 2):
        a = ring0 + j * SEG
        b = ring0 + (j + 1) * SEG
        for k in range(SEG):
            k2 = (k + 1) % SEG
            faces.append((a + k, b + k, b + k2, a + k2))

    # Éventail de la pointe.
    last = ring0 + (RINGS - 2) * SEG
    for k in range(SEG):
        faces.append((apex, last + (k + 1) % SEG, last + k))

    return verts, faces, uvs


def build_flame():
    """Fusionne les LAYERS coques dans un seul objet — un seul draw call."""
    all_verts, all_faces, all_uvs = [], [], []
    for layer in range(LAYERS):
        verts, faces, uvs = build_shell(layer)
        off = len(all_verts)
        all_verts.extend(verts)
        all_uvs.extend(uvs)
        all_faces.extend([tuple(i + off for i in f) for f in faces])

    mesh = bpy.data.meshes.new('flame')
    mesh.from_pydata(all_verts, [], all_faces)
    mesh.update()

    # UV : porté par les coins de face (loops), donc on relit l'index de sommet.
    uv_layer = mesh.uv_layers.new(name='UVMap')
    for loop in mesh.loops:
        uv_layer.data[loop.index].uv = all_uvs[loop.vertex_index]

    obj = bpy.data.objects.new('flame', mesh)
    bpy.context.collection.objects.link(obj)

    # Matériau nu : le glTF a besoin d'un slot, mais tout le rendu est repris
    # par le ShaderMaterial de src/flame.js. Rien à régler ici.
    mat = bpy.data.materials.new('flame')
    mat.use_nodes = True
    obj.data.materials.append(mat)

    # Lissage : la flamme n'a aucune arête franche à préserver.
    for poly in mesh.polygons:
        poly.use_smooth = True

    return obj


def check_invariants(obj):
    """Vérifie le contrat avec le shader avant d'écrire quoi que ce soit.

    Un .glb est un binaire commité : une régression silencieuse ici ne se voit
    qu'au runtime, sous forme de flamme immobile ou renversée.
    """
    mesh = obj.data
    errs = []

    zs = [v.co.z for v in mesh.vertices]
    if min(zs) < -1e-6:
        errs.append(f'base sous zéro (z min = {min(zs):.5f})')
    if abs(max(zs) - 1.0) > 1e-5:
        errs.append(f'hauteur totale != 1 (z max = {max(zs):.5f})')

    uv = mesh.uv_layers.active.data
    us = [d.uv[0] for d in uv]
    vs = sorted({round(d.uv[1], 5) for d in uv})
    if min(us) < -1e-6 or max(us) > 1.0 + 1e-6:
        errs.append(f'uv.x hors de [0,1] ({min(us):.4f} … {max(us):.4f})')
    if len(vs) != LAYERS:
        errs.append(f'uv.y : {len(vs)} rangs distincts au lieu de {LAYERS}')

    if errs:
        raise SystemExit('[flame] INVARIANT CASSÉ :\n  - ' + '\n  - '.join(errs))
    print(f'[flame] invariants OK ({len(mesh.vertices)} sommets, '
          f'{len(mesh.polygons)} faces, {LAYERS} coques)')


def export(obj, root):
    out_dir = os.path.join(root, 'public', 'assets', 'models')
    os.makedirs(out_dir, exist_ok=True)
    glb = os.path.join(out_dir, 'flame.glb')

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    opts = dict(
        filepath=glb,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='EXPORT',
        export_normals=True,
    )
    bpy.ops.export_scene.gltf(**opts)

    print(f'[flame] → {glb}')
    return glb


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    obj = build_flame()
    check_invariants(obj)
    export(obj, root)
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(root, 'blender', 'flame.blend'))


main()
