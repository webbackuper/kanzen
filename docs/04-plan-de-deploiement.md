# KanZen : plan de déploiement sur réseau fermé

Ce plan couvre tout le parcours :

1. récupération des sources et construction des paquets en zone connectée ;
2. passage du sas ;
3. préparation de l'infrastructure cible (DNS, PKI, AD, PostgreSQL, pare-feu) ;
4. installation, configuration finale et recette ;
5. exploitation courante.

Il s'applique à **RHEL / Rocky / Alma 9+** et à **Debian 12+ / Ubuntu 22.04+**. Les commandes propres à chaque famille sont signalées **[RPM]** et **[DEB]**.

| Document lié | Contenu |
|---|---|
| [`docs/auth-ad.md`](auth-ad.md) | Détail de l'authentification AD et des comptes locaux |
| [`docs/03-packaging.md`](03-packaging.md) | Contenu des paquets, durcissement systemd, `kanzenctl` |
| [`KANZEN/.env.example`](../KANZEN/.env.example) | Référence de toutes les variables de configuration |

---

## 0. Vue d'ensemble

### 0.1 Architecture cible

```
 Postes utilisateurs (navigateur)
          │ HTTPS 443 (certificat PKI interne)
          ▼
 ┌─────────────────────────── VM kanzen01 ───────────────────────────┐
 │  nginx (TLS, websocket)  ──►  KanZen (Node 24, 127.0.0.1:3000)    │
 │                                   │            │                  │
 │                                   ▼            ▼                  │
 │                    PostgreSQL 16 (127.0.0.1:5432)  /var/lib/kanzen │
 │                    /var/backups/kanzen  ◄── kanzen-backup.timer    │
 └──────────────────────────────────┬────────────────────────────────┘
                                    │ LDAPS 636 (compte de service)
                                    ▼
                     Contrôleurs de domaine AD (dc1, dc2)
```

Ce choix privilégie la simplicité d'exploitation : **un serveur unique**, avec PostgreSQL local. PostgreSQL peut être déporté sur un serveur de bases existant : il suffit d'adapter `DATABASE_URL` et la matrice de flux (§ 3.6).

### 0.2 Rôles

| Rôle | Intervient sur |
|---|---|
| **Intégrateur** (zone connectée) | Build, contrôle, constitution du lot de transfert |
| **Responsable sas / RSSI** | Décontamination, contrôle d'empreintes, registre des transferts |
| **Admin système** | VM, OS, PostgreSQL, nginx, KanZen, sauvegardes |
| **Admin AD / PKI** | Groupes, compte de service, certificat serveur, CA |
| **Admin réseau** | DNS, flux pare-feu |
| **Référent métier** | Recette fonctionnelle, nomination des administrateurs KanZen |

### 0.3 Calendrier indicatif

| Jour | Activité |
|---|---|
| J-10 | Demandes : VM, enregistrement DNS, certificat, groupes AD, compte de service, flux |
| J-3 | Build et passage du sas |
| J0 | Installation et configuration (environ ½ journée) |
| J0 | Recette technique (environ ½ journée) |
| J+1 | Recette fonctionnelle, ouverture aux utilisateurs pilotes |
| J+7 | Premier test de restauration, bilan, généralisation |

### 0.4 Informations à collecter avant de commencer

Remplir ce tableau ; les valeurs sont reprises dans tout le document.

| Élément | Exemple utilisé dans ce plan | Valeur cible |
|---|---|---|
| FQDN du service | `kanzen.corp.local` | |
| Nom et IP de la VM | `kanzen01.corp.local`, `10.10.0.50` | |
| Domaine AD, base de recherche | `corp.local`, `DC=corp,DC=local` | |
| Contrôleurs de domaine | `dc1.corp.local`, `dc2.corp.local` | |
| OU des groupes | `OU=Groupes,DC=corp,DC=local` | |
| OU des comptes de service | `OU=Comptes de service,DC=corp,DC=local` | |
| CA racine / intermédiaire | `corp-root-ca.pem`, `corp-issuing-ca.pem` | |
| Serveurs NTP | les DC | |
| Destinataire GPG des sauvegardes | `sauvegardes@corp.local` | |
| Cible d'externalisation des sauvegardes | partage NFS ou serveur de sauvegarde | |
| Collecteur syslog / SIEM | `siem.corp.local:6514` | |

---

## 1. Zone connectée : récupération des sources et build

### 1.1 Poste de build

Prévoir un poste ou une VM **Linux x86_64 dédiée**, connectée à Internet, avec :

- Node.js ≥ 22.18 et npm ;
- `git`, `curl`, `tar`, `sha256sum` ;
- facultatif : Docker ou Podman, pour l'option conteneur (§ 7).

La glibc de ce poste n'a pas d'importance : le runtime Node embarqué est le binaire officiel, compatible glibc ≥ 2.28.

### 1.2 Récupération des sources

```bash
git clone https://github.com/webbackuper/kanzen.git
cd kanzen
git checkout <tag ou commit validé>    # ex. v3.0.0 ; ne jamais builder une branche mouvante
git log -1 --format='%H %an %ad %s'    # à reporter dans la fiche de transfert
git status --short                     # doit être vide
```

> Le build part de `git archive HEAD` : un fichier modifié localement mais non commité **n'est pas** embarqué. C'est voulu, la version livrée est exactement celle du commit.

### 1.3 Construction

```bash
packaging/build.sh 3.0.0 1     # version, release
ls -l dist/
```

Le script effectue, dans l'ordre :

1. téléchargement de Node.js 24 LTS et de nfpm, **empreintes SHA-256 vérifiées** contre celles publiées par leurs éditeurs ;
2. `npm ci` à partir du `package-lock.json`, sans aucune résolution de version au moment du build ;
3. **`npm audit --audit-level=high`, bloquant** : le build s'arrête sur une vulnérabilité de niveau *high* ou *critical* ;
4. build de l'interface, génération du client Prisma, SBOM CycloneDX ;
5. production du `.rpm`, du `.deb`, du bundle `.tar.gz` et du fichier `SHA256SUMS`.

