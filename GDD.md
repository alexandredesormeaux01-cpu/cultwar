# Cult.io — Game Design Document (Core Concept)

**Version :** 0.1 — Fondation conceptuelle
**Genre :** Arcade .io / Crowd Swarm — Solo contre IA
**Plateforme :** Mobile-first (contrôle à un doigt)
**Session cible :** 2 à 4 minutes par partie

---

## Pitch en une phrase

Vous êtes un Leader de culte lâché seul sur une carte remplie de sceptiques : convertissez-les par simple contact, transformez-les en essaim vivant qui vous suit et convertit à son tour, et absorbez les cultes rivaux jusqu'à ce qu'il n'en reste qu'un.

---

## 1. Expérience Joueur (UX / Game Feel)

### 1.1 La foule comme personnage principal

Le vrai protagoniste de Cult.io n'est pas le Leader — c'est **la foule**. Tout le game feel doit être investi dans son comportement visuel. Trois qualités à obtenir, par ordre de priorité :

**A. L'effet "liquide" (boids simplifiés)**
La foule ne doit jamais ressembler à une grille de pions qui suivent un point. Elle doit se comporter comme un fluide visqueux :
- Chaque fidèle suit le Leader avec une **force d'attraction élastique** (plus il est loin, plus il accélère), une **séparation douce** avec ses voisins (ils ne se superposent jamais mais se compressent), et une légère **inertie** individuelle.
- Résultat attendu : quand le joueur tourne brusquement, la foule "fouette" derrière lui comme une traîne ; quand il s'arrête, elle se **resserre en cercle** autour de lui comme de l'eau qui remplit un bol ; quand il passe dans un goulot, elle s'étire en goutte.
- Chaque conversion produit un micro-événement sensoriel : flash de couleur du PNJ (gris → couleur du culte), petit "pop" d'échelle (le PNJ grossit 120% puis revient à 100%), léger son de clochette/chœur, et une **onde** qui se propage dans la foule proche. La conversion doit être une friandise sensorielle, répétée des centaines de fois par partie.

**B. Compacité lisible**
À tout moment, le joueur doit lire l'état de la partie en un coup d'œil :
- Une foule = **une tache de couleur** unie et dense. Pas de fidèles éparpillés qui brouillent la lecture.
- Le Leader se distingue par sa taille (~1.5x), son symbole flottant au-dessus, et un léger halo.
- Le **cercle d'influence** (rayon de conversion) est matérialisé par un anneau translucide au sol qui grandit avec la foule — c'est la barre de progression diégétique du joueur.

**C. La masse qui s'exprime**
La croissance doit se *ressentir* physiquement, pas seulement se compter :
- Le halo et le cercle d'influence grandissent.
- Le son s'épaissit : murmures → chants → chœur grondant selon la taille de la foule.
- Légère vibration de caméra (subtile) quand la foule dépasse des paliers (25, 50, 100...).
- Le dézoom de caméra progressif accompagne la croissance : plus on est gros, plus on voit la carte — récompense d'information en plus de la récompense de puissance.

### 1.2 Pourquoi c'est psychologiquement addictif

Le concept coche méthodiquement les leviers connus du genre .io :

