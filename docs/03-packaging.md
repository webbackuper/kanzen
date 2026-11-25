# KanZen : packaging offline (étape 3)

## Livrables

`packaging/build.sh <version> <release>` s'exécute sur une **machine de build connectée à Internet** (Linux x86_64, Node ≥ 22.18 + npm, curl, git). Il produit dans `dist/` :

| Fichier | Cible |
|---|---|
| `kanzen-<v>-<r>.x86_64.rpm` | RHEL / Rocky / Alma **9+** |
| `kanzen_<v>-<r>_amd64.deb` | Debian **12+**, Ubuntu **22.04+** |
| `kanzen-<v>-linux-x64.tar.gz` | Toute distribution systemd (glibc ≥ 2.28, OpenSSL 3), installée par `./install.sh` |
| `SHA256SUMS` | Empreintes de tous les livrables |
| `sbom.cdx.json` | Nomenclature logicielle CycloneDX (dépendances de production) |

**Contenu, auto-suffisant :**
- le runtime **Node.js 24 LTS officiel** (`/opt/kanzen/node`) ;
- l'application avec ses `node_modules` de production déjà résolus ;
- le client Prisma compilé en JavaScript ;
- le moteur de migration Prisma (OpenSSL 3) ;
- l'interface web déjà construite.

Rien n'est téléchargé à l'installation, au démarrage ou à l'exécution (télémétrie Prisma désactivée).

**Garanties de la chaîne de build :**
- empreintes SHA-256 de Node.js et de nfpm vérifiées contre les fichiers publiés par leurs éditeurs ;
- sources prises par `git archive HEAD`, sans fichier local, `.env` ni `node_modules` ;
- `npm audit` bloquant à partir du niveau *high* ;
- binaires natifs des autres OS et architectures retirés.

## Ce que le paquet installe

| Chemin | Rôle | Droits |
|---|---|---|
| `/opt/kanzen/node`, `/opt/kanzen/app` | Runtime et application | root, lecture seule |
| `/etc/kanzen/kanzen.env` | Configuration (fichier de conf protégé à la mise à jour) | `root:kanzen 0640` |
| `/etc/kanzen/secrets/` | Secrets (`LDAP_BIND_PASSWORD_FILE`…) | `root:kanzen 0750` |
| `/etc/kanzen/ca/`, `/etc/kanzen/tls/` | CA de la PKI interne, certificat du serveur web | `root:kanzen 0750` |
| `/var/lib/kanzen/uploads` | Pièces jointes | `kanzen 0750` |
| `/var/backups/kanzen` | Sauvegardes | `kanzen 0750` |
| `/usr/sbin/kanzenctl` | Outil d'administration | root |
| `kanzen.service` | Service applicatif (migrations en `ExecStartPre`) | utilisateur `kanzen` |
| `kanzen-backup.service` + `.timer` | Sauvegarde quotidienne à 02h30, rattrapage si le serveur était éteint | utilisateur `kanzen` |
| `/usr/share/kanzen/nginx/kanzen.conf` | Modèle de reverse proxy (TLS, websocket) | à copier dans `/etc/nginx/conf.d/` |

**Dépendances système**, toutes disponibles sur les médias ou miroirs internes de la distribution :
- DEB : `postgresql-client`, `libssl3`, `ca-certificates`, `util-linux`, `tar`, `gzip`.
- RPM : `postgresql`, `openssl-libs`, `ca-certificates`, `util-linux`, `shadow-utils`.
- Recommandés : `postgresql-server` / `postgresql`, `nginx`, `gnupg`.

**Durcissement systemd** de `kanzen.service` :
- compte système dédié sans shell, aucune capability, `NoNewPrivileges` ;
- `ProtectSystem=strict` : écriture limitée à `/var/lib/kanzen` ;
- `ProtectHome`, `PrivateTmp`, `PrivateDevices`, protections noyau ;
- `SystemCallFilter=@system-service`, familles d'adresses restreintes à IPv4, IPv6 et Unix ;
- `UMask=0027` ;
- un code de sortie 78 (configuration invalide) ne relance pas le service en boucle.

## kanzenctl

```
kanzenctl version                 version installée
kanzenctl check [identifiant]     configuration, base, stockage, AD (bind de service, groupes, recherche d'un compte)
kanzenctl migrate | migrate-status
kanzenctl create-admin <id>       administrateur local de secours (mot de passe lu sur stdin)
kanzenctl backup                  sauvegarde immédiate
kanzenctl restore <archive>       restauration (service arrêté)
```

## Mise à jour et désinstallation

- **Mise à jour** : `dnf install ./kanzen-<nouvelle>.rpm`, `apt install ./kanzen_<nouvelle>.deb` ou `./install.sh` du nouveau bundle. La configuration est conservée (`config|noreplace`). Si le service tournait, il redémarre, et les migrations de schéma s'appliquent au démarrage. **Faire une `kanzenctl backup` avant toute mise à jour.**
- **Désinstallation** : le service est arrêté et désactivé. Les données (`/var/lib/kanzen`, `/var/backups/kanzen`), la configuration et le compte `kanzen` sont **conservés**.

## Tests réalisés (conteneurs, sans accès aux dépôts distants)

| Contrôle | Debian 12 (.deb) | Rocky Linux 9 (.rpm) |
|---|---|---|
| Installation, compte `kanzen`, arborescence et droits | OK | OK |
| `kanzenctl migrate` (2 migrations) | OK | OK |
| `kanzenctl create-admin`, politique de mot de passe appliquée | OK | OK |
| `kanzenctl check` : « Tout est conforme » | OK | OK |
| Démarrage sous l'utilisateur `kanzen`, `/api/health`, interface | OK | OK |
| Connexion : cookie `__Host-` `HttpOnly; Secure; SameSite=Strict` | OK | OK |
| `kanzenctl backup` | OK | non testé (pg_dump absent de l'image) |
| Désinstallation, données conservées | OK | OK |

**Non testé en conteneur** : l'exécution réelle sous systemd, le durcissement des unités et SELinux en mode *enforcing*. Ces points sont à valider à la recette sur une VM de la cible. Le plan de déploiement (étape 4) les détaille.

## Option conteneur

`KANZEN/Dockerfile` et `KANZEN/docker-compose.yml` restent maintenus. En réseau fermé : `docker save` des images sur la machine de build, transfert, puis `docker load` (ou `podman load`) sur la cible.
