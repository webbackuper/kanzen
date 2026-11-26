# KanZen : état des lieux de la v2 (étape 1)

*Audit du 25/11/2026, commit de référence `039c676` (« Initial commit : KanZen v2 complet »).*

## Verdict

La v2 est un **prototype d'environ 800 lignes, qui ne s'installait pas en l'état**. Il pose une bonne ossature technique (Fastify, Prisma, React/Vite, Socket.io, Caddy). En revanche, la majorité des fonctions décrites dans le README n'existent pas côté serveur : aucune création de tâche, de colonne ou de tableau, pas de stats, pas de backup planifié, pas d'automations branchées.

**Recommandation** : traiter l'étape 2 comme une **refondation sur la même stack**, pas comme un patch. On garde les choix techniques et l'UI, on réécrit l'API avec un modèle d'autorisation, PostgreSQL et l'auth AD dès le départ.

## Ce qui a été corrigé pendant l'étape 1 (socle)

| Problème constaté | Correction |
|---|---|
| `npm install` échoue : `json2csv@^6` n'existe qu'en alpha | Passage en `json2csv@^5.0.7` |
| Le build UI échoue : `@vitejs/plugin-react`, `@dnd-kit/utilities` et `index.css` manquent | Ajoutés |
| Le schéma Prisma est invalide (enum non supporté par SQLite) | **Bascule sur PostgreSQL**, migration initiale `0001_init` versionnée |
| **Le conteneur lançait le seed à chaque démarrage, et le seed purge toutes les tables** : perte totale des données à chaque redémarrage | Seed retiré du démarrage et refusé si `NODE_ENV=production` |
| Le seed référence des champs absents du schéma (`notifySlack`, `slackWebhook`) | Retirés |
| Secret JWT par défaut en dur (`supersecret_fallback_key`) | Démarrage refusé sans `JWT_SECRET` d'au moins 32 caractères |
| Le serveur écoute sur `0.0.0.0:3000` en dur | `HOST` et `PORT` configurables, `127.0.0.1` par défaut derrière le proxy |
| CLI `prisma` en devDependency alors qu'elle sert à l'exécution (`migrate deploy`) | Déplacée dans les dépendances |
| Docker : exécution en root, `caddy:latest`, secrets en clair dans le compose | Utilisateur `node`, image versionnée, secrets via `.env`, service PostgreSQL ajouté (option conteneur conservée) |
| Aucun lint, aucun test, aucune CI | ESLint, Vitest (4 tests sur l'auth), GitHub Actions (lint, tests, migrations sur PostgreSQL, build, SBOM CycloneDX, `npm audit`) |

**Vérifié** : installation, migrations sur PostgreSQL 16, seed, démarrage, login, lecture du tableau, rejet sans JWT, build UI, refus du seed en production.

## Constats de sécurité restants (traités à l'étape 2)

| Gravité | Constat |
|---|---|
| Critique | **Dépendances vulnérables** : 9 vulnérabilités en production, dont 1 critique et 3 hautes. `fast-jwt` (via `@fastify/jwt` 7) permet des contournements d'authentification JWT. `fastify` 4 et `@fastify/static` ≤ 10 exposent à des contournements de garde de route et à du path traversal. Correctif : passer à **Fastify 5** et aux plugins associés. |
| Critique | **Aucun contrôle d'autorisation sur les objets (IDOR)** : tout utilisateur authentifié peut déplacer n'importe quelle tâche vers n'importe quelle colonne, tous espaces confondus. `authorize()` existe mais n'est jamais utilisé. |
| Haute | **Pièces jointes servies sans authentification** sous `/uploads/`, sans filtrage de type. Un fichier HTML ou SVG déposé devient une XSS stockée sur le domaine de l'appli. |
| Haute | **JWT sans expiration**, stocké en `localStorage`. Pas de révocation, et le jeton reste exposé à toute XSS. Cible : session en cookie `HttpOnly; Secure; SameSite=Strict`, durée courte. |
| Haute | **Socket.io sans authentification**, avec CORS `*` (API et websocket). |
| Haute | **Le jeton passe dans l'URL** (`/api/admin/backup/now?token=…`) : il fuit dans les logs et l'historique du navigateur. |
| Moyenne | Pas de rate limiting sur `/api/login`, pas d'en-têtes de sécurité (CSP, HSTS, etc.), pas de validation de schéma des entrées. Un id inconnu provoque une erreur 500 qui expose le message interne. |
| Moyenne | Webhooks sortants vers une URL libre (SSRF). Sans objet en réseau fermé, mais à restreindre par liste blanche. |
| Moyenne | Pas de journal d'audit (connexions, actions d'administration). |
| Info | Comptes et mots de passe par défaut : le README annonce `admin123`, le seed crée `password123`. Ils disparaîtront avec l'authentification AD. |

