"""
============================================================================
Cult.io — Cuisson de l'occlusion ambiante dans les couleurs de sommet
----------------------------------------------------------------------------
CE QUE ÇA APPORTE

L'occlusion ambiante est ce qui manque le plus au rendu depuis le passage au
PBR. Une lumière directionnelle et un éclairage par image savent dire d'où
vient la lumière ; ni l'un ni l'autre ne sait qu'un creux en reçoit moins
qu'une arête. Sans elle, un rocher posé sur le sol n'a aucune attache : rien
ne s'assombrit à sa base, il paraît flotter. C'est le « décollement » qui
reste visible même une fois les ombres portées réglées.

Une passe SSAO au rendu donnerait le même résultat pour un coût par image.
Cuite ici, elle est gratuite à l'exécution : ce n'est plus qu'un attribut de
sommet que le shader multiplie.

POURQUOI DANS LES COULEURS DE SOMMET, ET PAS DANS UNE TEXTURE

  Aucun modèle du projet n'a de second jeu d'UV — vérifié, tous n'ont que
  TEXCOORD_0. Une occlusion en texture demanderait donc un dépliage
  supplémentaire par modèle : un fichier image de plus à charger, de la VRAM
  en plus sur mobile, et le risque qu'un dépliage automatique chevauche des
  îlots et produise une occlusion fausse aux jointures.

  Les couleurs de sommet ne demandent aucun UV. Elles voyagent dans le flux
  d'attributs qui existe déjà, survivent à la compression meshopt, et le
  moteur n'a qu'à activer `vertexColors` sur le matériau.

  Leur limite est la DENSITÉ : l'occlusion est interpolée entre sommets, donc
  un modèle grossier ne peut pas porter de détail fin. D'où le garde-fou
  ci-dessous — sous un certain nombre de sommets, le script refuse plutôt que
  de produire un résultat mou dont on ne comprendrait pas pourquoi il est raté.

LE PLANCHER

  Une occlusion brute descend à zéro dans les creux fermés. Multipliée par
  l'albédo, elle y produit du noir pur — exactement le défaut qu'on vient de
  corriger sur les textures des personnages. `--floor` garantit un minimum :
  un creux est plus sombre, il n'est jamais éteint.

USAGE
  blender --background --python blender/bake_ao.py -- \
      --in=public/assets/models/sanctuary_base.glb \
      [--out=...] [--samples=64] [--floor=0.45] [--strength=1.0] [--dist=0.6]

  Sans --out, le fichier d'entrée est réécrit (une sauvegarde .bak est créée
  si elle n'existe pas déjà).

  Après cuisson, recompresser CE modèle seul :
      node scripts/optimize-models.mjs --only=<fichier.glb>
============================================================================
"""

import bpy
import os
import shutil
import sys

MIN_VERTS = 2000   # en deçà, l'occlusion par sommet n'a pas de quoi se dessiner


def args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    out = {}
    for a in argv:
        if a.startswith('--') and '=' in a:
            k, v = a[2:].split('=', 1)
            out[k] = v
    return out


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.data.vertices)]


def prepare_color_attribute(obj):
    """Crée (ou réutilise) l'attribut de couleur qui recevra l'occlusion.

    La cuisson écrit dans l'attribut ACTIF : sans ce réglage, Blender bake
    dans le premier venu, ou échoue si le maillage n'en a aucun.

    Domaine POINT, et c'est un choix mesuré. Le domaine CORNER — une valeur
    par coin de face — donne des arêtes plus franches, mais l'exportateur glTF
    doit alors DÉDOUBLER tout sommet dont les coins diffèrent : sur le socle de
    sanctuaire, 219 000 sommets devenaient 397 000, et le fichier compressé
    passait de 2,3 à 5,0 Mo. Doubler le poids d'un modèle pour un gain d'arête
    n'est pas un échange raisonnable dans un jeu web.

    Et le gain est en grande partie illusoire ici : les maillages portent déjà
    des sommets dédoublés là où les normales sont dures, donc les arêtes
    franches ont déjà leurs propres sommets. En POINT, elles gardent leur
    valeur propre ; seules les arêtes lisses moyennent, ce qui est justement le
    comportement voulu sur une surface lisse.
    """
    me = obj.data
    attr = me.color_attributes.get('AO')
    if attr is None:
        attr = me.color_attributes.new(name='AO', type='BYTE_COLOR', domain='POINT')
    me.color_attributes.active_color = attr
    me.color_attributes.default_color_name = attr.name
    return attr