Contrôles à faire avant de poursuivre :

```bash
cd dist && sha256sum -c SHA256SUMS
rpm -qpi kanzen-3.0.0-1.x86_64.rpm | head        # si rpm est disponible
dpkg-deb -I kanzen_3.0.0-1_amd64.deb             # si dpkg est disponible
```

### 1.4 Dépendances système à prévoir côté cible

KanZen n'a besoin que de paquets standards de la distribution :

| Composant | [RPM] RHEL 9 | [DEB] Debian 12 / Ubuntu |
|---|---|---|
| Client PostgreSQL (sauvegardes) | `postgresql` | `postgresql-client` |
| Serveur PostgreSQL 14+ | `postgresql-server` (module `postgresql:16`) | `postgresql` (15 sur Debian 12, 16 sur Ubuntu 24.04) |
| Reverse proxy | `nginx` | `nginx` |
| Bibliothèques | `openssl-libs`, `ca-certificates`, `util-linux`, `shadow-utils`, `tar`, `gzip` | `libssl3`, `ca-certificates`, `util-linux`, `tar`, `gzip` |
| Chiffrement des sauvegardes | `gnupg2` | `gnupg` |
| Diagnostic | `openldap-clients`, `openssl` | `ldap-utils`, `openssl` |

**Cas 1 : le réseau cible dispose d'un miroir (Satellite, Pulp, aptly, Nexus…) ou des médias d'installation.** Rien d'autre n'est à transférer.

**Cas 2 : aucun miroir.** Constituer un lot depuis une machine connectée, **de même version mineure** que la cible :

```bash
# [RPM] sur une Rocky/RHEL 9 connectée, identique à la cible
dnf module enable -y postgresql:16
mkdir deps && dnf download --resolve --alldeps --destdir deps \
  postgresql-server postgresql nginx gnupg2 openldap-clients
# [DEB] sur une Debian 12 connectée, identique à la cible
mkdir deps && cd deps && apt-get download $(apt-cache depends --recurse --no-recommends --no-suggests \
  --no-conflicts --no-breaks --no-replaces --no-enhances postgresql nginx gnupg ldap-utils postgresql-client \
  | grep '^\w' | sort -u)
sha256sum * > SHA256SUMS
```

### 1.5 Lot de transfert

```
kanzen-3.0.0-lot/
├── FICHE-TRANSFERT.txt        # commit, date, intégrateur, liste des fichiers, empreintes
├── paquets/
│   ├── kanzen-3.0.0-1.x86_64.rpm
│   ├── kanzen_3.0.0-1_amd64.deb
│   ├── kanzen-3.0.0-linux-x64.tar.gz
│   ├── SHA256SUMS
│   └── sbom.cdx.json
├── deps/                      # uniquement dans le cas 2
├── docs/                      # ce plan, auth-ad.md, 03-packaging.md
└── sources/kanzen-3.0.0-src.tar.gz   # git archive, pour audit ou rebuild
```

```bash
git archive --format=tar.gz --prefix=kanzen-3.0.0/ -o sources/kanzen-3.0.0-src.tar.gz HEAD
sha256sum -b paquets/* sources/* > SHA256SUMS.lot
```

Recommandé : **signer** le fichier d'empreintes avec la clé de l'intégrateur. La clé publique doit être connue du RSSI à l'avance, par un canal distinct.

```bash
gpg --armor --detach-sign SHA256SUMS.lot   # produit SHA256SUMS.lot.asc
```

L'empreinte de `SHA256SUMS.lot` est aussi à transmettre **hors bande** au responsable du sas, par exemple par téléphone ou sur la fiche papier.

---

## 2. Passage du sas

1. **Support** : clé USB chiffrée dédiée, ou média non réinscriptible (DVD-R). Le support est enregistré au registre des transferts.
2. **Station blanche** : analyse antivirus multi-moteurs du lot complet, archives comprises. Les fichiers `.rpm`, `.deb` et `.tar.gz` sont des archives : vérifier que la station les décompresse pour l'analyse.
3. **Contrôle d'intégrité côté réseau fermé** :
   ```bash
   gpg --verify SHA256SUMS.lot.asc SHA256SUMS.lot   # si signé
   sha256sum -c SHA256SUMS.lot
   cd paquets && sha256sum -c SHA256SUMS
   ```
   L'empreinte de `SHA256SUMS.lot` doit correspondre à celle reçue hors bande. **Tout écart bloque le déploiement.**
4. **Dépôt** sur un partage interne de référence (dépôt logiciel interne, en lecture seule pour les admins), puis copie sur la VM :
   ```bash
   scp paquets/kanzen-3.0.0-1.x86_64.rpm admin@kanzen01:/tmp/
   ```
5. **Traçabilité** : consigner au registre la date, l'opérateur, le support, les empreintes et le résultat antivirus. La consultation du SBOM (`sbom.cdx.json`) permet au RSSI de suivre les composants embarqués.

---

## 3. Préparation de l'infrastructure cible

### 3.1 Machine virtuelle

| Ressource | Minimum (≤ 100 utilisateurs) | Recommandé (≤ 500 utilisateurs) |
|---|---|---|
| vCPU | 2 | 4 |
| RAM | 4 Go | 8 Go |
| Système | 20 Go | 30 Go |
| `/var/lib/pgsql` ou `/var/lib/postgresql` | 10 Go | 30 Go |
| `/var/lib/kanzen` (pièces jointes, images du wiki) | 20 Go | selon usage (≈ 20 Mo max par fichier) |
| `/var/backups/kanzen` | 2 × (base + pièces jointes) × rétention / 7 | volume séparé, idéalement sur un autre stockage |

