# KanZen : plan d'optimisation (performance, UX, adoption)

> Version 1.0 du 2026-11-25. Base analysée : branche de la PR #1 (`claude/project-thread-5ozt9v`, commit `37d99a5`), cible de production RHEL 9.6 hors ligne (PR #2).
> Posture : chef d'équipe N3 / projets SI, avec un regard produit, UX et architecture. Toutes les propositions sont compatibles réseau fermé : aucun SaaS, aucune télémétrie sortante, aucune dépendance CDN.

---

## 0. Synthèse pour décision

KanZen est sain sur le plan sécurité (sessions serveur, CSRF, CSP stricte, autorisation par espace, durcissement systemd). Les gains rapides sont ailleurs, sur trois points :

1. **Le poids du front livré au navigateur.** Aucune compression HTTP et aucun cache long sur les assets : chaque poste télécharge 794 kB de JS non compressé à l'ouverture, et 923 kB de plus en entrant dans le wiki. Trois corrections (chargement différé des routes, assets servis par nginx en `gzip_static`, cache `immutable`) divisent ce coût par 3 à 7. **Une demi-journée de travail.**
2. **Le temps réel en « tout recharger ».** Chaque modification d'une carte fait recharger le tableau complet par tous les clients connectés, y compris l'auteur. Ça passe à 5 utilisateurs, ça coûte cher à 50 sur un gros tableau. Correctif simple (anti-rebond, exclusion de l'émetteur, resynchronisation à la reconnexion), puis évolution vers des événements différentiels.
3. **Les frictions qui freinent l'adoption.** Impossible d'ajouter à un espace un collègue AD qui ne s'est jamais connecté, pas de vue « Mes tâches », pas de notification, recherche limitée au wiki. Ce sont les vraies causes de non-rétention d'un outil interne : si l'outil ne vient pas chercher l'utilisateur, l'équipe retourne au fichier Excel partagé.

Recommandation : **lancer les 12 Quick Wins en 3 lots sur environ 3 semaines** (section 4), livrés en version 3.1.0 via le circuit RPM habituel, puis arbitrer les 3 Major Projects (notifications, temps réel différentiel, recherche unifiée) au comité suivant, sur la base des indicateurs mesurés pendant les Quick Wins.

---

## 1. Constats mesurés (base factuelle)

### 1.1 Front-end (build Vite 8, mesuré le 2026-11-25)

| Chunk | Brut | gzip | Contenu principal |
|---|---:|---:|---|
| `index-*.js` (chargé à l'ouverture) | **793,6 kB** | 235,0 kB | React, router, dnd-kit, socket.io-client, date-fns, **recharts + d3 + redux-toolkit (~390 kB) pour la seule page Statistiques** |
| `Wiki-*.js` (chargé à l'entrée dans le wiki) | **922,6 kB** | 286,4 kB | TipTap/ProseMirror (~317 kB), collaboration Yjs (~120 kB), highlight.js + lowlight (~118 kB), marked (53 kB), diff (8 kB) |
| CSS | 42,3 kB | 7,7 kB | Tailwind |

Note : le chiffre d'environ 1 Mo pour `index` vient d'un build antérieur ; sur le lockfile actuel il est de 794 kB. Le constat reste le même : avertissement de taille de chunk sur les deux bundles.

Le wiki est **déjà** chargé à la demande (`App.jsx`, `lazy(() => import('./components/wiki/Wiki'))`). En revanche `BoardStats`, `CalendarView` et `Admin` sont importés de façon statique.

**Test réalisé :** en passant ces trois routes en `lazy()` (3 lignes dans `App.jsx`), le chunk initial tombe à **337,7 kB (105,8 kB gzip), soit −57 %** ; recharts part dans un chunk `BoardStats` chargé uniquement sur la page Statistiques.

### 1.2 Diffusion des assets

- `packaging/files/nginx/kanzen.conf` : **pas de `gzip`, pas de `gzip_static`, pas de règle de cache.** Tout est relayé vers Node.
- `src/server/app.js` : `@fastify/static` avec les options par défaut (`Cache-Control: public, max-age=0`), donc une revalidation ETag par fichier et par chargement. Pas de `@fastify/compress`.
- Conséquence : 1,7 Mo de JS en clair pour un premier accès au wiki. Sur le LAN du siège, ça passe ; sur un site distant derrière un lien MPLS ou un VPN, c'est 2 à 5 secondes d'écran blanc.

### 1.3 Temps réel (`realtime.js`, `KanbanBoard.jsx`)

- Le serveur émet `board:updated { boardId, reason }` vers tout le salon, **émetteur compris**.
- Chaque client reçoit l'événement et rejoue `GET /boards/:id`, qui charge colonnes, tâches, assignés, sous-tâches et compteurs. Sans anti-rebond : un déplacement suivi d'une édition donne deux rechargements complets par client.
- À la reconnexion (`connect`), le client rejoint le salon **sans recharger** : les modifications faites pendant une coupure (veille du poste, bascule Wi-Fi, redémarrage du service) ne sont pas rattrapées. L'écran reste faux jusqu'à la prochaine modification.
- Ordre de grandeur : 30 personnes sur un tableau de 300 cartes, un rythme de 1 modification toutes les 5 secondes en réunion de pilotage, cela donne environ 6 rechargements complets par seconde pour PostgreSQL et Node. C'est soutenable, mais c'est du gaspillage pur, et la latence perçue en souffre.

### 1.4 API et base de données

- **Coût fixe par requête :** 1 requête de session (`sessions.resolve`, plus une écriture `lastSeenAt` par minute) et 2 requêtes d'autorisation (`authz.check` : résolution ressource → espace, puis rôle). Ce n'est pas un problème à faible charge, mais il pèse sur les routes appelées en rafale (déplacements, sous-tâches).
- **`POST /tasks/:id/move`** : 6 à 8 allers-retours SQL **hors transaction** (contrôle d'accès, tâche, colonne cible, voisins, mise à jour, événement). Deux déplacements concurrents dans la même colonne peuvent produire des positions incohérentes.
- **Positions fractionnaires sans rééquilibrage** : on insère au milieu (`(above + below) / 2`). Après environ 50 insertions successives au même endroit, la précision d'un `double` est épuisée et deux cartes prennent la même position, ce qui rend l'ordre instable. C'est un bug latent, pas une hypothèse.
- **Index manquants pour les requêtes réelles :**
  - statistiques : `TaskEvent WHERE toColumnId IN (…) AND timestamp >= …` alors qu'il n'existe que des index séparés `taskId` et `timestamp` ;
  - tri des cartes : `Task WHERE columnId ORDER BY position`, avec un index `columnId` seul ;
  - commentaires : `WHERE taskId ORDER BY createdAt`.
- **Croissance non bornée** : `AuditLog` (pas de rétention), `WikiRevision` (un instantané JSON complet à chaque enregistrement, sans politique de rétention), `TaskEvent`.
- Pool `pg` par défaut (10 connexions), non paramétrable.

### 1.5 Identité et cycle de vie des comptes (angle RSSI)

- `GET /users/lookup` ne cherche **que dans la base locale**. Un compte AD n'existe dans KanZen qu'après sa première connexion (provisionnement à la volée dans `routes/auth.js`). **Un propriétaire d'espace ne peut donc pas ajouter un collègue qui ne s'est jamais connecté.** C'est la friction numéro 1 au démarrage d'un projet.
- Inversement, **pas de déprovisionnement** : un agent retiré du groupe `GG_KanZen_Users` ou désactivé dans l'AD garde sa session jusqu'à 60 min d'inactivité ou 8 h, et son compte reste actif, visible et assignable dans KanZen. Le contrôle n'a lieu qu'à la connexion suivante. C'est un écart sur le processus arrivées / mutations / départs (JML).

### 1.6 UX et accessibilité

- **Conflit clavier sur les cartes** : `TaskCard` ouvre la tâche sur `Entrée`, alors que le `KeyboardSensor` de dnd-kit démarre aussi un glisser sur `Entrée` (et `Espace`). Au clavier, on obtient un comportement aléatoire.
- **Badge « en retard » sur les tâches terminées** : `TaskCard` utilise `isPast(dueDate)` quelle que soit la colonne, alors que le serveur (stats) exclut à juste titre la dernière colonne. Une colonne « Terminé » pleine de rouge envoie un mauvais signal.
- `Column.jsx` : renommer, régler la limite WIP et supprimer passent par `window.prompt` et `window.confirm`. La suppression d'une colonne efface ses tâches **sans corbeille** (le wiki, lui, en a une).
- `Modal` : `Échap` fonctionne, mais il n'y a ni piège de focus ni retour du focus à l'élément d'origine (RGAA 7.1 / 12.8).
- Contraste : `text-gray-400` sur fond blanc (≈ 2,9:1) est utilisé pour des icônes porteuses d'information et des libellés. C'est en dessous du seuil AA de 4,5:1 (et 3:1 pour les composants).
- Recherche globale : le champ du bandeau ne cherche que **dans le wiki**, pas dans les tâches.
- Pas de vue transverse « Mes tâches » hors agenda, pas de filtre sur un tableau, pas de raccourcis clavier en dehors de l'éditeur.
- Wiki : enregistrement **explicite** uniquement (Ctrl+S, garde `beforeunload`). En co-édition, si le dernier éditeur ferme l'onglet sans enregistrer, le document Yjs en mémoire est détruit (`wikiCollab.js`) et le travail est perdu.
- États vides minimalistes (« Aucun espace. Créez-en un… ») : pas de modèle, pas de parcours de démarrage.

### 1.7 Exploitation

- `/api/health` fait un `SELECT 1`. C'est bien pour la vivacité, mais il n'y a aucune métrique (latence, erreurs, sockets ouverts, taille du pool) exploitable par la supervision interne (Centreon, Zabbix ou Prometheus selon le SI).

---

## 2. Propositions actionnables par pilier

Chaque proposition porte un identifiant repris dans la matrice et la roadmap.

### 2.1 Performance & Tech

**T1. Chargement différé des routes secondaires** *(mesuré)*
`App.jsx` : passer `BoardStats`, `CalendarView`, `AdminUsers` et `AdminAudit` en `lazy()`, comme le wiki. Gain mesuré : chunk initial de 794 kB à 338 kB (gzip de 235 kB à 106 kB). Ajouter `build.chunkSizeWarningLimit` **uniquement** après T2, pour ne pas masquer le signal.

**T2. Découpage du chunk Wiki : lecture d'abord, édition ensuite**
- `marked` (import Markdown) et `diff` (historique) : `import()` dynamique au moment de l'action. Environ −60 kB, effort faible.
- Collaboration (`@tiptap/extension-collaboration*`, `yjs`, `y-protocols`) : charger uniquement en mode édition. Environ −120 kB pour les lecteurs.
- Coloration syntaxique : enregistrer les langages highlight.js à la demande (registre asynchrone par langage détecté dans la page). Environ −90 kB.
- Étape 2 (Major) : **rendu lecture sans éditeur**. Le contenu est déjà un JSON ProseMirror validé côté serveur (`lib/wikidoc.js`) ; un rendu HTML côté serveur ou un rendu React léger en lecture seule évite de charger TipTap (~320 kB) pour les 80 % de visites en consultation.
Objectif : chunk wiki en lecture < 350 kB brut, < 110 kB gzip.

**T3. Assets servis par nginx : précompression et cache immuable** *(compatible air-gap)*
- Au build (`packaging/build.sh`) : générer les `.gz` de `public/assets/*` avec `gzip -9 -k` (aucune dépendance npm à ajouter). Le module `gzip_static` est compilé dans le nginx de RHEL 9 et dans celui de Debian ; brotli ne l'est pas sur RHEL, donc on ne le retient pas.
- `kanzen.conf` :
  ```nginx
  location /assets/ {
      alias /opt/kanzen/app/public/assets/;
      gzip_static on;
      expires 1y;
      add_header Cache-Control "public, max-age=31536000, immutable" always;
      add_header X-Content-Type-Options nosniff always;
      access_log off;
  }
  # Réponses API JSON compressées à la volée (pas de secret reflété dans les corps, risque BREACH négligeable ici)
  gzip on;
  gzip_types application/json text/css application/javascript image/svg+xml;
  gzip_min_length 1024;
  ```
  `index.html` reste servi par Node avec les en-têtes Helmet (CSP), en `Cache-Control: no-cache`, pour qu'une mise à jour RPM soit prise immédiatement.
- SELinux (RHEL 9.6) : `public/` doit porter le contexte `httpd_sys_content_t` (`semanage fcontext -a -t httpd_sys_content_t '/opt/kanzen/app/public(/.*)?'` puis `restorecon`), à ajouter au `%post` du RPM et à `docs/05-deploiement-rhel96.md`.
- Gain : environ −70 % d'octets transférés au premier accès et **zéro requête d'asset** aux accès suivants. Node est déchargé du service de fichiers statiques.

**T4. Temps réel : anti-rebond, exclusion de l'émetteur, rattrapage à la reconnexion**
- Client : regrouper les rechargements (anti-rebond de 250 ms) et recharger sur `socket.io.on('reconnect')`.
- Client → serveur : envoyer l'identifiant de socket dans un en-tête `X-Socket-Id` sur les écritures ; serveur : `io.to(room).except(socketId).emit(...)`. L'auteur garde sa mise à jour optimiste, sans rechargement superflu.
- Gain attendu : −50 à −80 % de `GET /boards/:id` en réunion, et fin des écrans faux après une veille.

**T5. Temps réel différentiel** *(Major)*
Émettre la donnée modifiée (`task:moved {id, columnId, position}`, `task:updated {task}`, `column:*`) et l'appliquer localement, en gardant le rechargement complet comme filet de sécurité (numéro de version du tableau : si on détecte un trou, on recharge tout). C'est le pré-requis pour tenir 100 utilisateurs ou plus sur un même tableau, et pour un futur mode multi-instance (adaptateur Socket.io PostgreSQL `@socket.io/postgres-adapter`, qui n'ajoute pas de Redis au périmètre).

**T6. Déplacement transactionnel et rééquilibrage des positions**
`POST /tasks/:id/move` : tout passer dans `prisma.$transaction`, avec verrou de la colonne cible (`SELECT … FOR UPDATE`). Si l'écart entre voisins passe sous `1e-6`, renuméroter la colonne (pas de 1000) dans la même transaction. Ajouter un test vitest « 60 insertions au même endroit ». C'est autant de la **fiabilité** que de la performance.

**T7. Index et hygiène PostgreSQL**
Migration Prisma :
```prisma
model TaskEvent { @@index([toColumnId, timestamp]) }
model Task      { @@index([columnId, position]) }   // remplace @@index([columnId])
model Comment   { @@index([taskId, createdAt]) }    // remplace @@index([taskId])
```
Puis activer `pg_stat_statements` (package `postgresql-contrib` déjà dans les miroirs RHEL) et le vérifier sur un jeu de données de volumétrie réaliste (`EXPLAIN (ANALYZE, BUFFERS)`) avant et après. Paramètres conseillés pour une VM de 4 vCPU et 8 Go : `shared_buffers=2GB`, `effective_cache_size=6GB`, `work_mem=16MB`, `idle_in_transaction_session_timeout=60s`, `log_min_duration_statement=500ms`.

**T8. Rétention des données qui grossissent**
- `AuditLog` : rétention paramétrable (`AUDIT_RETENTION_DAYS`, 365 par défaut), purge quotidienne. Le journal reste aussi exporté vers journald et le SIEM, qui fait foi.
- `WikiRevision` : garder les 50 dernières versions, puis une par jour au-delà de 30 jours. Purge par tâche planifiée.
- Ajout à `kanzenctl` : `kanzenctl db-stats` (taille des tables, nombre de lignes) pour le N2/N3.

**T9. Cache court des autorisations et pool paramétrable**
- Mémo de `workspaceRole(user, ws)` sur 10 secondes (LRU en mémoire, invalidé à chaque modification de membres), et résolution ressource → espace en une seule requête SQL. Cela enlève 1 à 2 requêtes par appel d'API.
- `DATABASE_POOL_MAX` (défaut 10) exposé dans `kanzen.env`, pour aligner sur `max_connections` de PostgreSQL.

**T10. Métriques internes pour la supervision**
Endpoint `/metrics` au format Prometheus (`prom-client`, embarqué dans le bundle), **écoutant uniquement sur 127.0.0.1 ou protégé par jeton**, non publié par nginx : latence par route (histogramme), erreurs 5xx, sockets ouverts, sessions actives, taille du pool, requêtes lentes. Template de supervision fourni (Zabbix HTTP agent ou scrape Prometheus). Aucune donnée ne sort du réseau.

**T11. Synchronisation AD et déprovisionnement (JML)**
Tâche planifiée `kanzen-adsync.timer` (toutes les 15 min) :
- les comptes `LDAP` absents du groupe d'accès ou désactivés dans l'AD (`userAccountControl` bit 2) sont désactivés dans KanZen et leurs sessions purgées, avec une entrée d'audit `user.deprovision` ;
- les attributs `displayName` et `mail` sont rafraîchis.
C'est un **impératif de conformité** autant qu'une optimisation : la fenêtre d'exposition d'un départ passe de « jusqu'à 8 h et compte toujours assignable » à 15 min au plus.

### 2.2 UX/UI & Conversion

Ici, « conversion » veut dire qu'un nouvel arrivant devient un utilisateur actif dans la semaine, et qu'un projet démarre dans KanZen plutôt que dans Excel.

**U1. Ajout de membres depuis l'AD (pré-provisionnement)**
Quand LDAP est actif, `GET /users/lookup` interroge aussi l'AD, **restreint aux membres du groupe d'accès** (filtre `memberOf:1.2.840.113556.1.4.1941:=<groupe>`, compte de service déjà en place), et crée le compte KanZen à l'ajout dans l'espace (`authSource=LDAP`, `externalId=objectGUID`, audit `user.provision`). Limiter à 20 résultats, appliquer un minimum de 3 caractères et une limite de débit. **C'est la friction n°1 au lancement d'un projet.**

**U2. Modèles d'espace et parcours de démarrage**
À la création d'un espace, proposer des modèles adaptés au SI :
- « Projet SI » : colonnes *À cadrer / Prêt / En cours / Recette / Terminé*, avec les pages wiki *Fiche projet*, *Comptes rendus*, *Décisions (ADR)*, *Risques* ;
- « Run N3 / incidents » : *Entrant / Analyse / Attente tiers / Résolu*, avec les pages *Procédures* et *Post-mortems* ;
- « Changements (CAB) » : *Demandé / Évalué / Approuvé / Planifié / Réalisé / Clos*.
Côté wiki, des modèles de page existent déjà (`components/wiki/templates.js`) : on réutilise le mécanisme. Au premier accès, un état vide actionnable (« Créer votre premier espace à partir d'un modèle ») remplace la phrase actuelle.

**U3. Vue « Mes tâches »**
Nouvelle route `/me` et entrée dans la barre : tâches qui me sont assignées dans tous les espaces, groupées par *En retard / Aujourd'hui / Cette semaine / Plus tard / Sans échéance*, avec un lien direct vers la carte (`/b/:id?task=…` existe déjà). Côté serveur, la requête de `/calendar?mine=true` sert de base. C'est **la page d'accueil naturelle d'un ingénieur N3** : elle doit devenir la page d'atterrissage, réglable par l'utilisateur.

**U4. Filtres et raccourcis sur le tableau**
Barre de filtres côté client (assigné, couleur, échéance, texte, « mes cartes ») persistée dans l'URL (partageable). Raccourcis : `n` nouvelle carte, `/` filtre, `?` aide. Aucun coût serveur : le tableau est déjà chargé en entier.

**U5. Correctifs d'interaction et d'accessibilité (RGAA 4.1 / WCAG 2.1 AA)**
- Carte : `Entrée` ouvre, `Espace` déplace (restreindre `keyboardCodes.start` du `KeyboardSensor` à `Space`).
- Badge « en retard » masqué dans la dernière colonne (même règle que le serveur).
- `Modal` : piège de focus et retour du focus. Menus de colonne fermables par `Échap` et au clic extérieur.
- Contrastes : `text-gray-400` remplacé par `text-gray-500/600` sur fond clair pour les libellés et icônes porteuses de sens.
- `aria-live="polite"` pour annoncer les déplacements et erreurs (dnd-kit fournit `announcements`, à traduire en français).
Si l'organisme relève du secteur public, la déclaration d'accessibilité RGAA est une obligation légale : ces correctifs en sont le socle.

**U6. Remplacer `prompt` / `confirm` et ajouter l'annulation**
Renommage en place (double-clic sur le titre), limite WIP dans un petit popover, suppression de colonne avec toast « Annuler » pendant 8 secondes (suppression logique puis purge), cohérent avec la corbeille du wiki.

**U7. Retour immédiat et squelettes de chargement**
Création de carte optimiste (la carte apparaît avant la réponse serveur), squelettes de colonnes ou de page wiki à la place de « Chargement… », micro-animation à la fin d'un déplacement. Ce sont des détails, mais ils décident de la sensation « l'outil est rapide ».

**U8. Wiki : brouillon automatique et indicateur d'état**
- Brouillon local (IndexedDB) toutes les 5 secondes pendant l'édition, proposé à la réouverture.
- En co-édition : enregistrement automatique côté serveur quand le dernier éditeur quitte la page avec des modifications non enregistrées (le serveur dispose de l'état Yjs : `sanitizeDoc` puis enregistrement d'une révision avec l'auteur « co-édition »).
- Indicateur permanent « Enregistré / Modifications non enregistrées ». **Supprime le seul scénario de perte de données identifié.**

**U9. Recherche unifiée et palette `Ctrl+K`** *(Major)*
Index plein texte PostgreSQL sur `Task` (colonne générée `tsvector`, configuration `french`, comme pour le wiki), endpoint `/search` fusionnant tâches et pages (filtrées par droits), palette `Ctrl+K` pour la recherche et la navigation (espaces, tableaux, pages récentes, actions). Le libellé « Rechercher dans le wiki » disparaît.

### 2.3 Rétention & Croissance (adoption interne)

Pour un outil interne, « croissance » veut dire nombre d'équipes qui y gèrent réellement leurs projets, et « rétention » veut dire qu'elles y sont encore à J+90. Les leviers sont donc la boucle d'engagement (on m'assigne, je suis prévenu, je réponds dans l'outil) et la preuve de valeur (le management y trouve sa vision).

**G1. Centre de notifications in-app** *(Major, socle de la rétention)*
Modèle `Notification(userId, type, entityRef, readAt)`, émise à l'assignation, à la mention, au commentaire sur une carte suivie et à l'échéance J-1. Pastille dans la barre, liste avec « tout marquer comme lu », poussée temps réel par la socket existante (salon `user:<id>`). Préférences par type.

**G2. Mentions `@` dans les commentaires et le wiki**
L'infrastructure de suggestion existe dans l'éditeur (`@tiptap/suggestion`, `SuggestionList.jsx`) : on la réutilise pour `@utilisateur` (et `#tâche` côté wiki). Chaque mention déclenche une notification G1.

**G3. Résumé quotidien par e-mail via le relais SMTP interne**
Une fois par jour ouvré à 8 h : mes tâches en retard, celles du jour, les mentions non lues. Relais SMTP interne (variable `SMTP_URL`, TLS avec la PKI interne), désactivable par utilisateur. **C'est le principal levier de retour dans l'outil** pour les profils qui n'ont pas l'onglet ouvert en permanence.

**G4. Tableau de bord d'adoption (admin), respectueux du droit du travail**
Indicateurs **agrégés uniquement** : utilisateurs actifs à 7 et 30 jours (`lastLoginAt` existe), espaces actifs, cartes créées et déplacées par semaine (`TaskEvent`), pages wiki modifiées, délai médian « En cours → Terminé » par espace. Aucun classement nominatif. Un outil qui permet de mesurer l'activité individuelle des agents relève de l'information-consultation du CSE et doit figurer au registre RGPD : on documente la finalité (pilotage de l'adoption) et on l'écrit noir sur blanc dans le wiki d'accueil.

**G5. Boucle de retour utilisateur intégrée (dogfooding)**
Bouton « Suggérer / signaler » dans la barre, qui crée une carte dans un tableau « KanZen – Retours » géré par l'équipe produit (contexte joint : page, version, navigateur ; pas de capture automatique). On répond dans la carte, l'auteur est notifié (G1). Coût quasi nul, et cela montre aux utilisateurs que leurs retours sont traités.

**G6. « Quoi de neuf » après mise à jour**
À la première connexion après une montée de version (version lue dans `package.json`, exposée par `/api/health` ou `/api/auth/me`), un panneau court liste 3 nouveautés, avec un lien vers la page wiki du changelog. Cela fait connaître les fonctions livrées, qui sinon restent invisibles.

**G7. Tâches récurrentes**
Règle de récurrence sur une carte (hebdomadaire, mensuelle, trimestrielle, à date) qui recrée la carte dans la première colonne. Cas d'usage SI immédiats : revue hebdomadaire des comptes à privilèges, patch Tuesday, **renouvellement des certificats de la PKI**, test de restauration mensuel, revue des règles de pare-feu. Cela en fait l'outil du run, pas seulement des projets.

**G8. Lien direct et actions rapides sur une carte**
Bouton « Copier le lien » (l'URL `/b/:id?task=…` existe déjà) et « Copier en Markdown » (titre, lien, échéance) pour coller dans un ticket ou un compte rendu. Petit effort, mais cela fait circuler l'outil dans les autres canaux.

**G9. Intégrations SI internes** *(Major)*
- Webhook entrant authentifié par jeton : la supervision (Centreon / Zabbix) ou l'outil de tickets (GLPI) crée une carte dans un tableau « Run ».
- Webhooks sortants signés HMAC sur événements (carte terminée, etc.).
- Jetons d'API personnels à portée limitée, avec expiration et audit.
Cela ancre KanZen dans la chaîne d'outils du SI, ce qui le rend difficile à abandonner.

**G10. Réseau de référents et kit de lancement** *(organisationnel, sans code)*
Un référent par équipe, une session de prise en main de 30 minutes, une page wiki « Bien démarrer » pré-remplie dans le modèle d'espace (U2), et un point d'adoption mensuel appuyé sur G4.

---

## 3. Matrice de priorisation (Impact × Effort)

Règle de classement appliquée :
- **Quick Win** : impact Élevé ou Moyen, effort Faible.
- **Major Project** : impact Élevé, effort Moyen ou Élevé.
- **Fill-in** : impact Faible et effort Faible, ou impact Moyen et effort Moyen.
- **Thankless Task** : impact Faible ou Moyen, effort Élevé, ou impact Faible et effort Moyen.

Les efforts sont estimés pour un binôme (Dju + Claude), tests et documentation compris : Faible ≤ 1 jour, Moyen 2 à 5 jours, Élevé > 5 jours.

| # | Optimization Idea | Category | Expected Impact | Implementation Effort | Priority Quadrant |
|---|---|---|---|---|---|
| T1 | Chargement différé des routes Stats / Agenda / Admin (−57 % mesuré) | Tech | High | Low | **Quick Win** |
| T3 | nginx : `gzip_static`, cache `immutable` sur `/assets`, gzip JSON | Tech | High | Low | **Quick Win** |
| T4 | Temps réel : anti-rebond, exclusion de l'émetteur, rechargement à la reconnexion | Tech | High | Low | **Quick Win** |
| T6 | Déplacement transactionnel et rééquilibrage des positions | Tech | Medium | Low | **Quick Win** |
| T7 | Index composites et `pg_stat_statements` | Tech | Medium | Low | **Quick Win** |
| T2a | Wiki : `import()` dynamique de marked, diff, collab et langages highlight.js | Tech | Medium | Low | **Quick Win** |
| U5 | Correctifs clavier, accessibilité et badge « en retard » | UX | Medium | Low | **Quick Win** |
| U4 | Filtres et raccourcis sur le tableau | UX | High | Low | **Quick Win** |
| U8 | Wiki : brouillon automatique et enregistrement à la sortie du dernier éditeur | UX | High | Low | **Quick Win** |
| G8 | Copier le lien / copier en Markdown | Growth | Medium | Low | **Quick Win** |
| G5 | Bouton « Suggérer / signaler » vers un tableau de retours | Growth | Medium | Low | **Quick Win** |
| G6 | Panneau « Quoi de neuf » après mise à jour | Growth | Medium | Low | **Quick Win** |
| U1 | Ajout de membres depuis l'AD (pré-provisionnement) | UX | High | Medium | **Major Project** |
| T11 | Synchronisation AD et déprovisionnement (JML) | Tech | High | Medium | **Major Project** |
| U3 | Vue « Mes tâches » | UX | High | Medium | **Major Project** |
| U2 | Modèles d'espace (Projet SI, Run N3, CAB) et premier parcours | UX | High | Medium | **Major Project** |
| G1 | Centre de notifications in-app | Growth | High | High | **Major Project** |
| G2 | Mentions `@` (commentaires et wiki) | Growth | High | Medium | **Major Project** |
| G3 | Résumé quotidien par e-mail (SMTP interne) | Growth | High | Medium | **Major Project** |
| T5 | Temps réel différentiel (événements de données) | Tech | High | High | **Major Project** |
| T2b | Wiki : rendu lecture sans charger l'éditeur | Tech | High | High | **Major Project** |
| U9 | Recherche unifiée tâches + wiki et palette Ctrl+K | UX | High | High | **Major Project** |
| G7 | Tâches récurrentes | Growth | High | Medium | **Major Project** |
| T8 | Rétention AuditLog / WikiRevision, `kanzenctl db-stats` | Tech | Medium | Medium | Fill-in |
| T9 | Cache court des autorisations, pool PG paramétrable | Tech | Medium | Medium | Fill-in |
| T10 | Endpoint `/metrics` local pour la supervision | Tech | Medium | Medium | Fill-in |
| U6 | Remplacer prompt/confirm, annulation de suppression de colonne | UX | Medium | Medium | Fill-in |
| U7 | Création optimiste et squelettes de chargement | UX | Medium | Medium | Fill-in |
| G4 | Tableau de bord d'adoption agrégé (admin) | Growth | Medium | Medium | Fill-in |
| G10 | Réseau de référents et kit de lancement | Growth | Medium | Low | Quick Win *(hors code, à piloter en parallèle)* |
| G9 | Intégrations SI (webhooks, jetons d'API, GLPI / supervision) | Growth | Medium | High | Thankless Task *(à ce stade)* |

Lecture chef d'équipe :
- **G9 est classé Thankless aujourd'hui**, pas par manque d'intérêt : sans base d'utilisateurs actifs, les intégrations coûtent cher (sécurité des jetons, revue RSSI, maintenance des connecteurs) pour peu d'usage. Il repassera en Major Project quand G4 montrera au moins 3 équipes actives sur le run.
- **U1 et T11 sont des Major Projects « obligatoires »** : ils partagent le même code LDAP (recherche dans le groupe, `objectGUID`) et doivent être livrés ensemble, puisque le provisionnement sans déprovisionnement crée de la dette de sécurité.
- **Ordre recommandé des Major Projects** après les Quick Wins : U1+T11, puis U3, puis G1+G2, puis G3, puis U2, puis T5 et le reste. La boucle « je suis prévenu → je reviens » (G1 à G3) est ce qui retient les utilisateurs ; elle passe avant la performance différentielle.

---

## 4. Roadmap d'exécution des Quick Wins

### Principes
- **Mesurer avant et après** chaque lot : sans base de référence, on ne peut pas démontrer le gain au comité.
- **Une version mineure par lot** (3.0.1, 3.0.2, puis 3.1.0), livrée par le circuit standard : CI verte, SBOM, RPM/DEB signés, passage en recette, CAB, déploiement sur RHEL 9.6. Chaque lot est réversible par `dnf downgrade kanzen` ; seul le lot 2 contient une migration de schéma (index uniquement, donc sans perte en cas de retour arrière).
- **Pas de nouvelle dépendance npm** dans les Quick Wins, ce qui évite un nouveau cycle de revue SBOM et de mise à jour des miroirs internes.

### Étape 0 : base de référence (J1, ½ journée)
1. Construire la version actuelle et archiver la taille des chunks (`vite build` → `docs/perf/baseline-3.0.0.txt`).
2. Mesurer sur le poste type et le profil réseau d'un site distant (Chrome DevTools, profil « Fast 4G » pour simuler le pire lien WAN) : temps jusqu'au tableau interactif, puis jusqu'à une page wiki affichée, à froid et à chaud.
3. Activer `pg_stat_statements` en recette et lancer le scénario E2E existant (`npm run test:e2e`) pour obtenir le top 10 des requêtes.
4. Indicateurs d'adoption de départ (requête SQL ponctuelle) : comptes actifs à 7 et 30 jours, cartes créées par semaine.

**Livrable :** une page wiki « Performance – base 3.0.0 » dans l'espace de l'équipe.

### Lot 1 : poids du front et diffusion (S1, environ 2 jours) → 3.0.1
| Ordre | Action | Fichiers | Vérification |
|---|---|---|---|
| 1 | **T1** routes en `lazy()` | `src/client/src/App.jsx` | `index-*.js` < 350 kB ; E2E vert |
| 2 | **T2a** `import()` de marked, diff, collab et langages | `wiki/markdownImport.js`, `WikiPanels.jsx`, `WikiEditor.jsx`, `extensions.js` | chunk Wiki < 650 kB ; import Markdown, historique et co-édition testés à la main et en E2E |
| 3 | **T3** précompression au build et bloc nginx `/assets` | `packaging/build.sh`, `packaging/files/nginx/kanzen.conf`, `%post` RPM (contexte SELinux) | `curl -sI -H 'Accept-Encoding: gzip' …/assets/index-*.js` renvoie `Content-Encoding: gzip` et `Cache-Control: … immutable` ; `index.html` en `no-cache` ; `nginx -t` OK sur RHEL 9.6 (nginx 1.26) et Debian 12 |
| 4 | Documentation | `docs/03-packaging.md`, `docs/05-deploiement-rhel96.md` | relecture N2 |

**Critère de sortie :** transfert à froid divisé par au moins 3, aucun avertissement de taille sur `index`, rechargement à chaud sans requête d'asset.

### Lot 2 : fiabilité temps réel et base de données (S2, environ 3 jours) → 3.0.2
| Ordre | Action | Fichiers | Vérification |
|---|---|---|---|
| 1 | **T6** `move` transactionnel et rééquilibrage | `routes/tasks.js` | nouveau test vitest : 60 insertions au même endroit, ordre stable ; test de deux déplacements concurrents |
| 2 | **T4** anti-rebond, `except(socketId)`, rechargement à la reconnexion | `realtime.js`, `api.js` (en-tête `X-Socket-Id`), `KanbanBoard.jsx` | E2E à 2 navigateurs : l'auteur ne recharge pas, l'autre voit la modification en < 1 s ; coupure de 30 s rattrapée |
| 3 | **T7** migration d'index | `prisma/schema.prisma` + migration | `EXPLAIN ANALYZE` des stats et du chargement d'un tableau sur un jeu de 10 000 cartes : Index Scan, gain documenté |
| 4 | Mesure | — | nombre de `GET /boards/:id` par minute en scénario « réunion » : −50 % au moins |

Point d'attention exploitation : la migration d'index s'applique dans `ExecStartPre` (`migrate deploy`). Sur une base volumineuse, préférer un `CREATE INDEX CONCURRENTLY` manuel avant la mise à jour, puis marquer la migration comme appliquée (`prisma migrate resolve --applied`). Ce mode opératoire est à écrire dans la procédure.

### Lot 3 : UX et boucle de retour (S3, environ 4 jours) → 3.1.0
| Ordre | Action | Fichiers | Vérification |
|---|---|---|---|
| 1 | **U5** clavier, badge « en retard », focus des modales, contrastes, annonces en français | `TaskCard.jsx`, `KanbanBoard.jsx`, `ui.jsx`, `Column.jsx` | parcours complet au clavier ; audit Accessibilité de Lighthouse (intégré à Chromium, sans dépendance à ajouter) ≥ 95 |
| 2 | **U8** brouillon local et enregistrement automatique à la sortie du dernier éditeur | `wiki/Wiki.jsx`, `wikiCollab.js` | test : deux éditeurs, fermeture des deux onglets sans enregistrer, contenu retrouvé et révision créée |
| 3 | **U4** filtres et raccourcis | `KanbanBoard.jsx`, `Column.jsx` | filtres reflétés dans l'URL, lien partageable |
| 4 | **G8** copier le lien / copier en Markdown | `TaskDetail.jsx` | — |
| 5 | **G5** bouton « Suggérer / signaler » | `App.jsx` + paramètre `FEEDBACK_BOARD_ID` dans `kanzen.env` | carte créée avec le contexte |
| 6 | **G6** « Quoi de neuf » | `App.jsx`, version exposée par `/api/auth/me` | affiché une seule fois par version |

**En parallèle (hors code, à piloter par le chef de projet) : G10.** Désigner les référents, préparer la page wiki « Bien démarrer », planifier les sessions de prise en main pour la sortie de la 3.1.0.

### Étape finale : bilan et arbitrage (fin de S3 + 2 semaines d'usage)
- Rejouer les mesures de l'étape 0 et publier l'écart (page wiki « Performance – 3.1.0 »).
- Lire les cartes du tableau « KanZen – Retours » (G5) : premières données qualitatives réelles.
- Présenter au comité l'ordre des Major Projects (section 3), avec **U1 + T11** en tête : ils lèvent le principal frein d'adoption et ferment l'écart JML relevé par le RSSI.

### Indicateurs de suivi (sans télémétrie externe)
| Indicateur | Source | Cible après Quick Wins |
|---|---|---|
| Poids JS initial (gzip) | build CI | < 110 kB (aujourd'hui 235 kB) |
| Transfert à froid jusqu'au wiki (gzip) | build CI | < 400 kB (aujourd'hui 1,7 Mo non compressé) |
| `GET /boards/:id` par modification | logs nginx | ≤ nombre de clients − 1 (aujourd'hui = nombre de clients) |
| p95 de `POST /tasks/:id/move` | logs Fastify (`responseTime`) | < 80 ms |
| Utilisateurs actifs à 30 jours / comptes provisionnés | SQL `lastLoginAt` | à fixer après la base de référence |
| Retours G5 traités sous 10 jours ouvrés | tableau « Retours » | ≥ 80 % |

---

## Annexe : risques et points de vigilance

- **CSP et nginx** : servir `/assets` par nginx ne change pas la CSP, qui reste portée par `index.html` servi par Node. Ne pas déplacer `index.html` vers nginx sans y reporter les en-têtes Helmet.
- **BREACH** : la compression gzip des réponses JSON est acceptable ici (aucun jeton anti-CSRF dans les corps, cookie de session hors corps). Ne pas l'activer sur une future route qui refléterait un secret et une saisie utilisateur dans la même réponse.
- **U1 (recherche AD)** : limiter la recherche au groupe d'accès pour ne pas transformer KanZen en annuaire de tout l'AD. Appliquer une limite de débit et tracer les recherches dans l'audit si le RSSI le demande.
- **G3 (e-mail)** : le contenu des résumés (titres de tâches) peut être sensible. On envoie uniquement au relais interne et on propose une option « titres masqués, lien seulement ».
- **G4** : présenter le tableau de bord au DPO et au CSE avant ouverture.
- **FIPS (RHEL 9.6)** : aucune des propositions n'ajoute de cryptographie hors Node embarqué. La question FIPS déjà ouverte dans `docs/05-deploiement-rhel96.md` reste inchangée.
