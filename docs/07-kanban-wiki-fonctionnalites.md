# KanZen : écarts fonctionnels Kanban et Wiki, lots 1 à 3

> Version 2.0 du 2026-11-26 (KanZen 3.2.0). Base : branche 3.1.0 (PR #3). Référence : Trello, Wekan, Jira, ClickUp, monday pour le Kanban ; Outline, Docmost, Confluence, Notion pour le Wiki.
> Tout fonctionne hors ligne : aucune ressource externe à l'exécution. Une seule nouvelle dépendance (Mermaid, lot 3), embarquée dans le paquet.

## 1. Matrice des écarts (priorisée par valeur utilisateur)

### Kanban
| # | Écart | Présent chez | Valeur | Lot |
|---|---|---|---|---|
| K1 | Étiquettes nommées par tableau | Trello, Wekan, Jira | Élevée | **1 (livré)** |
| K2 | Priorité (basse à critique) et date de début | Jira, ClickUp, Wrike | Élevée | **1 (livré)** |
| K3 | Archiver / restaurer une carte | Trello, Wekan | Élevée | **1 (livré)** |
| K4 | Journal d'activité de la carte | Trello, Jira | Élevée | **1 (livré)** |
| K5 | Dupliquer une carte, la déplacer vers un autre tableau | Trello, Wekan | Moyenne | **1 (livré)** |
| K6 | Réordonner les colonnes par glisser-déposer (souris et clavier) | Trello, Wekan | Moyenne | **1 (livré)** |
| K7 | Modifier son commentaire | partout | Moyenne | **1 (livré)** |
| K8 | Vue Liste (tableau triable) | monday, ClickUp, Notion | Élevée | **2 (livré)** |
| K9 | Dépendances « bloque / bloqué par » | Jira, ClickUp, Wrike | Moyenne | **2 (livré)** |
| K10 | Vue Timeline / Gantt (début → échéance) | Wrike, monday, Bubble Plan | Élevée, effort élevé | **3 (livré)** |
| K11 | Champs personnalisés, estimation | monday, ClickUp | Moyenne | **3 (livré)** |
| K12 | Couloirs (swimlanes) | Wekan, Jira | Faible | plus tard |

### Wiki
| # | Écart | Présent chez | Valeur | Lot |
|---|---|---|---|---|
| W1 | Commentaires de page (fils, réponses, résolution) | Outline, Docmost, Confluence | Élevée | **1 (livré)** |
| W2 | Page vérifiée : propriétaire, revue périodique, liste « À revoir » | Confluence, Notion, Guru | Élevée | **1 (livré)** |
| W3 | Modèles de page créés par l'équipe | Outline, Notion, Confluence | Élevée | **1 (livré)** |
| W4 | Dupliquer une page (avec ses sous-pages) | Notion, Outline | Moyenne | **1 (livré)** |
| W5 | Mise en page d'impression / PDF soignée | Outline, Confluence | Moyenne | **2 (livré)** |
| W6 | Bloc « sous-pages » et pages liées dans l'éditeur | Confluence, Notion | Moyenne | **2 (livré)** |
| W7 | Diagrammes Mermaid embarqués (sans CDN) | Docmost, Outline | Moyenne, nouvelle dépendance | **3 (livré)** |

Hors périmètre de ce document (prévus au plan d'optimisation, `06-plan-optimisation.md`) : « Mes tâches », notifications et mentions, résumé e-mail, recherche unifiée.

## 2. Ce que le lot 1 apporte aux utilisateurs

**Kanban**
- Bouton **Étiquettes** du tableau : créer, renommer, recolorer, supprimer (10 couleurs, contraste AA). Les étiquettes s'affichent sur les cartes et filtrent le tableau (filtre « Étiquette » ajouté à la barre de filtres, comme « Priorité »).
- Fiche de la carte : **priorité**, **date de début** (contrôlée : avant l'échéance), étiquettes.
- **Archiver** une carte la retire du tableau sans la perdre. Bouton **Archives (n)** : recherche et restauration. Les cartes archivées sortent des statistiques, de l'agenda et de l'export CSV.
- Onglet **Activité** : qui a créé, déplacé, modifié (avant → après), commenté, joint un fichier, archivé.
- **Dupliquer** (copie juste en dessous, liste de contrôle décochée, pratique pour les tâches récurrentes) et **Déplacer vers un tableau…** du même espace (étiquettes reprises par nom).
- Poignée sur chaque colonne pour la **réordonner** à la souris ou au clavier (Espace, flèches, Espace).
- **Modifier son commentaire** (mention « modifié »). Seul l'auteur peut le faire, propriétaire d'espace compris.

**Wiki**
- **Commentaires** en pied de page : fils de discussion, réponses, « Résoudre » / « Rouvrir » (une réponse rouvre un fil résolu). Lecture pour tous les membres, écriture pour les éditeurs. Les pages restreintes restent étanches.
- **Vérification** (menu « … » ou badge sous le titre) : propriétaire garant du contenu, revue tous les 1, 3, 6 ou 12 mois, bouton « Je confirme que la page est à jour ». Badge vert « Vérifiée » ou orange « À revoir ». L'accueil du wiki liste les pages **À revoir** et **les pages dont je suis propriétaire**. Chaque vérification est tracée dans l'audit (`wiki.verify`).
- **Enregistrer comme modèle…** : le modèle apparaît pour toute l'équipe dans « Nouvelle page », section « Modèles de l'équipe ». Les images et fichiers ne sont pas repris (ils restent attachés à la page d'origine).
- **Dupliquer** / **Dupliquer avec les sous-pages** : fichiers copiés (copie indépendante), restriction d'accès reprise à l'identique, sous-pages invisibles pour l'utilisateur non copiées.

## 3. Ce que les lots 2 et 3 apportent

**Kanban**
- **Vues** Tableau, **Liste** et **Chronologie** (boutons en haut du tableau, vue gardée dans l'adresse). Les filtres s'appliquent aux trois vues.
  - Liste : tableau trié par n'importe quelle colonne (titre, colonne, priorité, étiquettes, assignés, dates, estimation, champs personnalisés), valeurs vides toujours en fin de liste.
  - Chronologie : barre de la date de début à l'échéance, échelles jour / semaine / mois, ligne « aujourd'hui », flèches de dépendance, couleur selon l'état (en cours, bloquée, en retard, terminée). Un clic ouvre la carte.
- **Dépendances** : « bloquée par » une autre carte du même espace (recherche par titre, tous tableaux de l'espace). Badge **Bloquée** sur la carte tant qu'une carte bloquante n'est ni archivée ni dans la dernière colonne de son tableau. Cycles refusés. Liste « Bloque » sur la carte bloquante.
- **Champs personnalisés** par tableau (bouton **Champs**, 20 au plus) : texte, nombre, date, liste de choix, case à cocher. Saisie dans la fiche, affichage en Liste, export CSV (une colonne par champ, injection de formule neutralisée). Une option retirée efface les valeurs qui l'utilisaient. Les valeurs suivent la carte dupliquée, et la carte transférée vers un tableau qui a un champ de même nom et de même type.
- **Estimation** (nombre libre : points, heures ou jours selon la convention de l'équipe), somme Σ en tête de colonne, colonne de l'export CSV.
- Journal d'activité : dépendances ajoutées ou retirées, champs modifiés (avant → après), estimation.

**Wiki**
- Menu « / » : **Sommaire** (titres de la page, mis à jour en direct), **Sous-pages** (trois niveaux, limité aux pages visibles par le lecteur), **Diagramme** (Mermaid : organigramme, séquence, Gantt, états, classes…).
- Diagrammes Mermaid : le code reste un bloc de code (`mermaid`), donc il passe tel quel à l'export Markdown et à la recherche. En lecture, seul le diagramme s'affiche, avec « Voir le code ». Rendu en mode `strict` (pas de HTML ni de lien JavaScript dans les diagrammes, SVG assaini), bibliothèque chargée à la première utilisation, servie par KanZen.
- **Impression / PDF** : A4 paginé (« page n / N »), en-tête de provenance (chemin, version, auteur, date de vérification, date et auteur de l'impression), mention **DIFFUSION RESTREINTE** pour une page à accès restreint, adresse des liens externes reprise en clair, blocs non coupés entre deux pages, menus, commentaires et panneaux annexes masqués. Corrige au passage l'impression tronquée à la hauteur de l'écran.

## 4. Points techniques et d'exploitation

- Migration `20261126120000_kanban_wiki_lot1` : ajouts uniquement (colonnes nullables ou avec valeur par défaut, nouvelles tables). Appliquée automatiquement par `migrate deploy` au démarrage du service ; retour arrière par `dnf downgrade` sans perte (les nouvelles colonnes sont ignorées par la version précédente).
- Nouvelles routes : `/boards/:id/labels`, `/labels/:id`, `/tasks/:id/{archive,restore,duplicate,transfer,activity}`, `/boards/:id/archived`, `PATCH /comments/:id` ; wiki : `/wiki/pages/:id/{comments,verification,verify,duplicate}`, `/wiki/comments/:id[/resolve]`, `/workspaces/:id/wiki/{templates,review}`, `/wiki/templates/:id`. Toutes passent par le contrôle d'accès par espace (`authz`) et, pour le wiki, par les restrictions de page.
- Le déplacement de carte reste transactionnel (verrou de colonne, rééquilibrage des positions de la 3.1.0) ; les cartes archivées ne comptent plus parmi les voisines.
- Tests : `test/lot1.test.js` (14 tests d'API : droits, cloisonnement entre espaces, pages restreintes, assainissement des modèles), `test/e2e/lot1.mjs` (parcours navigateur complet, ajouté à `npm run test:e2e`).
- Lots 2 et 3 : migration `20261126140000_kanban_wiki_lot2_3`, ajouts uniquement (tables `BoardField`, `TaskFieldValue`, `TaskDependency`, colonne `Task.estimate`). Même procédure et même retour arrière que le lot 1.
- Nouvelles routes : `/boards/:id/fields`, `/fields/:id`, `/tasks/:id/fields/:fieldId`, `/tasks/:id/dependencies[/:blockerId]`. La recherche de cartes de l'espace (`/workspaces/:id/tasks`) exclut désormais les cartes archivées.
- Valeur d'un champ : contrôlée par type côté serveur, sans conversion implicite (« 42 » saisi dans un champ texte reste un texte).
- Nouveaux nœuds du document wiki `toc` et `subpages`, sans attribut, ajoutés à la liste blanche du serveur.
- Dépendance **mermaid 12.2.0** (version figée ; la 11.x tirait une version de KaTeX visée par un avis de sécurité de faible gravité). `npm audit` : 0 vulnérabilité. Elle figure au SBOM ; `packaging/build.sh` la retire du `node_modules` serveur, car elle n'est utilisée que dans le navigateur (≈ 140 Mo économisés), puis vérifie que le serveur se charge.
- Tests : `test/lot23.test.js` (10 tests : droits, cycles, cloisonnement entre espaces, validation des champs, CSV, duplication et transfert, nœuds du wiki), `test/e2e/lot23.mjs` (parcours navigateur, ajouté à `npm run test:e2e`, contrôle de la feuille d'impression et de l'absence d'erreur CSP).
- Correctif au passage : les champs de la barre de filtres du tableau prenaient toute la largeur (classe `w-full` de `input` prioritaire sur `w-56`).