## Écarts fonctionnels entre le README et le code

- **Inexistant côté serveur** : CRUD des tâches, colonnes et tableaux, commentaires, `/api/stats`, export CSV, `/api/admin/backup`, planification cron, gestion multi-tableaux.
- **Code présent mais jamais appelé** : `automations.js`, `backup.js` (qui dépend en plus de SQLite et de `/app/backups` en dur), `stats.js`. Aucun `TaskEvent` n'est jamais écrit, donc les stats seraient vides.
- **Notifications** : simulées (`console.log`).
- **Analytics** : affiche des **chiffres codés en dur**.
- **Calendrier** : figé sur le mois courant, sans navigation.
- **Sous-tâches** : le basculement existe côté API mais n'est pas branché dans l'UI.
- **Upload** : la taille enregistrée est toujours `0`.
- **Socket.io** : un `BOARD_UPDATED` global provoque un rechargement complet chez tous les clients.

## Backlog priorisé

**Étape 2 : refondation, sécurité et authentification AD**
1. Fastify 5, Vite 6+ et plugins à jour, puis `npm audit` bloquant en CI.
2. Authentification LDAPS sur AD : compte de service en lecture seule, filtrage `memberOf` récursif (`1.2.840.113556.1.4.1941`) sur `GG_KanZen_Users` et `GG_KanZen_Admins`, provisionnement JIT des comptes, confiance dans la CA interne.
3. Session en cookie HttpOnly, CSRF, expiration, websocket authentifiée.
4. Modèle d'autorisation par espace de travail (ADMIN, USER, OBSERVER) appliqué à chaque route, avec tests.
5. API CRUD complète et validée par JSON Schema, historique `TaskEvent`.
6. Pièces jointes servies par une route authentifiée, avec `Content-Disposition: attachment`, liste blanche MIME et taille réelle.
7. Rate limiting, en-têtes de sécurité, journal d'audit au format JSON (compatible syslog/SIEM).
8. Sauvegardes : `pg_dump` planifié avec rotation, chiffrement et procédure de restauration testée.
9. Tests d'intégration de l'API (Vitest + PostgreSQL) et E2E (Playwright).

**Étape 3 : packaging offline RPM et DEB**
Bundle autonome (runtime Node embarqué, `node_modules` et moteurs Prisma pré-résolus), unité systemd durcie, paquets `.rpm` et `.deb`, empreintes SHA-256 et signature, PostgreSQL issu des dépôts de la distribution. Option OCI conservée.

**Étape 4 : module Wiki et plan de déploiement final**

## Points d'attention pour la suite

- **Prisma et l'offline** : Prisma télécharge ses moteurs binaires au `generate`. Le bundle devra les embarquer pour chaque cible (OpenSSL 3 sur RHEL 9 comme sur Debian 12), et figer `PRISMA_*_BINARY` ou utiliser `binaryTargets`.
- **Taille du bundle UI** : 690 ko de JS en un seul fichier, découpage à prévoir. Sans impact sur la sécurité.
- **ESLint 9** est conservé tant que `eslint-plugin-react` ne supporte pas ESLint 10.