1. **Boucle de récompense à haute fréquence.** Une conversion toutes les 1-3 secondes en early game = un flux quasi continu de micro-récompenses (renforcement à ratio variable, le même mécanisme que les machines à sous). Le joueur n'attend jamais plus de quelques secondes avant le prochain "pop".
2. **Croissance visible et composée (effet boule de neige).** Chaque fidèle gagné augmente la capacité à en gagner d'autres (cercle d'influence + fidèles convertisseurs). Le joueur *voit* son investissement travailler pour lui — c'est la satisfaction des jeux incrémentaux, mais en temps réel et incarnée.
3. **Perte aversive et enjeu permanent.** Tout peut basculer en une collision. La peur de perdre sa foule (aversion à la perte, plus puissante que l'attrait du gain) maintient une tension constante, et le "kill" d'un Leader adverse — absorption instantanée de toute sa foule — est le pic dopaminergique de la partie : un retournement total en une demi-seconde.
4. **Sessions courtes, redémarrage instantané.** Une mort = un écran de score de 2 secondes = un bouton "Nouvelle croisade". Le coût d'une nouvelle tentative est nul, donc "encore une partie" est toujours la décision facile.
5. **Fantasme de puissance lisible.** Passer de "seul et vulnérable" à "marée humaine qui engloutit la carte" en 3 minutes est un arc de puissance complet et compressé — le cœur émotionnel du genre (Agar.io, Snake.io, Crowd City).
6. **Comparaison sociale permanente.** Le classement en temps réel affiché en jeu (voir §3) transforme chaque instant en compétition mesurable, même contre des IA.

### 1.3 Arc émotionnel d'une partie (3 actes)

| Acte | Durée | Émotion cible | Ce qui se passe |
|---|---|---|---|
| **Évangélisation** | 0:00–0:45 | Satisfaction pure, zéro danger | Carte riche en PNJ gris proches, aucun rival à portée. Le joueur apprend le contrôle en récoltant. |
| **Guerre de Religion** | 0:45–2:30 | Tension, chasse et fuite | Les cultes IA deviennent visibles. Escarmouches de bordure, décisions risque/récompense : fuir, grossir, ou frapper. |
| **Apothéose** | 2:30–fin | Domination ou revanche | 2-3 cultes géants s'affrontent. Un kill de Leader décide souvent tout. Victoire = la carte entière à votre couleur. |

---

## 2. Équilibrage des Mécaniques

### 2.1 Règle d'or : la taille est une force ET une faiblesse

Sans contrepoids, le premier culte en tête gagne mécaniquement (boule de neige incontrôlée) et la partie est décidée à 30 secondes. Trois mécanismes d'équilibrage, simples et lisibles :

**A. Vitesse inversement proportionnelle à la taille (le levier principal)**

> `Vitesse du Leader = V_max − (V_max − V_min) × (foule / foule_max_référence)`

- Concrètement : un Leader seul se déplace à **100%** de vitesse ; à ~200 fidèles, il plafonne à **~70%**. Jamais en dessous — un gros culte ne doit pas devenir injouable, juste rattrapable.
- Justification design : le petit joueur peut toujours **fuir** un gros (survie possible), et le gros doit **acculer ou piéger** plutôt que poursuivre bêtement (skill au sommet). C'est la règle Agar.io, éprouvée depuis dix ans.
- Bonus de lisibilité : la lourdeur croissante *raconte* la masse. Le joueur sent son culte peser.

**B. Conversion de foule à foule : proportionnelle, pas binaire**

Quand deux foules se percutent (sans toucher les Leaders) :
- Les fidèles au contact se convertissent vers le camp **le plus nombreux**, à un rythme proportionnel au ratio des tailles (ex. ratio 2:1 → le gros convertit 2x plus vite au front).
- Une petite foule qui touche brièvement une grosse perd donc quelques fidèles mais **peut se dégager** — l'accrochage est une érosion, pas une exécution. Seul le contact Leader-contre-foule est fatal.
- Cas d'égalité (~±10%) : conversion mutuelle lente au front, ce qui rend le duel frontal coûteux pour les deux et pousse à chercher l'angle ou le kill du Leader — plus intéressant qu'un simple "le plus gros gagne toujours".

**C. Réapprovisionnement de la carte**

- Les PNJ gris réapparaissent par petites grappes dans les zones **pauvres en foules**, à un rythme qui maintient ~15-20% de la population carte en neutres.
- Effet : les petits cultes ont toujours une ressource de reconstruction loin des géants, et la carte ne devient jamais un désert où seul le combat reste.

### 2.2 Le kill de Leader : haut risque, jackpot total

- Toucher le Leader adverse avec **n'importe quel fidèle de votre foule** (ou votre propre corps) l'élimine et transfère 100% de sa foule instantanément.
- Le Leader est toujours *dans* ou *derrière* sa foule — l'atteindre exige de traverser ou contourner sa protection. La foule est donc à la fois l'arme, le score **et le bouclier** : une seule entité, trois fonctions. C'est l'élégance centrale du design.
- Ouverture tactique clé : un Leader qui sprinte (voir §4) ou manœuvre mal peut se retrouver **découvert** en tête de sa propre foule — c'est la fenêtre d'assassinat. Le jeu récompense l'observation du positionnement adverse.
- Un tout petit culte peut ainsi tuer un géant mal positionné : c'est la soupape anti-frustration et la source des meilleurs moments ("David contre Goliath").

### 2.3 IA des Leaders rivaux (jeu solo)

Trois profils comportementaux simples, mélangés à chaque partie pour créer de la variété sans complexité :

| Profil | Comportement | Rôle dans l'écosystème |
|---|---|---|
| **Le Missionnaire** | Évite le combat, optimise la récolte de gris | Cible facile en early, menace de score en late |
| **L'Inquisiteur** | Cherche activement les foules plus petites que lui | Le prédateur qui met la pression sur le joueur |
| **L'Opportuniste** | Récolte, mais pivote vers tout Leader exposé ou affaibli | Punit les erreurs, crée les retournements |

Difficulté progressive au fil de l'aventure : on ajuste le *mix* des profils et leur temps de réaction, jamais leurs stats (pas de triche de vitesse/conversion — l'équité perçue est essentielle même contre des IA).

