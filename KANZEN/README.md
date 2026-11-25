# KanZen

Kanban et gestion de projet **auto-hébergés, conçus pour un réseau fermé** (sans Internet), avec authentification Active Directory et comptes locaux. Un module Wiki est prévu (étape 4).

## Fonctionnalités

- Espaces de travail avec membres et rôles (Propriétaire, Éditeur, Lecteur), plusieurs tableaux par espace.
- Tableaux Kanban : colonnes, limites WIP, glisser-déposer, mises à jour en temps réel.
- Tâches : description, échéance, assigné, couleur, sous-tâches, commentaires, pièces jointes.
- Agenda mensuel des échéances, statistiques par tableau, export CSV.
- Administration : comptes locaux, verrouillage et déverrouillage, révocation des sessions, journal d'audit.

## Sécurité, en bref

| Domaine | Mise en œuvre |
|---|---|
| Authentification | AD en **LDAPS** (compte de service, appartenance récursive aux groupes, bind utilisateur) **et/ou** comptes locaux en **argon2id** |
| Sessions | Jeton opaque en cookie `HttpOnly; Secure; SameSite=Strict` (`__Host-`). Seul son SHA-256 est stocké en base. Expirations absolue et d'inactivité, révocables |
| CSRF / CSWSH | En-tête `X-Requested-With` obligatoire, contrôle d'`Origin` sur l'API et la websocket |
| Autorisation | Rôle vérifié dans l'espace pour chaque objet. Un non-membre reçoit 404 |
| Entrées | JSON Schema strict (champs inconnus refusés), UUID validés |
| Pièces jointes | Liste blanche MIME, taille limitée, nom de stockage aléatoire, téléchargement authentifié et forcé (`attachment`, `nosniff`, CSP `sandbox`) |
| En-têtes | CSP stricte, HSTS, `frame-ancestors 'none'` (helmet) |
| Anti-bruteforce | Rate limiting par IP, verrouillage temporaire des comptes locaux |
| Traçabilité | Journal d'audit en base et en JSON sur stdout (journald / syslog / SIEM) |
| Chaîne d'approvisionnement | `npm audit` bloquant en CI, SBOM CycloneDX, Prisma sans moteur binaire téléchargé |

## Prérequis

- Node.js **22.18+** (24 LTS recommandé)
- PostgreSQL **14+** (16 recommandé)

## Développement

```bash
cd KANZEN
cp .env.example .env    # puis adapter : NODE_ENV=development, DATABASE_URL…
npm install             # génère aussi le client Prisma
npx prisma migrate deploy
npm run prisma:seed     # jeu de test : admin / alice / bob, mot de passe « KanZen-Dev-2026! »
npm run dev             # API sur :3000, interface sur http://localhost:5173
```

| Commande | Rôle |
|---|---|
| `npm run lint` | ESLint |
| `npm test` | Tests unitaires et d'intégration. Nécessite `DATABASE_URL` ou `TEST_DATABASE_URL` vers une base **dédiée aux tests**, qui est purgée |
| `npm run build` | Build de l'interface dans `dist/` |
| `npm run test:e2e` | Test navigateur de bout en bout (base seedée, `dist/` buildé) |
| `npm run admin:create -- <identifiant>` | Crée ou réinitialise un administrateur local de secours. Le mot de passe est lu sur stdin |
| `npm run sbom` | SBOM CycloneDX des dépendances de production |

## Configuration

Tout se règle par variables d'environnement : voir [`.env.example`](.env.example). Chaque secret peut être lu depuis un fichier via `XXX_FILE`. L'authentification AD est détaillée dans [`docs/auth-ad.md`](../docs/auth-ad.md).

## Exploitation

- Sauvegarde : `scripts/backup.sh` (pg_dump et pièces jointes, chiffrement GPG optionnel, rotation).
- Restauration : `scripts/restore.sh <archive>`.
- Santé : `GET /api/health`.

Le déploiement offline (paquets RPM/DEB, systemd, reverse proxy, PKI) est l'objet de l'étape 3, et le plan de déploiement final celui de l'étape 4. Une option conteneur reste disponible (`Dockerfile`, `docker-compose.yml`).

## Licence

MIT