Partitionnement recommandé : volumes LVM séparés pour les données, avec les options `nodev,nosuid,noexec` sur `/var/lib/kanzen` et `/var/backups/kanzen`.

### 3.2 Système d'exploitation

- Installation minimale, mises à jour de sécurité à jour depuis le miroir interne.
- Durcissement selon le référentiel en vigueur (CIS niveau 1, guide ANSSI). KanZen n'impose aucune exception.
- **SELinux en mode enforcing [RPM]**, AppArmor actif [DEB].
- Synchronisation horaire sur les DC : un décalage de plus de 5 minutes casse Kerberos et rend les journaux inexploitables.
  ```bash
  # /etc/chrony.conf (RPM) ou /etc/chrony/chrony.conf (DEB)
  server dc1.corp.local iburst
  server dc2.corp.local iburst
  systemctl enable --now chronyd   # [DEB] chrony
  chronyc tracking
  ```
- Locale et fuseau horaire :
  ```bash
  timedatectl set-timezone Europe/Paris
  localectl set-locale LANG=fr_FR.UTF-8
  ```

### 3.3 DNS

| Enregistrement | Valeur |
|---|---|
| `kanzen01.corp.local` A | `10.10.0.50` (+ PTR) |
| `kanzen.corp.local` CNAME ou A | `kanzen01.corp.local` |

Le nom de service `kanzen.corp.local` est découplé du nom de la machine, ce qui facilite une migration ou un PRA. Vérifier depuis la VM :

```bash
getent hosts kanzen.corp.local dc1.corp.local dc2.corp.local
```

### 3.4 PKI : certificat du serveur web

Le certificat est émis par la CA interne, avec le modèle « Serveur Web » d'AD CS ou son équivalent.

```bash
install -d -m 0750 -o root -g kanzen /etc/kanzen/tls
cd /etc/kanzen/tls
openssl req -new -newkey rsa:3072 -nodes -keyout kanzen.key -out kanzen.csr \
  -subj "/CN=kanzen.corp.local/O=CORP" \
  -addext "subjectAltName=DNS:kanzen.corp.local,DNS:kanzen01.corp.local" \
  -addext "extendedKeyUsage=serverAuth"
chmod 0640 kanzen.key && chown root:kanzen kanzen.key
```

1. Transmettre `kanzen.csr` à l'équipe PKI (sur un DC : `certreq -submit -attrib "CertificateTemplate:WebServer" kanzen.csr`).
2. Récupérer le certificat au format PEM (Base64), puis construire la chaîne complète **serveur, puis intermédiaire** (sans la racine) :
   ```bash
   cat kanzen.crt corp-issuing-ca.pem > kanzen.fullchain.pem
   openssl verify -CAfile corp-root-ca.pem -untrusted corp-issuing-ca.pem kanzen.crt   # doit afficher OK
   openssl x509 -in kanzen.crt -noout -subject -ext subjectAltName -enddate
   ```
3. Les postes doivent faire confiance à la CA racine. C'est en général déjà le cas, par GPO « Autorités de certification racines de confiance ».

**CA pour LDAPS** : déposer la chaîne de la CA (racine + intermédiaire, PEM) qui a émis les certificats des DC :

```bash
install -d -m 0750 -o root -g kanzen /etc/kanzen/ca
cat corp-root-ca.pem corp-issuing-ca.pem > /etc/kanzen/ca/corp-ca.pem
chmod 0640 /etc/kanzen/ca/corp-ca.pem && chown root:kanzen /etc/kanzen/ca/corp-ca.pem
# Facultatif, pour les outils système (openssl, ldapsearch) :
# [RPM] cp corp-root-ca.pem /etc/pki/ca-trust/source/anchors/ && update-ca-trust
# [DEB] cp corp-root-ca.pem /usr/local/share/ca-certificates/corp-root-ca.crt && update-ca-certificates
```

> Les répertoires `/etc/kanzen/ca` et `/etc/kanzen/tls` sont créés par le paquet. Les commandes `install -d` ci-dessus servent uniquement si la PKI est préparée **avant** l'installation de KanZen. Dans ce cas, créer d'abord le groupe `kanzen` ou faire un `chown` après l'installation.

### 3.5 Active Directory

Toutes les commandes PowerShell sont dans [`docs/auth-ad.md`](auth-ad.md). En résumé :

| Objet | Nom | Remarques |
|---|---|---|
| Groupe d'accès | `GG_KanZen_Users` | Global, sécurité. Les groupes imbriqués sont pris en compte |
| Groupe d'administration | `GG_KanZen_Admins` | Global, sécurité. Réservé aux comptes d'administration (`adm-…`) |
| Compte de service | `svc-kanzen` | Lecture seule, mot de passe long (≥ 24 caractères), aucune ouverture de session interactive (GPO), pas de droit particulier |

Le mot de passe du compte de service est remis à l'admin système par le canal prévu pour les secrets (coffre, enveloppe scellée). **Il n'apparaît jamais dans un ticket ni dans un mail.**

Prérequis côté DC : LDAPS opérationnel (certificat valide avec le FQDN du DC dans le SAN). Il est recommandé d'imposer la signature LDAP et le *channel binding*. KanZen n'utilise que LDAPS, ce qui est compatible avec ces exigences.

### 3.6 Matrice de flux

| Source | Destination | Port | Usage |
|---|---|---|---|
| Postes utilisateurs | kanzen01 | TCP 443 | Application (HTTPS + websocket) |
| Postes utilisateurs | kanzen01 | TCP 80 | Redirection vers HTTPS (facultatif) |
| Bastion d'administration | kanzen01 | TCP 22 | SSH |
| kanzen01 | dc1, dc2 | TCP 636 | LDAPS |
| kanzen01 | DNS internes | UDP/TCP 53 | Résolution |
| kanzen01 | NTP (DC) | UDP 123 | Heure |
| kanzen01 | Collecteur syslog / SIEM | TCP 6514 (TLS) | Journaux, dont l'audit |
| kanzen01 | Serveur de sauvegarde | selon solution | Externalisation de `/var/backups/kanzen` |
| kanzen01 | Miroir de paquets interne | TCP 443 | Mises à jour OS |