---

## 3. Système de Rangs et Victoire

### 3.1 Conditions de fin de partie

Deux modes de fin, selon la carte (l'aventure alternera) :

- **Domination** (mode de base) : la partie se termine quand il ne reste qu'un Leader vivant, **ou** quand un culte contrôle ~80% de la population totale de la carte. Le seuil de 80% évite le nettoyage fastidieux des dernières miettes.
- **Grand Prophète** (variante chronométrée) : 3 minutes, le culte le plus nombreux au gong l'emporte. Utile pour garantir des sessions à durée fixe.

### 3.2 Score et classement en temps réel

- **Score = nombre de fidèles actuels.** Une seule métrique, brutalement lisible, affichée en gros au-dessus du symbole du joueur.
- **Leaderboard permanent** en haut de l'écran : les 5 cultes classés par fidèles, avec couleur + symbole + nombre, mis à jour en continu. Le joueur y est toujours visible (surligné), même hors du top 5, avec son rang exact ("Vous : 4e — 87 fidèles").
- Chaque changement de rang du joueur déclenche un feedback : montée = fanfare courte + le rang qui pulse ; descente = son sourd discret. Le classement doit être un fil narratif, pas un tableau statique.
- **Événements annoncés** en bandeau bref : "⚡ Le Culte Pourpre a été absorbé !" — ces annonces dramatisent la partie et informent tactiquement (un rival éliminé = un géant en approche).

### 3.3 Écran de fin et rétention

- Défaite : stats de la tentative (pic de fidèles, conversions totales, Leaders éliminés, temps de survie) + **meilleur record personnel** juste à côté — le "presque" qui déclenche le retry. Bouton unique et énorme : **"Nouvelle Croisade"**.
- Victoire : la carte entière se teinte de la couleur du joueur (vague de conversion finale), puis stats + progression de l'aventure (carte suivante déverrouillée).
- Méta-progression légère (hors scope du core, mais à prévoir) : les victoires débloquent cartes, couleurs et symboles. Cosmétique et contenu uniquement — **jamais** de bonus de stats, pour préserver l'équité du cœur de jeu.

---

## 4. Idées d'Évolution Simples (profondeur minimaliste)

Trois fonctionnalités, chacune = un seul bouton ou zéro bouton, toutes construites sur la ressource déjà existante (les fidèles) :

### 4.1 Le Sacrifice (boost à coût réel) — priorité 1

- Un bouton unique (tap sur le portrait du Leader ou second doigt) : **sacrifiez 10% de votre foule** pour un **sprint de 3 secondes** (+50% vitesse, fidèles inclus).
- Usages émergents : fuir un Inquisiteur, fondre sur un Leader exposé pour l'assassiner, ou rusher une grappe de gris contestée.
- Pourquoi c'est bon : le boost n'est pas gratuit ni sur cooldown arbitraire — il **coûte du score**. Chaque utilisation est une vraie décision, et le sacrifice colle parfaitement au thème. Feedback visuel : les fidèles sacrifiés s'élèvent en particules de lumière de la couleur du culte.

### 4.2 La Ferveur (jauge passive de momentum) — priorité 2

- Une jauge se remplit avec les conversions **rapprochées dans le temps** (combo) et se vide lentement à l'inactivité. Pleine, elle déclenche automatiquement **l'Extase** : 5 secondes où le cercle d'influence est doublé et les conversions instantanées, avec explosion audiovisuelle (chants, halo doré).
- Pourquoi c'est bon : récompense le jeu agressif et continu (jamais l'attentisme), crée un rythme de "vagues" dans la partie, et zéro input requis — la profondeur vient du *timing* (déclencher l'Extase près d'une foule adverse est dévastateur).

### 4.3 Les Lieux Saints (interaction avec la carte) — priorité 3

