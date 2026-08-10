"""
============================================================================
Cult.io — Gabarit de la tuile hexagonale (source Blender)
----------------------------------------------------------------------------
Reconstruit dans Blender, au millimètre, la dalle que `makeCrust()` génère
aujourd'hui à la volée dans src/hexmap.js. C'est le POINT DE DÉPART du
sculpt : tout ce qui est posé ici est une contrainte du moteur, pas un choix
esthétique — voir les invariants ci-dessous.

Repères Blender vs glTF/three.js
  Blender est Z-up, three.js est Y-up. L'export glTF (+Y up) envoie
  Blender Z → three Y et Blender Y → three −Z. Le gabarit est donc modelé
  avec l'hexagone dans le plan XY et la hauteur en Z, en posant
      X = R·cos(a)   Y = −R·sin(a)
  pour retomber sur les sommets du code (x = R·cos a, z = R·sin a).
  Un hexagone régulier est symétrique par y → −y : l'inversion ne se voit
  donc PAS sur le contour. Elle se verra dès que le dessus sera sculpté de
  façon asymétrique — c'est normal, et c'est géré par l'export, pas par toi.

Invariants à ne jamais casser en sculptant
  1. Contour : hexagone flat-top régulier, circonrayon 4.1 EXACT. C'est la
     collision (apothème 3.551) et l'emboîtement des tuiles voisines. Le
     contour doit aussi rester invariant par rotation de 60°, sinon on perd
     la possibilité de faire tourner les instances pour varier l'aspect.
  2. Le dessus marchable est à Z = 0. Tout ce qui se pose sur la carte lit
     groundHeightAt() qui suppose ce zéro.
  3. L'anneau du bas est à Z = −1.2 (CRUST_H) et doit rester PLAT : ce sont
     les seuls sommets que le moteur descendra pour allonger la jupe sous
     une tuile haute. S'ils cessent d'être plats, l'étirement se voit.
  4. Le dessus doit rester subdivisé : le shader y déplace les sommets
     (bruit de groundNoise.js, partagé avec le décor). Un dessus à 6
     triangles = plus de relief de sol du tout.
  5. Les faces du flanc doivent garder une normale peu verticale : le shader
     ne déplace que les sommets dont la normale monte (> 0.5). Un flanc trop
     incliné se mettrait à onduler avec le dessus.
  6. Teintes par sommet, pas de texture : la couleur de culte arrive par
     instanceColor et MULTIPLIE la couleur de sommet.

Usage
  blender --background --python blender/hex_tile_base.py
    → écrit blender/hex_tile.blend et public/assets/models/hex_tile.glb
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


def top_col(x, y):
    """Assombrissement du dessus vers les bords — topCol() du code."""
    dist = min(1.0, math.hypot(x, y) / HEX_R)
    sh = max(0.82, 1.04 - dist * dist * 0.14)
    return (sh, sh, sh)


def build_mesh():
    verts = []
    index = {}

    def vert(x, y, z):
        """Sommet dédupliqué : le maillage sort soudé, prêt à sculpter."""
        k = (round(x, 5), round(y, 5), round(z, 5))
        if k not in index:
            index[k] = len(verts)
            verts.append((x, y, z))
        return index[k]

    # Coins du flat-top. Y inversé : voir l'entête sur le repère.
    corner = []
    for i in range(6):
        a = (i / 6.0) * math.tau
        corner.append((HEX_R * math.cos(a), -HEX_R * math.sin(a)))

    faces = []      # (indices, type) — le type sert à teinter et à lisser
    TOP, SIDE, BOT = 'top', 'side', 'bot'

    # --- Dessus : grille barycentrique par secteur (topologie du code) ------
    for i in range(6):
        ax, ay = corner[i]
        bx, by = corner[(i + 1) % 6]
        grid = {}
        for u in range(TOP_SUB + 1):
            for v in range(TOP_SUB + 1 - u):
                x = (ax * u + bx * v) / TOP_SUB
                y = (ay * u + by * v) / TOP_SUB
                grid[(u, v)] = vert(x, y, 0.0)
        for u in range(TOP_SUB):
            for v in range(TOP_SUB - u):
                faces.append(((grid[(u, v)], grid[(u, v + 1)], grid[(u + 1, v)]), TOP))
                if u + v + 1 < TOP_SUB:
                    faces.append(((grid[(u + 1, v)], grid[(u, v + 1)],
                                   grid[(u + 1, v + 1)]), TOP))

    # --- Jupe : mur vertical, en quads (plus facile à retoucher au sculpt) --
    for i in range(6):
        x0, y0 = corner[i]
        x1, y1 = corner[(i + 1) % 6]
        a = vert(x0, y0, 0.0)
        b = vert(x1, y1, 0.0)
        c = vert(x1, y1, -CRUST_H)
        d = vert(x0, y0, -CRUST_H)
        faces.append(((a, b, c, d), SIDE))

    # --- Dessous : éventail. Plat, et il doit le rester (invariant 3). ------
    cbot = vert(0.0, 0.0, -CRUST_H)
    ring = [vert(x, y, -CRUST_H) for (x, y) in corner]
    for i in range(6):
        faces.append(((cbot, ring[i], ring[(i + 1) % 6]), BOT))

    mesh = bpy.data.meshes.new('hex_tile')
    mesh.from_pydata(verts, [], [f[0] for f in faces])
    mesh.update()

    obj = bpy.data.objects.new('hex_tile', mesh)
    bpy.context.collection.objects.link(obj)

    # --- Normales cohérentes vers l'extérieur (le volume est fermé) --------
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    # --- Lissage : dessus lisse (il sera déplacé), flanc et dessous à plat --
    for poly, (_, kind) in zip(mesh.polygons, faces):
        poly.use_smooth = (kind == TOP)

    # Arêtes vives sur l'anneau du haut et celui du bas : la silhouette de la
    # dalle doit rester nette, l'export glTF y dédoublera les normales.
    ring_top = {round(math.hypot(*c), 4) for c in corner}
    for edge in mesh.edges:
        va, vb = (mesh.vertices[i].co for i in edge.vertices)
        on_rim = (abs(va.z) < 1e-5 and abs(vb.z) < 1e-5
                  and round(math.hypot(va.x, va.y), 4) in ring_top
                  and round(math.hypot(vb.x, vb.y), 4) in ring_top)
        on_bottom = abs(va.z + CRUST_H) < 1e-5 and abs(vb.z + CRUST_H) < 1e-5
        if on_rim or on_bottom:
            edge.use_edge_sharp = True

    # --- Teintes par coin de face : un même sommet est clair côté dessus et
    #     sombre côté flanc, il faut donc le domaine FACE_CORNER. ------------
    attr = mesh.color_attributes.new(name='Col', type='FLOAT_COLOR',
                                     domain='CORNER')
    for poly, (_, kind) in zip(mesh.polygons, faces):
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            co = mesh.vertices[vi].co
            if kind == TOP:
                c = top_col(co.x, co.y)
            elif kind == SIDE:
                c = C_SIDE if co.z > -1e-5 else C_SIDE_BOT
            else:
                c = C_BOT
            attr.data[li].color = (c[0], c[1], c[2], 1.0)

    # --- Groupes de sommets : repères de sculpt, pas lus par le moteur -----
    g_bot = obj.vertex_groups.new(name='skirt_bottom')
    g_rim = obj.vertex_groups.new(name='rim')
    g_top = obj.vertex_groups.new(name='top')
    for v in mesh.vertices:
        if abs(v.co.z + CRUST_H) < 1e-5:
            g_bot.add([v.index], 1.0, 'REPLACE')
        elif abs(v.co.z) < 1e-5:
            g_top.add([v.index], 1.0, 'REPLACE')
            if round(math.hypot(v.co.x, v.co.y), 4) in ring_top:
                g_rim.add([v.index], 1.0, 'REPLACE')

    # --- Matériau : vertex colors seules, la teinte de culte vient du moteur
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


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    obj = build_mesh()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    blend = os.path.join(root, 'blender', 'hex_tile.blend')
    glb = os.path.join(root, 'public', 'assets', 'models', 'hex_tile.glb')

    bpy.ops.wm.save_as_mainfile(filepath=blend)

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

    m = obj.data
    print(f'[hex_tile] {len(m.vertices)} sommets, {len(m.polygons)} faces')
    print(f'[hex_tile] blend : {blend}')
    print(f'[hex_tile] glb   : {glb}')


main()