PostgreSQL (5432) et l'application (3000) **n'écoutent que sur 127.0.0.1** : aucun flux entrant n'est à ouvrir pour eux. Aucun flux vers Internet n'est nécessaire, à aucun moment.

Pare-feu local :

```bash
# [RPM] firewalld
firewall-cmd --permanent --add-service=https --add-service=http
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<IP bastion>/32 service name=ssh accept'
firewall-cmd --permanent --remove-service=ssh     # si SSH est restreint au bastion
firewall-cmd --reload
# [DEB] nftables (ou ufw)
ufw default deny incoming && ufw allow 443/tcp && ufw allow 80/tcp && ufw allow from <IP bastion> to any port 22 proto tcp && ufw enable
```

---

## 4. Installation

Toutes les commandes de cette section sont exécutées en **root**, sur `kanzen01`.

### 4.1 PostgreSQL

**[RPM] RHEL / Rocky 9**

```bash
dnf module enable -y postgresql:16
dnf install -y postgresql-server postgresql
postgresql-setup --initdb
systemctl enable --now postgresql
```

**[DEB] Debian / Ubuntu**

```bash
apt install -y postgresql postgresql-client      # crée et démarre le cluster « main »
```

**Durcissement et réglages** (fichiers `postgresql.conf` et `pg_hba.conf`) :

- [RPM] `/var/lib/pgsql/data/`
- [DEB] `/etc/postgresql/<version>/main/`

```ini
# postgresql.conf
listen_addresses = 'localhost'          # aucune écoute réseau externe
password_encryption = scram-sha-256
shared_buffers = 1GB                    # ≈ 25 % de la RAM
effective_cache_size = 3GB              # ≈ 75 % de la RAM
work_mem = 16MB
maintenance_work_mem = 256MB
log_connections = on
log_disconnections = on
log_line_prefix = '%m [%p] %q%u@%d '
log_min_duration_statement = 1000       # requêtes de plus d'une seconde
```

```
# pg_hba.conf : remplacer les lignes host existantes par
local   all       postgres                    peer
local   all       all                         peer
host    kanzen    kanzen    127.0.0.1/32      scram-sha-256
host    kanzen    kanzen    ::1/128           scram-sha-256
```

```bash
systemctl restart postgresql
```