- 2-3 emplacements fixes par carte (autel, monolithe, source). Rester dans la zone ~4 secondes la **capture** : les PNJ gris qui apparaissent ensuite près de ce lieu naissent directement à votre couleur (revenu passif), jusqu'à ce qu'un rival la recapture.
- Pourquoi c'est bon : crée des points de conflit fixes et des objectifs secondaires sans ajouter d'UI, donne une raison de traverser la carte, et devient le socle naturel de la **variété des cartes** prévue dans l'aventure (chaque carte = une disposition de Lieux Saints différente).

> **Ordre d'implémentation recommandé :** le core (conversion, foule liquide, vitesse inverse, kill de Leader, leaderboard) doit être *délicieux* seul avant d'ajouter quoi que ce soit. Le Sacrifice ensuite, car il enrichit immédiatement le duel. Ferveur et Lieux Saints seulement une fois le core validé en playtest.

---

## 5. Direction Artistique & Technique

### 5.1 Direction artistique : "low-poly joyeux"

- **3D simplifiée, caméra inclinée** (~52° de champ, vue de trois quarts qui suit le Leader et dézoome avec la foule) — jamais de vue de dessus plate.
- **Personnages polygonaux minimalistes** : un "meeple" (cône à 6 faces + tête sphérique low-poly), une seule couleur unie par camp. La silhouette doit rester lisible à 200 exemplaires à l'écran.
- **Couleurs vives et saturées** : gris neutre pour les sceptiques, palette néon pour les cultes (rose, azur, doré, émeraude, violet, rubis). Herbe verte claire à variations de teinte par vertex, fleurs ponctuelles vives.
- **Cartes = petites vallées fermées** : sol vallonné flat-shaded, couronne de montagnes low-poly comme limite naturelle, arbres coniques, rochers icosaédriques, brume de distance colorée. Chaque future carte = un biome (vallée, désert, île, neige...) avec la même grammaire de formes.
- **Lumière** : soleil directionnel chaud + hémisphérique froide, ombres portées douces qui suivent le joueur. Le flat shading fait tout le style — zéro texture.

### 5.2 Choix techniques (prototype)

- **Three.js / WebGL**, Vite. Cible : 60 fps mobile.
- **InstancedMesh** unique pour les ~640 PNJ (1 draw call), couleurs par instance pour les conversions.
- **Grille spatiale uniforme** pour séparation, conversions et combats (pas de test N²).
- Audio 100% synthétique (WebAudio), zéro asset externe.
- Contrôles : joystick virtuel flottant (apparaît sous le doigt) + WASD/flèches sur desktop.

## 5.3 Méta-progression : conquête du monde (globe + pays)

Repris et porté depuis Mix-it (React → JS vanilla, module autonome `src/progression.js`), accessible via **🌍 Carte du monde** au menu.

