# KanZen : écarts fonctionnels Kanban et Wiki, lot 1

> Version 1.0 du 2026-11-26. Base : branche 3.1.0 (PR #3). Référence : Trello, Wekan, Jira, ClickUp, monday pour le Kanban ; Outline, Docmost, Confluence, Notion pour le Wiki.
> Tout fonctionne hors ligne : aucune nouvelle dépendance npm, aucune ressource externe.

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
| K8 | Vue Liste (tableau triable) | monday, ClickUp, Notion | Élevée | 2 |
| K9 | Dépendances « bloque / bloqué par » | Jira, ClickUp, Wrike | Moyenne | 2 |
| K10 | Vue Timeline / Gantt (début → échéance) | Wrike, monday, Bubble Plan | Élevée, effort élevé | 3 |
| K11 | Champs personnalisés, estimation | monday, ClickUp | Moyenne | 3 |
| K12 | Couloirs (swimlanes) | Wekan, Jira | Faible | plus tard |

### Wiki
| # | Écart | Présent chez | Valeur | Lot |
|---|---|---|---|---|
| W1 | Commentaires de page (fils, réponses, résolution) | Outline, Docmost, Confluence | Élevée | **1 (livré)** |
| W2 | Page vérifiée : propriétaire, revue périodique, liste « À revoir » | Confluence, Notion, Guru | Élevée | **1 (livré)** |
| W3 | Modèles de page créés par l'équipe | Outline, Notion, Confluence | Élevée | **1 (livré)** |
| W4 | Dupliquer une page (avec ses sous-pages) | Notion, Outline | Moyenne | **1 (livré)** |
| W5 | Mise en page d'impression / PDF soignée | Outline, Confluence | Moyenne | 2 |
| W6 | Bloc « sous-pages » et pages liées dans l'éditeur | Confluence, Notion | Moyenne | 2 |
| W7 | Diagrammes Mermaid embarqués (sans CDN) | Docmost, Outline | Moyenne, nouvelle dépendance | 3 |

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

## 3. Points techniques et d'exploitation

- Migration `20261126120000_kanban_wiki_lot1` : ajouts uniquement (colonnes nullables ou avec valeur par défaut, nouvelles tables). Appliquée automatiquement par `migrate deploy` au démarrage du service ; retour arrière par `dnf downgrade` sans perte (les nouvelles colonnes sont ignorées par la version précédente).
- Nouvelles routes : `/boards/:id/labels`, `/labels/:id`, `/tasks/:id/{archive,restore,duplicate,transfer,activity}`, `/boards/:id/archived`, `PATCH /comments/:id` ; wiki : `/wiki/pages/:id/{comments,verification,verify,duplicate}`, `/wiki/comments/:id[/resolve]`, `/workspaces/:id/wiki/{templates,review}`, `/wiki/templates/:id`. Toutes passent par le contrôle d'accès par espace (`authz`) et, pour le wiki, par les restrictions de page.
- Le déplacement de carte reste transactionnel (verrou de colonne, rééquilibrage des positions de la 3.1.0) ; les cartes archivées ne comptent plus parmi les voisines.
- Tests : `test/lot1.test.js` (14 tests d'API : droits, cloisonnement entre espaces, pages restreintes, assainissement des modèles), `test/e2e/lot1.mjs` (parcours navigateur complet, ajouté à `npm run test:e2e`).
- Correctif au passage : les champs de la barre de filtres du tableau prenaient toute la largeur (classe `w-full` de `input` prioritaire sur `w-56`).