def remap(obj, floor, strength):
    """Applique dosage et plancher sur l'occlusion cuite.

    Blender ne sait pas moduler la force d'une cuisson d'occlusion : il rend
    ce que la scène donne. On corrige donc après coup, ce qui présente
    l'avantage de pouvoir réessayer d'autres valeurs sans recuire — la cuisson
    est la partie lente.
    """
    me = obj.data
    attr = me.color_attributes.get('AO')
    if attr is None:
        return
    for d in attr.data:
        c = d.color
        # canal unique : une occlusion est une valeur, pas une teinte
        v = c[0]
        v = 1.0 - strength * (1.0 - v)
        v = floor + (1.0 - floor) * v
        v = min(1.0, max(0.0, v))
        d.color = (v, v, v, 1.0)


def main():
    a = args()
    src = a.get('in')
    if not src:
        print('bake_ao: --in=<fichier.glb> manquant')
        sys.exit(1)
    src = os.path.abspath(src)
    dst = os.path.abspath(a.get('out', src))
    samples = int(a.get('samples', 64))
    floor = float(a.get('floor', 0.45))
    strength = float(a.get('strength', 1.0))
    dist = float(a.get('dist', 0.6))

    if not os.path.exists(src):
        print('bake_ao: introuvable :', src)
        sys.exit(1)

    reset()
    bpy.ops.import_scene.gltf(filepath=src)

    objs = mesh_objects()
    if not objs:
        print('bake_ao: aucun maillage')
        sys.exit(1)

    total = sum(len(o.data.vertices) for o in objs)
    print('bake_ao: %d objet(s), %d sommets' % (len(objs), total))
    if total < MIN_VERTS:
        print('bake_ao: REFUS — %d sommets, moins que le minimum de %d.' % (total, MIN_VERTS))
        print('         Une occlusion par sommet y serait interpolée sur de trop grandes')
        print('         faces : le résultat serait flou et illisible. Ce modèle demande')
        print('         une occlusion en texture, donc un second jeu d\'UV.')
        sys.exit(2)

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    # L'occlusion ne dépend que de la géométrie : ni rebond, ni transparence.
    scene.cycles.max_bounces = 0

    bake = scene.render.bake
    bake.target = 'VERTEX_COLORS'
    # Distance de sondage : au-delà, une surface est considérée dégagée. Trop
    # grande, tout le modèle s'assombrit uniformément et le contraste se perd ;
    # trop petite, seules les fissures reçoivent quelque chose.
    if hasattr(scene.world, 'light_settings'):
        scene.world.light_settings.distance = dist

    for o in objs:
        prepare_color_attribute(o)

    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

    print('bake_ao: cuisson (%d échantillons, distance %.2f)...' % (samples, dist))
    bpy.ops.object.bake(type='AO', use_clear=True)

    for o in objs:
        remap(o, floor, strength)
    print('bake_ao: plancher %.2f, force %.2f appliqués' % (floor, strength))

    if dst == src:
        # HORS de public/ : tout ce qui s'y trouve est copié tel quel par Vite
        # dans dist/, puis par Capacitor dans l'APK. Une sauvegarde posée à côté
        # du modèle se retrouve donc livrée aux joueurs — plusieurs mégaoctets
        # que personne ne charge. Un dossier à part ne peut pas finir dans un
        # build.
        bak_dir = os.path.join(os.getcwd(), '.model-backups')
        os.makedirs(bak_dir, exist_ok=True)
        bak = os.path.join(bak_dir, os.path.basename(src) + '.bak')
        if not os.path.exists(bak):
            shutil.copyfile(src, bak)
            print('bake_ao: original sauvegardé →', bak)

    opts = dict(
        filepath=dst,
        export_format='GLB',
        use_selection=False,
        export_apply=False,
        # Sans ACTIVE, l'exportateur n'écrit les couleurs de sommet que si le
        # matériau Blender les utilise — ce qui n'est pas le cas ici, la
        # couleur étant reconstruite côté moteur.
        export_vertex_color='ACTIVE',
    )
    try:
        bpy.ops.export_scene.gltf(**opts)
    except TypeError:
        # Le nom de l'option a changé selon les versions de Blender : on
        # réessaie sans, quitte à vérifier ensuite que COLOR_0 est bien présent.
        opts.pop('export_vertex_color', None)
        bpy.ops.export_scene.gltf(**opts)
        print('bake_ao: option export_vertex_color absente — À VÉRIFIER')

    print('bake_ao: écrit →', dst)


main()