- **Globe Terre réelle** (vrai GeoJSON Natural Earth 110m), **terres à plat** (pas d'extrusion 3D), sur **fond étoilé cosmique**. Rotation **gauche/droite uniquement** (axe vertical verrouillé à 0,15, sensibilité 0,005 + inertie) — fidèle au comportement de Mix-it.
- **Cliquer un pays y entre** (hit-test sphérique `screenToLatLon` + `findCountryAt`). 5 terres jouables : France, Égypte, Russie, Brésil, Australie.
- **Carte de conquête du pays** : les régions internes réelles (admin-1) sont regroupées par proximité (k-means déterministe) en **8 à 15 grandes zones** conquérables. Chaque zone est tenue au départ par une **religion rivale** (couleur). Les exclaves lointaines (outre-mer) sont écartées pour cadrer la masse principale.
- **Boucle de conquête** : toucher une zone → **⚔ Convertir cette zone** lance une vraie partie Cult.io (le culte du joueur prend la couleur de la terre). **Victoire → la zone est repeinte à votre couleur** ; défaite → la zone résiste. Compteur `X / N zones`.
- **Conquérir toutes les zones** d'un pays le marque conquis et **déverrouille la terre suivante** sur le globe. Objectif final : convertir le monde entier.
- Progression sauvegardée en `localStorage`. Pont technique : `setPlayHandler(ctx => …)` côté moteur, `ctx.onResult(victoire)` au verdict.

## 6. Piliers de design (garde-fous pour la suite)

1. **Une entité, trois fonctions.** La foule est l'arme, le score et le bouclier. Toute nouvelle mécanique doit s'exprimer à travers la foule, pas à côté d'elle.
2. **Lisible en un regard.** Couleur = camp, taille de la tache = puissance, anneau = portée. Si une mécanique exige un tutoriel texte, elle est trop complexe.
3. **Jamais mort pour rien.** Chaque défaite doit être attribuable à une décision du joueur (mauvais angle, sprint mal placé, cupidité), jamais au hasard ou à une triche de l'IA.
4. **Le pouce suffit.** Un joystick virtuel flottant (apparaît où le pouce se pose), un seul bouton optionnel (Sacrifice). Rien d'autre.
5. **3 minutes, une histoire complète.** Chaque partie doit contenir montée, péril et dénouement. Si les parties traînent, resserrer la carte ou le seuil de fin, pas allonger.

---

## 7. Évolution Conceptuelle : Chasse aux Cristaux & Pièges (V2)

### 7.1 De la Foule aux Cristaux
* **Concept principal** : Le thème des "croyants" est abandonné au profit d'une chasse aux cristaux de haute intensité. Les joueurs doivent explorer la carte, collecter des cristaux instables et les ramener le plus vite possible à leur base.
* **Représentation visuelle** : Les cristaux collectés orbitent en anneaux autour du Leader (jauge visuelle dynamique). Plus le joueur transporte de cristaux, plus il est visible et devient une cible attrayante.
* **Extraction Express** : Les cristaux ne sont pas minés lentement. Le joueur passe sur des filonnets de cristaux ou y reste 1 seconde pour libérer 3 cristaux qui rejoignent instantanément son orbite.

### 7.2 Implication Tactique de la Peinture & Pièges (Option B)
* **Ralentissement & Alerte** : Marcher sur la peinture ennemie ralentit le joueur et alerte le propriétaire de cette peinture (ping visuel ou vibration).
* **Camouflage des Pièges** : Les pièges posés par les adversaires sont **totalement invisibles** lorsqu'ils se trouvent sur leur propre couleur de peinture. 
* **Révélation des Pièges** : Si un piège ennemi se trouve sur du sol neutre (gris) ou sur la peinture du joueur (alliée), il devient **directement visible** (clignote en rouge).

### 7.3 Les Buissons & L'Art de l'Embuscade
* **Furtivité** : Entrer dans un buisson rend le joueur translucide et le masque de la mini-carte/radar ennemi.
* **Perte de Cristaux** : Lorsqu'un joueur se prend un piège (filet, cage, colle, trappe tournante), il est immobilisé et **lâche des cristaux physiques** au sol. Un joueur embusqué dans un buisson proche peut surgir pour piller le butin et fuir à sa base.

### 7.4 La Faune Sauvage (Créatures)
* **Gardiens de Cristaux (Locaux)** : Lors de l'extraction d'un cristal, 2 à 3 petites créatures agressives (ex: spectres de pierre) surgissent et pourchassent brièvement le joueur pour le ralentir.
* **Le Traqueur de Cristaux (Global)** : Une grande créature menaçante rôde sur la carte et est activement attirée par le joueur qui transporte le plus grand nombre de cristaux (le Leader de la partie), équilibrant la partie de façon diégétique.

---

## 8. Disciples autonomes — priorités d'objectif

Les disciples (3 slots de base, extensibles via l'arbre de compétences) opèrent en autonomie sur la carte. Ils n'ont pas de skill dédié, meurent au contact d'un Leader rival, et leur slot se libère alors pour la prochaine promotion. Leur cible courante est pilotée par un seul chiffre — la **jauge de peinture du Leader** — selon trois paliers :

| Jauge peinture | Cible primaire | Comportement |
|---|---|---|
| **100 % → 70 %** | Conversion | Les disciples cherchent les sceptiques gris. Ils ignorent les cristaux hors trajet. |
| **70 % → 40 %** | Mixte (peinture + conversion) | Ils vont vers le cristal le plus proche, mais convertissent tout gris rencontré en chemin. |
| **≤ 40 %** | Cristaux de peinture | Priorité absolue à la recharge. Un gris sur la route peut être converti si le détour reste marginal ; sinon ignoré. |

**Règle de détour opportuniste** (paliers mixte et bas) : un objectif secondaire n'est pris que si dévier vers lui ajoute **≤ 25 %** de distance au trajet vers l'objectif primaire. Comportement lisible en une phrase : *« ils vont chercher ce qui manque, sans ignorer ce qu'ils croisent. »*

**Portage** : un cristal ramassé est instantanément converti en peinture dans la jauge du Leader. Aucun état intermédiaire — la mort d'un disciple ne fait donc rien perdre.