**Base et rôle applicatif** (le mot de passe est généré, jamais saisi en clair dans l'historique) :

```bash
PGPASS=$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v pw="$PGPASS" <<'SQL'
CREATE ROLE kanzen LOGIN PASSWORD :'pw';
CREATE DATABASE kanzen OWNER kanzen ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE kanzen FROM PUBLIC;
\c kanzen
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO kanzen;
SQL
echo "$PGPASS"      # à reporter dans DATABASE_URL (§ 4.3), puis : unset PGPASS
```

> La recherche plein texte du wiki utilise la configuration `french`, intégrée à PostgreSQL. Aucune extension n'est requise.

### 4.2 Paquet KanZen

```bash
# [RPM]
dnf install -y /tmp/kanzen-3.0.0-1.x86_64.rpm
# [DEB]
apt install -y /tmp/kanzen_3.0.0-1_amd64.deb
# Autre distribution systemd : bundle
tar xzf kanzen-3.0.0-linux-x64.tar.gz && cd kanzen-3.0.0 && ./install.sh

kanzenctl version
```

Le paquet crée :

- le compte système `kanzen` ;
- l'arborescence (`/opt/kanzen`, `/etc/kanzen`, `/var/lib/kanzen`, `/var/backups/kanzen`) ;
- les unités systemd. Elles ne sont **pas démarrées** : la configuration est à faire d'abord.

### 4.3 Configuration : `/etc/kanzen/kanzen.env`

```bash
vi /etc/kanzen/kanzen.env
```

Valeurs à renseigner **au minimum** :

```ini
PUBLIC_URL=https://kanzen.corp.local
DATABASE_URL=postgresql://kanzen:<mot de passe PostgreSQL>@127.0.0.1:5432/kanzen?schema=public

AUTH_LOCAL_ENABLED=true
AUTH_LDAP_ENABLED=true
LDAP_URL=ldaps://dc1.corp.local:636,ldaps://dc2.corp.local:636
LDAP_BIND_DN=CN=svc-kanzen,OU=Comptes de service,DC=corp,DC=local
LDAP_BIND_PASSWORD_FILE=/etc/kanzen/secrets/ldap_bind_password
LDAP_BASE_DN=DC=corp,DC=local
LDAP_GROUP_USERS=CN=GG_KanZen_Users,OU=Groupes,DC=corp,DC=local
LDAP_GROUP_ADMINS=CN=GG_KanZen_Admins,OU=Groupes,DC=corp,DC=local
LDAP_CA_FILE=/etc/kanzen/ca/corp-ca.pem
```

| Paramètre | Recommandation |
|---|---|
| `SESSION_TTL_HOURS` / `SESSION_IDLE_MINUTES` | 8 h / 60 min par défaut, à aligner sur la politique de verrouillage des postes |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MINUTES` | Comptes locaux uniquement ; l'AD applique sa propre politique |
| `UPLOAD_MAX_MB` | 20 par défaut ; garder `client_max_body_size` de nginx supérieur |
| `UPLOAD_ALLOWED_MIME` | Liste blanche des types de pièces jointes, à restreindre si besoin |
| `BACKUP_RETENTION_DAYS` | 14 par défaut |

**Recommandé : sortir aussi la chaîne de connexion PostgreSQL du fichier de configuration.** L'application, les migrations, `kanzenctl` et les sauvegardes lisent `DATABASE_URL_FILE` :

```bash
install -m 0640 -o root -g kanzen /dev/null /etc/kanzen/secrets/database_url
printf '%s' 'postgresql://kanzen:<mot de passe PostgreSQL>@127.0.0.1:5432/kanzen?schema=public' > /etc/kanzen/secrets/database_url
# dans kanzen.env : supprimer la ligne DATABASE_URL et ajouter
DATABASE_URL_FILE=/etc/kanzen/secrets/database_url
```

Un mot de passe contenant des caractères spéciaux (`@`, `:`, `/`, `%`…) doit y être encodé en URL (`@` devient `%40`). Les sauvegardes transmettent le mot de passe à `pg_dump` par variable d'environnement, jamais en argument visible dans la liste des processus.

**Secret du compte de service AD :**

```bash
install -m 0640 -o root -g kanzen /dev/null /etc/kanzen/secrets/ldap_bind_password
vi /etc/kanzen/secrets/ldap_bind_password     # une seule ligne (KanZen ignore les espaces et retours de fin)
ls -l /etc/kanzen/secrets/
```

Contrôle des droits attendus :

```bash
stat -c '%U:%G %a %n' /etc/kanzen /etc/kanzen/kanzen.env /etc/kanzen/secrets /etc/kanzen/secrets/* /etc/kanzen/tls/* /etc/kanzen/ca/*
# root:kanzen 750 /etc/kanzen ; root:kanzen 640 pour les fichiers
```

### 4.4 Initialisation et diagnostic

```bash
kanzenctl migrate              # crée le schéma (3 migrations à ce jour)
kanzenctl check jdupont        # configuration, base, stockage, bind AD, groupes, recherche d'un compte réel
```

Le résultat attendu se termine par « Tout est conforme ». En cas d'échec sur l'AD, voir § 6.2.

**Administrateur local de secours** (bris de glace) :

```bash
kanzenctl create-admin secours      # mot de passe lu sur l'entrée standard, jamais en argument
```

Le mot de passe (≥ 12 caractères, 3 classes) est placé **sous enveloppe scellée ou dans le coffre**. Ce compte sert uniquement quand l'AD est indisponible ; chaque usage est visible dans le journal d'audit (`auth.login`, compte `secours`).

### 4.5 Reverse proxy nginx

```bash
cp /usr/share/kanzen/nginx/kanzen.conf /etc/nginx/conf.d/kanzen.conf
vi /etc/nginx/conf.d/kanzen.conf      # server_name ; chemins ssl_certificate / ssl_certificate_key
```

Les chemins par défaut du modèle sont `/etc/kanzen/tls/kanzen.fullchain.pem` et `/etc/kanzen/tls/kanzen.key`. nginx lit ces fichiers au démarrage, en root, avant de passer sous son propre utilisateur : les droits `root:kanzen 0640` conviennent.

```bash
# [DEB] désactiver le site par défaut
rm -f /etc/nginx/sites-enabled/default
# [RPM] SELinux : autoriser nginx à joindre l'application locale et à lire les certificats
setsebool -P httpd_can_network_connect 1
dnf install -y policycoreutils-python-utils      # fournit semanage, si absent
semanage fcontext -a -t cert_t '/etc/kanzen/tls(/.*)?' && restorecon -Rv /etc/kanzen/tls

nginx -t && systemctl enable --now nginx
```

Le modèle impose TLS 1.2 et 1.3, HTTP/2, la redirection 80 vers 443 et le passage de la websocket (`/socket.io/`). Les en-têtes de sécurité (CSP stricte, HSTS, `X-Frame-Options`, `nosniff`) sont posés **par l'application** ; il n'est pas nécessaire de les dupliquer dans nginx.

### 4.6 Démarrage

```bash
systemctl enable --now kanzen
systemctl enable --now kanzen-backup.timer
systemctl status kanzen --no-pager
journalctl -u kanzen -n 50 --no-pager
curl -fsS https://kanzen.corp.local/api/health     # {"status":"ok"}
```

> À chaque démarrage, `ExecStartPre` applique les migrations en attente (opération idempotente). Un code de sortie 78 signale une **configuration invalide** : le service ne redémarre pas en boucle, le motif est dans `journalctl -u kanzen`.

### 4.7 Premier paramétrage dans l'application

1. Se connecter avec un compte membre de `GG_KanZen_Admins` : il obtient le rôle ADMIN.
2. **Comptes** : vérifier la présence du compte `secours`. Créer les éventuels comptes locaux (prestataires hors domaine), avec un mot de passe temporaire ; le changement est imposé à la première connexion.
3. Créer les espaces de travail et y ajouter les membres (rôles Propriétaire, Éditeur, Lecteur). Un utilisateur AD apparaît dans la liste après sa **première connexion**.
4. Créer la page d'accueil du **Wiki** de chaque espace : conventions, contacts, procédures.
5. **Audit** : vérifier la trace des connexions de la recette.

---

## 5. Recette

Chaque contrôle est consigné (OK / KO / commentaire) dans le procès-verbal de recette.

### 5.1 Recette technique

| # | Contrôle | Commande / action | Résultat attendu |
|---|---|---|---|
| T1 | Service actif sous le compte dédié | `ps -o user,cmd -C node` | `kanzen …/src/server/index.js` |
| T2 | Écoute locale uniquement | `ss -ltnp` | 3000 et 5432 sur 127.0.0.1, 443 et 80 sur nginx |
| T3 | Durcissement systemd | `systemd-analyze security kanzen` | Exposition « OK » ou meilleure |
| T4 | SELinux [RPM] | `getenforce` ; `ausearch -m avc -ts today` | `Enforcing`, aucun refus lié à nginx ou kanzen |
| T5 | Certificat et protocoles | `openssl s_client -connect kanzen.corp.local:443 -servername kanzen.corp.local -CAfile corp-root-ca.pem </dev/null` | `Verify return code: 0`, TLSv1.3 |
| T6 | TLS 1.1 refusé | `openssl s_client -connect kanzen.corp.local:443 -tls1_1 </dev/null` | Échec de la négociation |
| T7 | En-têtes de sécurité | `curl -sI https://kanzen.corp.local/` | `strict-transport-security`, `content-security-policy`, `x-frame-options` |
| T8 | Redirection HTTP | `curl -sI http://kanzen.corp.local/` | `301` vers https |
| T9 | Santé | `curl -fsS https://kanzen.corp.local/api/health` | `{"status":"ok"}` |
| T10 | Diagnostic complet | `kanzenctl check jdupont` | « Tout est conforme » |
| T11 | Bascule de DC | Couper le flux vers dc1 (ou `LDAP_URL` avec un DC injoignable en tête), puis se connecter | Connexion réussie via dc2 |
| T12 | Redémarrage de la VM | `reboot` | KanZen, nginx, PostgreSQL et le timer actifs au retour |
| T13 | Sauvegarde | `kanzenctl backup` ; `ls -l /var/backups/kanzen` | Archive créée (chiffrée `.gpg` si configurée) |
| T14 | Restauration | Procédure § 6.4 sur une **VM de recette** | Données et pièces jointes identiques |
| T15 | Journaux vers le SIEM | Connexion échouée volontaire | Événement `auth.login` / `failure` reçu par le SIEM |
| T16 | Aucun flux sortant inattendu | `ss -tnp state established` pendant la recette | Uniquement les DC, DNS, NTP, syslog |

### 5.2 Recette sécurité et authentification

| # | Scénario | Résultat attendu |
|---|---|---|
| S1 | Utilisateur membre de `GG_KanZen_Users` | Connexion OK, rôle USER |
| S2 | Utilisateur membre via un **groupe imbriqué** | Connexion OK |
| S3 | Utilisateur du domaine **hors groupes** | Refus « accès non autorisé », tracé en audit |
| S4 | Membre de `GG_KanZen_Admins` | Connexion OK, rôle ADMIN (menus Comptes et Audit) |
| S5 | Compte AD **désactivé** | Refus |
| S6 | Mauvais mot de passe AD, répété | Refus ; le verrouillage AD s'applique selon la GPO du domaine |
| S7 | Formats d'identifiant `jdupont`, `CORP\jdupont`, `jdupont@corp.local` | Même compte |
| S8 | Retrait du groupe, puis nouvelle connexion | Refus et sessions fermées |
| S9 | Compte local : création, première connexion | Changement de mot de passe imposé, politique appliquée |
| S10 | Compte local : 5 échecs | Verrouillage temporaire, visible dans **Comptes** |
| S11 | **AD indisponible** (flux 636 coupé) | Comptes AD refusés, compte `secours` fonctionnel |
| S12 | Cookie de session | `__Host-kz_sid`, `HttpOnly; Secure; SameSite=Strict` (outils de développement du navigateur) |
| S13 | Expiration d'inactivité | Déconnexion après `SESSION_IDLE_MINUTES` |
| S14 | Non-membre d'un espace qui tente d'ouvrir l'URL d'un tableau ou d'une page wiki | « Introuvable » (404), sans révéler l'existence de l'objet |
| S15 | Lecteur d'un espace | Lecture seule (tableaux et wiki), aucune modification possible |
| S16 | Pièce jointe `.html` ou `.svg` | HTML refusé ; SVG servi uniquement en téléchargement |
| S17 | Lien `javascript:` collé dans le wiki | Lien retiré à l'enregistrement |

### 5.3 Recette fonctionnelle

| # | Scénario |
|---|---|
| F1 | Créer un espace, un tableau (modèle Kanban), des colonnes avec limite WIP |
| F2 | Créer, déplacer (glisser-déposer) et affecter une tâche à plusieurs personnes ; échéance, sous-tâches, commentaires, pièce jointe |
| F3 | Mise à jour en temps réel entre deux navigateurs sur le même tableau |
| F4 | Agenda (« Mes tâches »), statistiques, export CSV ouvert dans Excel (accents corrects) |
| F5 | Wiki : arborescence de pages et sous-pages, mise en forme (titres, listes, tableaux, code, liens), image insérée |
| F6 | Wiki : deux éditeurs sur la même page ; le second est averti et choisit sa version, sans perte silencieuse |
| F7 | Wiki : historique, restauration d'une version antérieure |
| F8 | Wiki : recherche (« sauvegarde » trouve « sauvegardes »), extrait surligné |
| F9 | Wiki : corbeille, restauration avec sous-pages ; suppression définitive par un propriétaire |
| F10 | Wiki : export Markdown d'une page |

---

## 6. Exploitation

### 6.1 Commandes courantes

```bash
systemctl status kanzen              # état
journalctl -u kanzen -f              # journaux applicatifs (JSON)
journalctl -u kanzen -o cat | grep '"audit"'    # événements d'audit
kanzenctl check [identifiant]        # diagnostic
kanzenctl backup                     # sauvegarde immédiate
systemctl list-timers kanzen-backup.timer
```

### 6.2 Diagnostic de l'authentification AD

```bash
# 1. Résolution et heure
getent hosts dc1.corp.local && chronyc tracking | grep 'System time'
# 2. TLS vers le DC, avec la CA configurée
openssl s_client -connect dc1.corp.local:636 -CAfile /etc/kanzen/ca/corp-ca.pem -verify_return_error </dev/null | grep -E 'Verify|subject'
# 3. Bind du compte de service et appartenance récursive
LDAPTLS_CACERT=/etc/kanzen/ca/corp-ca.pem ldapsearch -H ldaps://dc1.corp.local -x \
  -D "CN=svc-kanzen,OU=Comptes de service,DC=corp,DC=local" -W \
  -b "DC=corp,DC=local" "(&(sAMAccountName=jdupont)(memberOf:1.2.840.113556.1.4.1941:=CN=GG_KanZen_Users,OU=Groupes,DC=corp,DC=local))" dn
# 4. Diagnostic intégré
kanzenctl check jdupont
```

| Symptôme | Cause probable |
|---|---|
| `unable to verify the first certificate` | `LDAP_CA_FILE` incomplet : il manque l'intermédiaire |
| `Hostname/IP does not match` | Le DC est joint par un nom absent de son SAN : utiliser son FQDN |
| `InvalidCredentialsError` au bind de service | Mot de passe `svc-kanzen` expiré, changé dans l'AD sans mise à jour du fichier secret, ou compte verrouillé |
| « accès non autorisé » pour un utilisateur légitime | Utilisateur hors `GG_KanZen_Users`, ou DN de groupe mal saisi |

### 6.3 Sauvegardes

- `kanzen-backup.timer` déclenche une sauvegarde **chaque nuit à 02h30**, avec rattrapage si la VM était éteinte. Chaque archive `kanzen-AAAAMMJJTHHMMSSZ.tar` contient le dump PostgreSQL (format custom), les pièces jointes et les images du wiki, et un `SHA256SUMS`.
- Rétention locale : `BACKUP_RETENTION_DAYS` (14 jours par défaut).
- **Chiffrement (recommandé)** : seule la clé **publique** est déposée sur le serveur. La clé privée reste au coffre, hors de la VM.
  ```bash
  install -d -m 0750 -o root -g kanzen /etc/kanzen/gnupg
  gpg --homedir /etc/kanzen/gnupg --import sauvegardes-pub.asc
  chown -R root:kanzen /etc/kanzen/gnupg && chmod 0640 /etc/kanzen/gnupg/*
  # dans kanzen.env
  BACKUP_GPG_RECIPIENT=sauvegardes@corp.local
  systemctl start kanzen-backup.service && ls -l /var/backups/kanzen   # *.tar.gpg
  ```
- **Externalisation** : `/var/backups/kanzen` doit être repris par la solution de sauvegarde du SI (agent, NFS, rsync vers un serveur dédié). Règle 3-2-1 : 3 copies, 2 supports, 1 hors site.
- Supervision : alerter si aucune archive de moins de 26 h n'est présente.
  ```bash
  find /var/backups/kanzen -name 'kanzen-*.tar*' -mmin -1560 | grep -q . || echo "ALERTE sauvegarde KanZen"
  systemctl is-failed kanzen-backup.service
  ```

### 6.4 Restauration

```bash
# Archive chiffrée : la déchiffrer d'abord sur le poste qui détient la clé privée, puis transférer le .tar
gpg --decrypt --output kanzen-20261125T023000Z.tar kanzen-20261125T023000Z.tar.gpg

systemctl stop kanzen
kanzenctl restore /var/backups/kanzen/kanzen-20261125T023000Z.tar   # demande de taper RESTAURER
systemctl start kanzen
kanzenctl check
```

La restauration remplace la base et les pièces jointes. Les sessions en cours sont perdues : les utilisateurs se reconnectent. **Tester la restauration une fois par trimestre** sur une VM de recette (contrôle T14), et consigner le résultat.

### 6.5 Journaux et SIEM

L'application journalise en JSON dans journald. Chaque événement de sécurité porte un champ `audit` : `auth.login` (succès ou échec, avec motif), `auth.lockout`, `user.*`, `workspace.*`, `board.delete`, `wiki.page.trash`, `wiki.page.restore`, `wiki.page.purge`, `wiki.revision.restore`. Ils sont aussi consultables dans l'écran **Audit**.

Transfert vers le SIEM avec rsyslog, en TLS :

```
# /etc/rsyslog.d/60-kanzen.conf
module(load="imjournal")
if ($!_SYSTEMD_UNIT == "kanzen.service" or $programname == "nginx") then {
  action(type="omfwd" target="siem.corp.local" port="6514" protocol="tcp"
         StreamDriver="gtls" StreamDriverMode="1" StreamDriverAuthMode="x509/name"
         StreamDriverPermittedPeers="siem.corp.local")
}
```

```bash
# [RPM] dnf install rsyslog-gnutls   [DEB] apt install rsyslog-gnutls
systemctl restart rsyslog
```

Règles de détection suggérées :

- plus de 10 `auth.login` en échec par minute depuis une même IP ;
- toute connexion du compte `secours` ;
- tout `user.update` qui change un rôle ;
- tout `wiki.page.purge`.

Conservation : conformément à la politique du SI, au minimum 1 an pour les journaux de sécurité.

### 6.6 Supervision

| Sonde | Seuil |
|---|---|
| `GET https://kanzen.corp.local/api/health` (vérifie aussi la base) | HTTP 200, < 2 s |
| `systemctl is-active kanzen nginx postgresql` | actifs |
| Expiration du certificat TLS | alerte à J-30 |
| Espace disque `/var/lib/kanzen`, `/var/backups/kanzen`, PostgreSQL | > 80 % |
| Fraîcheur de la dernière sauvegarde | < 26 h |

### 6.7 Mise à jour de KanZen

1. Préparer la nouvelle version en zone connectée (§ 1) et la faire passer par le sas (§ 2).
2. Lire les notes de version, en particulier les migrations de schéma.
3. Appliquer d'abord sur la VM de recette, si elle existe.
4. En production :
   ```bash
   kanzenctl backup                                   # OBLIGATOIRE
   dnf install /tmp/kanzen-3.1.0-1.x86_64.rpm         # [DEB] apt install /tmp/kanzen_3.1.0-1_amd64.deb
   # le service redémarre s'il tournait ; les migrations s'appliquent au démarrage
   journalctl -u kanzen -n 30 --no-pager && kanzenctl check
   ```
   `/etc/kanzen/kanzen.env` est conservé. Si le paquet apporte un nouveau modèle, il est déposé à côté : `kanzen.env.rpmnew` [RPM], ou proposé par dpkg [DEB]. Comparer les deux et reporter les nouvelles variables.
5. **Retour arrière** : réinstaller la version précédente (`dnf downgrade` ou `apt install ./ancienne.deb`), puis restaurer la sauvegarde faite à l'étape 4. Une migration de schéma ne se défait pas autrement.

### 6.8 Maintenance périodique

| Fréquence | Action |
|---|---|
| Mensuelle | Mises à jour de sécurité OS et PostgreSQL (mineures) depuis le miroir interne, puis `systemctl restart postgresql kanzen` |
| Mensuelle | Revue du SBOM de la version déployée face aux avis de sécurité (CERT-FR) ; nouvelle version KanZen si nécessaire |
| Trimestrielle | Test de restauration (T14) |
| Trimestrielle | Revue des accès : membres de `GG_KanZen_Admins`, comptes locaux actifs, membres des espaces sensibles |
| Annuelle | Rotation du mot de passe de `svc-kanzen` (procédure ci-dessous) |
| Annuelle, ou à J-30 | Renouvellement du certificat TLS (§ 3.4), puis `systemctl reload nginx` |
| Après chaque usage | Contrôle de l'usage du compte `secours`, puis changement de son mot de passe (`kanzenctl create-admin secours`) |

Rotation du mot de passe du compte de service, sans interruption notable :

```bash
# 1. Changer le mot de passe dans l'AD (Set-ADAccountPassword), puis immédiatement :
vi /etc/kanzen/secrets/ldap_bind_password
systemctl restart kanzen
kanzenctl check jdupont
```

### 6.9 Désinstallation

```bash
dnf remove kanzen        # [DEB] apt remove kanzen
```

Le service est arrêté et désactivé. Les données (`/var/lib/kanzen`, `/var/backups/kanzen`), la configuration et le compte `kanzen` sont **conservés**. Pour un effacement définitif, le faire en connaissance de cause, après archivage :

```bash
runuser -u postgres -- dropdb kanzen && runuser -u postgres -- dropuser kanzen
rm -rf /var/lib/kanzen /var/backups/kanzen /etc/kanzen && userdel kanzen
```

---

## 7. Option conteneurs

Si l'hébergement cible est une plateforme de conteneurs (Podman, Docker, Kubernetes), les images peuvent remplacer les paquets.

```bash
# Zone connectée
cd KANZEN && docker build -t kanzen:3.0.0 .
docker pull postgres:16-alpine && docker pull caddy:2.8-alpine
docker save kanzen:3.0.0 postgres:16-alpine caddy:2.8-alpine | gzip > kanzen-images-3.0.0.tar.gz
sha256sum kanzen-images-3.0.0.tar.gz > kanzen-images-3.0.0.tar.gz.sha256
# Après le sas (mêmes contrôles qu'au § 2)
podman load -i kanzen-images-3.0.0.tar.gz      # ou docker load
```

Le fichier `docker-compose.yml` sert de base. Dans ce mode :

- les variables d'environnement restent celles du § 4.3, dans un `.env` en `0600` ;
- le volume des pièces jointes et celui de PostgreSQL sont **à sauvegarder** ;
- le certificat PKI est monté dans le reverse proxy ;
- le durcissement systemd est remplacé par celui du runtime : utilisateur non-root (déjà le cas dans l'image), `read_only`, `cap_drop: ALL`, `no-new-privileges`.

---

## 8. Récapitulatif des fichiers sur le serveur

| Chemin | Propriétaire | Droits | Contenu |
|---|---|---|---|
| `/opt/kanzen/` | root | 755 | Runtime Node et application (lecture seule) |
| `/etc/kanzen/kanzen.env` | root:kanzen | 640 | Configuration |
| `/etc/kanzen/secrets/ldap_bind_password` | root:kanzen | 640 | Secret du compte de service |
| `/etc/kanzen/secrets/database_url` | root:kanzen | 640 | Chaîne de connexion PostgreSQL |
| `/etc/kanzen/ca/corp-ca.pem` | root:kanzen | 640 | Chaîne CA pour LDAPS |
| `/etc/kanzen/tls/kanzen.{key,fullchain.pem}` | root:kanzen | 640 | Certificat du serveur web |
| `/etc/kanzen/gnupg/` | root:kanzen | 750 | Clé publique de chiffrement des sauvegardes |
| `/var/lib/kanzen/uploads/` | kanzen | 750 | Pièces jointes et images du wiki |
| `/var/backups/kanzen/` | kanzen | 750 | Archives de sauvegarde |
| `/etc/nginx/conf.d/kanzen.conf` | root | 644 | Reverse proxy |
| `/usr/sbin/kanzenctl` | root | 755 | Outil d'administration |

## 9. Points de vigilance (RSSI)

- **Comptes à privilèges** : `GG_KanZen_Admins` ne contient que des comptes d'administration nominatifs ; le compte `secours` est sous scellé et contrôlé.
- **Données** : le wiki et les pièces jointes peuvent contenir des informations sensibles (procédures, schémas). La classification de l'instance s'aligne sur la donnée la plus sensible hébergée. Les sauvegardes sont chiffrées et externalisées.
- **Chaîne d'approvisionnement** : build reproductible depuis un commit identifié, empreintes vérifiées de bout en bout, `npm audit` bloquant, SBOM livré. Aucune dépendance n'est téléchargée sur le réseau fermé.
- **Surface d'exposition** : seul nginx (443) est exposé ; l'application et PostgreSQL n'écoutent que localement. Aucun flux sortant vers Internet.
- **Résiduel connu** : la validation de bout en bout sous systemd réel, SELinux *enforcing* et un AD réel se fait pendant la recette (§ 5). Aucune limitation n'a été identifiée sur ces points lors des tests en conteneurs.
