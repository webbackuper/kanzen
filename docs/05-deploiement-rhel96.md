# KanZen : procédure de déploiement sur RHEL 9.6 (réseau fermé, miroirs internes)

| | |
|---|---|
| Cible | Red Hat Enterprise Linux 9.6, x86_64, sans accès Internet |
| Dépôts | Miroirs **internes** des dépôts officiels Red Hat (BaseOS, AppStream), à jour |
| Livrable installé | `kanzen-<version>-<release>.x86_64.rpm` |
| Documents liés | [`04-plan-de-deploiement.md`](04-plan-de-deploiement.md) (plan générique, recette, exploitation), [`auth-ad.md`](auth-ad.md) (objets AD), [`03-packaging.md`](03-packaging.md) |

Ce document est **spécifique à RHEL 9.6**. Il répond à trois questions, dans l'ordre où elles se posent :

1. **Que faut-il récupérer côté connecté ?** (§ 1)
2. **Que faut-il installer depuis les miroirs internes, et les versions sont-elles compatibles ?** (§ 2 et § 3)
3. **Quelles informations faut-il réunir avant de lancer l'installation du RPM ?** (§ 4)

Les § 5 à 7 déroulent ensuite l'installation, dans l'ordre d'exécution. Les valeurs d'exemple (`corp.local`, `kanzen.corp.local`, `repo.corp.local`…) sont à remplacer par celles de la fiche du § 4.

---

## Synthèse

- **Rien d'autre que le RPM KanZen n'est à faire entrer par le sas.** Toutes les dépendances sont dans **BaseOS** et **AppStream**. Ni CodeReady Builder (CRB), ni EPEL, ni dépôt tiers ne sont nécessaires.
- **Node.js n'est pas à installer** : le RPM embarque son propre runtime (Node.js 24 LTS, binaire officiel) dans `/opt/kanzen/node`. Le module AppStream `nodejs` est inutile ; ne pas l'installer réduit la surface d'attaque.
- **Deux modules AppStream doivent être activés avant toute installation** : `postgresql:16` et `nginx:1.26`. Les versions par défaut de RHEL 9 (PostgreSQL 13 et nginx 1.20) ne conviennent pas.
- **Les miroirs internes doivent publier les métadonnées de modules** (`modules.yaml`). Sans elles, `dnf module` ne voit aucun flux et l'installation part sur les mauvaises versions. C'est le premier point à vérifier avec l'équipe qui gère les dépôts (§ 2.2).
- **Version de référence : `kanzen-3.2.0-2.x86_64.rpm`.** Par rapport à la 3.1.0, elle n'ajoute **aucun prérequis** système ni réseau, aucune variable de configuration et aucun flux de pare-feu ; ses deux migrations de schéma ne font qu'ajouter des tables et colonnes et s'appliquent seules au démarrage (§ 7.2). Le RPM `3.2.0-1` est antérieur aux correctifs de sécurité de la revue (identité AD, révocation des websockets) : ne pas le faire entrer par le sas.
- Deux corrections ont été apportées au paquet à l'occasion de cette vérification (§ 3.3) : le modèle nginx ne démarrait pas avec les versions de nginx livrées par RHEL 9, et le RPM accepte désormais uniquement un client PostgreSQL 14 ou plus.

---

## 1. Zone connectée : ce qu'il faut récupérer

### 1.1 Build

Le build se fait sur un poste Linux connecté, selon le § 1 du [plan générique](04-plan-de-deploiement.md#1-zone-connectée--récupération-des-sources-et-build) :

```bash
git clone https://github.com/webbackuper/kanzen.git && cd kanzen
git checkout <tag ou commit validé>
packaging/build.sh 3.2.0 2
cd dist && sha256sum -c SHA256SUMS
```

Contrôle des dépendances déclarées par le RPM, **avant** le passage du sas :

```bash
rpm -qpR kanzen-3.2.0-2.x86_64.rpm | grep -v '^rpmlib'
# Attendu :
#   ca-certificates
#   gzip
#   openssl-libs
#   postgresql >= 14
#   shadow-utils
#   tar
#   util-linux
rpm -qp --recommends kanzen-3.2.0-2.x86_64.rpm   # postgresql-server, nginx, gnupg2
```

### 1.2 Lot de transfert pour une cible RHEL 9.6

| Fichier | Obligatoire | Usage |
|---|---|---|
| `kanzen-<ver>-<rel>.x86_64.rpm` | **oui** | Paquet installé sur la cible |
| `SHA256SUMS` | **oui** | Contrôle d'intégrité après le sas |
| `sbom.cdx.json` | recommandé | Inventaire des composants (suivi des vulnérabilités par le RSSI) |
| `docs/05-deploiement-rhel96.md`, `docs/04-plan-de-deploiement.md`, `docs/auth-ad.md` | recommandé | Procédures, hors ligne |
| `RPM-GPG-KEY-kanzen` | si le RPM est signé (§ 1.3) | Clé publique à importer sur la cible |
| `kanzen-<ver>-linux-x64.tar.gz` | non | Bundle pour les distributions sans RPM ; inutile sur RHEL |

**À ne pas transférer** : RPM de PostgreSQL, nginx, Node.js ou de toute autre dépendance. Ils viennent des miroirs internes, qui portent les correctifs de sécurité Red Hat. Un RPM de dépendance transféré à la main ne serait jamais mis à jour.

Ce qui ne vient **pas** de la zone connectée, mais du SI cible : la chaîne de la PKI interne, le certificat serveur, le compte de service AD et son secret (§ 4).

### 1.3 Signature du RPM (recommandée, obligatoire si `localpkg_gpgcheck=1`)

Le RPM produit par `build.sh` **n'est pas signé** ; son intégrité est garantie par `SHA256SUMS`. Or les profils de durcissement (DISA STIG, CIS, ANSSI) imposent souvent `localpkg_gpgcheck=1` dans `/etc/dnf/dnf.conf`, et dnf refuse alors tout paquet local non signé.

Deux solutions, par ordre de préférence :

1. **Publier le RPM dans un dépôt interne signé** (dépôt « applications internes » sur Satellite, Pulp ou Nexus). La cible l'installe alors comme n'importe quel paquet, avec `gpgcheck=1`, et les mises à jour de KanZen suivent le même circuit que celles de l'OS.
2. **Signer le RPM avec une clé de l'organisation**, sur une machine RHEL/Rocky disposant de `rpm-sign`, après vérification des empreintes :
   ```bash
   # Poste de signature (clé privée détenue par l'équipe habilitée)
   rpm --define '_gpg_name KanZen Release <rpm-signing@corp.local>' --addsign kanzen-3.2.0-2.x86_64.rpm
   gpg --export --armor rpm-signing@corp.local > RPM-GPG-KEY-kanzen
   # Cible
   rpm --import RPM-GPG-KEY-kanzen
   rpm -K kanzen-3.2.0-2.x86_64.rpm      # attendu : digests signatures OK
   ```

---

## 2. Dépôts internes : configuration et contrôles

### 2.1 Informations à demander à l'équipe qui gère les miroirs

| Question | Pourquoi |
|---|---|
| Type de miroir : **Satellite** (inscription par clé d'activation) ou **miroir simple** (reposync, Pulp, Nexus, HTTP statique) ? | Détermine la méthode de configuration (§ 2.3 ou § 2.4) |
| URL de BaseOS et d'AppStream, protocole (HTTP ou HTTPS) | Fichier `.repo` |
| Si HTTPS : CA qui a émis le certificat du serveur de dépôts | À ajouter au magasin de confiance système |
| **Les métadonnées de modules sont-elles publiées ?** (`modules.yaml`, présent si la synchronisation est faite avec `reposync --download-metadata` ou par Satellite/Pulp) | Indispensable pour `dnf module enable` |
| Version mineure suivie : « dernière RHEL 9 » (`rhel-9-for-x86_64-*-rpms`) ou **EUS 9.6** (`rhel-9-for-x86_64-*-eus-rpms`) ? | Avec les dépôts « dernière version », un `dnf update` fait passer le serveur en 9.7 ou plus. Si la cible doit **rester en 9.6**, il faut les dépôts EUS et un `releasever` figé |
| Fréquence de synchronisation | Délai d'arrivée des correctifs de sécurité sur la cible |
| Existe-t-il un dépôt pour les applications internes ? | Diffusion du RPM KanZen (§ 1.3) |
| Accès au portail Red Hat (même indirect) pour les errata et le cycle de vie des Application Streams | Suivi des fins de support de PostgreSQL 16 et nginx 1.26 |

### 2.2 Contrôles préalables sur la cible

```bash
cat /etc/redhat-release                 # Red Hat Enterprise Linux release 9.6 (Plow)
uname -m                                # x86_64
rpm -q redhat-release                   # fournit la clé /etc/pki/rpm-gpg/RPM-GPG-KEY-redhat-release
dnf repolist -v | grep -E 'Repo-(id|baseurl)'
dnf clean all && dnf makecache
dnf module list postgresql nginx        # doit lister les flux ; sinon, voir ci-dessous
```

La sortie doit faire apparaître **au moins** les flux `postgresql 16` et `nginx 1.26` (la présentation exacte des profils peut varier selon la version de dnf).

**Si la commande répond « No matching Modules to list »**, le miroir ne publie pas `modules.yaml`. Ne pas contourner en installant les paquets un par un : dnf prendrait PostgreSQL 13 et nginx 1.20. Demander à l'équipe des dépôts de resynchroniser avec les métadonnées de modules.

### 2.3 Cas Satellite

```bash
# Le RPM de CA du Satellite est fourni par le Satellite lui-même (URL interne)
dnf install -y http://satellite.corp.local/pub/katello-ca-consumer-latest.noarch.rpm
subscription-manager register --org='<Organisation>' --activationkey='<clé RHEL9-KanZen>'
subscription-manager repos --list-enabled
# Si la cible doit rester en 9.6 (dépôts EUS activés dans la clé d'activation) :
subscription-manager release --set=9.6
```

### 2.4 Cas miroir simple (fichier `.repo`)

Si le serveur de dépôts est en HTTPS avec un certificat de la PKI interne :

```bash
cp corp-root-ca.pem /etc/pki/ca-trust/source/anchors/
update-ca-trust
```

`/etc/yum.repos.d/rhel9-interne.repo` (adapter les URL à l'arborescence du miroir) :

```ini
[rhel-9-baseos-interne]
name=RHEL 9 BaseOS (miroir interne)
baseurl=https://repo.corp.local/rhel9/$releasever/$basearch/baseos/
enabled=1
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-redhat-release
sslverify=1

[rhel-9-appstream-interne]
name=RHEL 9 AppStream (miroir interne)
baseurl=https://repo.corp.local/rhel9/$releasever/$basearch/appstream/
enabled=1
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-redhat-release
sslverify=1
```

- `gpgcheck=1` est **obligatoire** : la signature Red Hat de chaque paquet reste vérifiée, même à travers un miroir interne. C'est ce qui garantit qu'un miroir compromis ne peut pas injecter de paquet.
- Empêcher `subscription-manager` de régénérer `redhat.repo` vers le CDN Red Hat, injoignable :
  ```bash
  subscription-manager config --rhsm.manage_repos=0
  ```
- Si la cible doit rester en 9.6 et que le miroir publie une arborescence par version mineure : `echo 9.6 > /etc/dnf/vars/releasever`.

---

## 3. Prérequis depuis les miroirs : versions et compatibilité

### 3.1 Ce que le RPM exige, et ce que RHEL 9.6 fournit

| Exigence de KanZen | Fournie par RHEL 9.6 | Dépôt | Verdict |
|---|---|---|---|
| `postgresql >= 14` (client : `pg_dump`, `pg_restore`, `psql`) | `postgresql` 16.x, module **`postgresql:16`** | AppStream | OK, **après activation du module** |
| Serveur PostgreSQL ≥ 14 (Recommends `postgresql-server`) | `postgresql-server` 16.x, module `postgresql:16` | AppStream | OK |
| Reverse proxy (Recommends `nginx`) | `nginx` 1.26, module **`nginx:1.26`** | AppStream | OK (le flux 1.26 est arrivé avec RHEL 9.6) |
| `openssl-libs` (moteur de migration Prisma : `libssl.so.3`) | OpenSSL 3.x | BaseOS | OK |
| `tar`, `gzip`, `util-linux` (`runuser`), `shadow-utils` (`useradd`), `ca-certificates` | paquets de base | BaseOS | OK |
| Recommends `gnupg2` (chiffrement des sauvegardes) | GnuPG 2.3 | BaseOS | OK |
| Runtime Node.js ≥ 22.12 | **embarqué** dans le RPM (Node.js 24 LTS, `/opt/kanzen/node`) | — | Aucune dépendance système |
| glibc ≥ 2.28, `libstdc++` (Node.js officiel, module natif `argon2`) | glibc 2.34, libstdc++ de GCC 11 | BaseOS | OK, présents dès l'installation minimale |
| Extensions PostgreSQL | aucune (recherche plein texte avec la configuration `french`, intégrée) | — | `postgresql-contrib` inutile |

Pourquoi pas les versions par défaut :

- **PostgreSQL 13** (flux par défaut de RHEL 9, hors module) : version arrivée en fin de support communautaire en novembre 2025, et en dessous du minimum de KanZen (14). De plus, `pg_dump` refuse de sauvegarder un serveur de version majeure supérieure à la sienne : un client 13 face à un serveur 16 casserait les sauvegardes. Le RPM exige désormais `postgresql >= 14`, donc dnf refuse l'installation au lieu de laisser passer cette erreur.
- **nginx 1.20** (flux par défaut) : fonctionne avec le modèle corrigé, mais c'est la version la plus ancienne, et elle sortira du support avant les flux modulaires. Le flux 1.26 est le plus récent disponible en 9.6.

Le cycle de vie exact de chaque flux est publié par Red Hat (« Red Hat Enterprise Linux Application Streams Life Cycle ») : le faire vérifier par l'équipe des dépôts et l'inscrire au plan de maintien en condition de sécurité.

### 3.2 Installation des prérequis

```bash
# 1. Activer les bons flux AVANT toute installation (sinon dnf prend les versions par défaut)
dnf module reset -y postgresql nginx
dnf module enable -y postgresql:16 nginx:1.26
dnf module list --enabled

# 2. Prérequis KanZen
dnf install -y postgresql-server postgresql nginx gnupg2 openssl-libs \
               tar gzip util-linux shadow-utils ca-certificates

# 3. Outils d'exploitation, de diagnostic et de durcissement
dnf install -y openssl openldap-clients bind-utils policycoreutils-python-utils \
               glibc-langpack-fr chrony firewalld

# 4. Vérification des versions effectivement installées
rpm -q postgresql postgresql-server nginx openssl-libs glibc gnupg2
psql --version        # psql (PostgreSQL) 16.x
nginx -v              # nginx/1.26.x
```

- `glibc-langpack-fr` est nécessaire pour initialiser la base en `fr_FR.UTF-8` (tri alphabétique français) ; sinon, utiliser `C.UTF-8`.
- **Ne pas installer** `nodejs`, `npm`, ni de compilateur : rien n'est compilé sur la cible.
- Si PostgreSQL est hébergé sur **un autre serveur** (instance mutualisée) : n'installer que `postgresql` (client) sur la VM KanZen, et vérifier que sa version majeure est **supérieure ou égale** à celle du serveur distant (sinon `pg_dump` échoue). Le serveur distant doit être en version 14 ou plus.

### 3.3 Corrections apportées au paquet

La vérification contre RHEL 9.6 a mis en évidence deux défauts, corrigés dans le dépôt :

| Défaut | Effet | Correction |
|---|---|---|
| Le modèle `/usr/share/kanzen/nginx/kanzen.conf` utilisait la directive `http2 on;`, qui n'existe qu'à partir de nginx 1.25.1 | `nginx -t` échouait (`unknown directive "http2"`) avec nginx 1.20, 1.22 et 1.24, c'est-à-dire les flux par défaut de RHEL 9 mais aussi Debian 12 et Ubuntu 24.04 | Syntaxe `listen 443 ssl http2;`, acceptée par toutes les versions. Vérifié avec nginx 1.24 (échec avant, succès après) |
| Le RPM dépendait de `postgresql` sans version | Installé sans activer le module, il tirait le client PostgreSQL 13, incompatible avec un serveur 16 | `Requires: postgresql >= 14` |

Avec nginx 1.26, `nginx -t` affiche un avertissement `the "listen ... http2" directive is deprecated`. Il est sans conséquence ; on peut, au choix, le laisser, ou remplacer dans `/etc/nginx/conf.d/kanzen.conf` les deux `listen … http2` par `listen 443 ssl;` / `listen [::]:443 ssl;` suivis de `http2 on;`.

---

## 4. Informations à réunir avant de lancer l'installation

Fiche à remplir **avant** l'intervention. Chaque ligne indique qui la fournit et où elle sert.

### 4.1 Système et réseau

| Information | Exemple | Fournie par | Utilisée dans |
|---|---|---|---|
| Nom et IP de la VM | `kanzen01.corp.local`, `10.10.0.50` | Équipe système / réseau | DNS, certificat (SAN) |
| FQDN du service (nom publié aux utilisateurs) | `kanzen.corp.local` | Projet | `PUBLIC_URL`, `server_name`, certificat |
| Enregistrements DNS créés (A + PTR de la VM, A ou CNAME du service) | — | Équipe DNS | § 5.1 |
| Serveurs NTP | les DC | Équipe AD | `/etc/chrony.conf` |
| Volumes de données (LVM) | `/var/lib/pgsql`, `/var/lib/kanzen`, `/var/backups/kanzen` | Équipe système | Dimensionnement : § 3.1 du plan générique |
| Plages réseau autorisées à joindre le service en HTTPS | `10.0.0.0/8` | Réseau / RSSI | firewalld |
| Ouverture des flux sortants vers les DC (TCP 636) | — | Réseau | LDAPS |

### 4.2 Sécurité du système

| Information | Commande de contrôle | Conséquence |
|---|---|---|
| SELinux | `getenforce` → **Enforcing** attendu | Booléen et contextes du § 5.4. Ne jamais passer en permissive pour « faire marcher » |
| fapolicyd actif ? | `systemctl is-active fapolicyd` | Les fichiers installés par RPM sont approuvés d'office (base RPM). Seul le bundle `.tar.gz` nécessiterait une règle de confiance |
| Mode FIPS ? | `fips-mode-setup --check` | **Point RSSI**, voir ci-dessous |
| Politique cryptographique | `update-crypto-policies --show` | `DEFAULT` : RAS. `FUTURE` : certificat serveur RSA ≥ 3072 bits ou ECDSA P-256 obligatoire |
| `localpkg_gpgcheck` | `grep -i gpgcheck /etc/dnf/dnf.conf` | Si `1` : RPM signé ou dépôt interne obligatoire (§ 1.3) |
| Options de montage | `findmnt /var/lib/kanzen /tmp` | `noexec` accepté sur `/var/lib/kanzen`, `/var/backups/kanzen` et `/tmp` |

**Mode FIPS.** nginx et PostgreSQL utilisent l'OpenSSL du système, donc le module cryptographique validé FIPS de RHEL. En revanche, le runtime Node.js embarqué contient **sa propre** bibliothèque OpenSSL, qui n'est pas le module validé : le client LDAPS de KanZen (vers les DC) et la génération des jetons de session se font en dehors du périmètre FIPS. Le hachage des mots de passe locaux utilise Argon2id, qui n'est pas un algorithme approuvé FIPS. Si la cible est en mode FIPS par obligation réglementaire, ce point demande une **décision du RSSI** : acceptation documentée, ou évolution du packaging pour s'appuyer sur le Node.js 22 d'AppStream (construit sur l'OpenSSL système). Le service fonctionne dans les deux cas ; il s'agit de conformité, pas de fonctionnement.

### 4.3 PKI

| Information | Exemple | Utilisée dans |
|---|---|---|
| CA racine (PEM) | `corp-root-ca.pem` | Confiance système, `LDAP_CA_FILE` |
| CA intermédiaire émettrice (PEM) | `corp-issuing-ca.pem` | Chaîne nginx, `LDAP_CA_FILE` |
| Modèle de certificat serveur web (AD CS) et circuit de demande | `WebServer` | § 5.5 |
| Certificat serveur émis (SAN : FQDN du service **et** de la VM), clé RSA 3072 | `kanzen.crt` | nginx |
| CA ayant émis les certificats LDAPS des DC (souvent la même) | — | `LDAP_CA_FILE` |

### 4.4 Active Directory

Objets à créer au préalable : voir [`auth-ad.md`](auth-ad.md).

| Information | Exemple | Variable de `/etc/kanzen/kanzen.env` |
|---|---|---|
| Contrôleurs de domaine en LDAPS (FQDN présent dans le SAN de leur certificat) | `ldaps://dc1.corp.local:636,ldaps://dc2.corp.local:636` | `LDAP_URL` |
| Base de recherche | `DC=corp,DC=local` | `LDAP_BASE_DN` |
| DN du compte de service (lecture seule) | `CN=svc-kanzen,OU=Comptes de service,DC=corp,DC=local` | `LDAP_BIND_DN` |
| Mot de passe du compte de service (remis par le canal des secrets, jamais par mail ni ticket) | — | fichier `/etc/kanzen/secrets/ldap_bind_password` |
| DN du groupe d'accès (groupes imbriqués pris en compte) | `CN=GG_KanZen_Users,OU=Groupes,DC=corp,DC=local` | `LDAP_GROUP_USERS` |
| DN du groupe d'administration | `CN=GG_KanZen_Admins,OU=Groupes,DC=corp,DC=local` | `LDAP_GROUP_ADMINS` |
| Un compte AD de test, membre du groupe d'accès | `jdupont` | `kanzenctl check jdupont` |
| Identifiant de l'administrateur local de secours | `secours` | `kanzenctl create-admin` |

**Identifiants réattribués.** KanZen rattache un compte à son **objectGUID**, pas à son `sAMAccountName` : un identifiant réattribué à un nouvel agent n'hérite jamais des espaces ni des pages de l'ancien titulaire (détail : [`auth-ad.md`](auth-ad.md#départs-et-mutations--synchronisation-ad)). Deux points à faire confirmer par l'équipe AD :
- la politique de **réemploi des identifiants** (homonymes, retours d'agents avec un nouveau compte) : tant que l'ancien compte KanZen est actif, la connexion du nouveau titulaire est refusée, et un administrateur KanZen doit d'abord désactiver l'ancien compte ;
- toute **migration de domaine (ADMT)** prévue : elle change les objectGUID et crée donc de nouveaux comptes KanZen, droits à redonner.

### 4.5 Base de données

| Information | Valeur par défaut | Remarque |
|---|---|---|
| Instance : locale (recommandé) ou serveur PostgreSQL mutualisé | locale | Si mutualisée : hôte, port, version (≥ 14), CA TLS du serveur |
| Nom de la base et du rôle | `kanzen` / `kanzen` | |
| Mot de passe du rôle | généré au § 5.3 | Jamais saisi en clair ; stocké dans `/etc/kanzen/secrets/database_url` |
| Locale de la base | `fr_FR.UTF-8` | Nécessite `glibc-langpack-fr` |

### 4.6 Exploitation

| Information | Exemple | Utilisée dans |
|---|---|---|
| Destinataire GPG des sauvegardes (clé **publique** seulement) | `sauvegardes@corp.local` | `BACKUP_GPG_RECIPIENT` |
| Cible d'externalisation des sauvegardes | NFS, serveur de sauvegarde | § 6.3 du plan générique |
| Durée de rétention locale | 14 jours | `BACKUP_RETENTION_DAYS` |
| Collecteur syslog / SIEM | `siem.corp.local:6514` | rsyslog, § 6.5 du plan générique |
| Durée et inactivité de session | 8 h / 60 min | `SESSION_TTL_HOURS`, `SESSION_IDLE_MINUTES` |

---

## 5. Préparation de la cible

Toutes les commandes sont exécutées **en root** sur la VM. Les prérequis du § 3.2 sont installés.

### 5.1 Heure, DNS, locale

```bash
timedatectl set-timezone Europe/Paris
sed -i 's/^\(pool\|server\) /#&/' /etc/chrony.conf
printf 'server dc1.corp.local iburst\nserver dc2.corp.local iburst\n' >> /etc/chrony.conf
systemctl enable --now chronyd && chronyc tracking      # décalage < 1 s

getent hosts kanzen.corp.local dc1.corp.local dc2.corp.local
dig +short -x 10.10.0.50                                 # PTR de la VM
```

### 5.2 Pare-feu

```bash
systemctl enable --now firewalld
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-service=http          # redirection vers HTTPS uniquement
# Optionnel : restreindre la source
# firewall-cmd --permanent --zone=internal --add-source=10.0.0.0/8 --add-service=https --add-service=http
firewall-cmd --reload && firewall-cmd --list-all
```

PostgreSQL (5432) et l'application (3000) n'écoutent que sur `127.0.0.1` : aucune ouverture n'est nécessaire.

### 5.3 PostgreSQL 16

```bash
# Si /var/lib/pgsql est un volume dédié, le monter AVANT, puis :
restorecon -Rv /var/lib/pgsql

# Initialisation : sommes de contrôle des pages, UTF-8, authentification sans « ident »
PGSETUP_INITDB_OPTIONS="--data-checksums --encoding=UTF8 --locale=fr_FR.UTF-8 --auth-local=peer --auth-host=scram-sha-256" \
  postgresql-setup --initdb
```

> Point propre à RHEL : sans `--auth-host=scram-sha-256`, le `pg_hba.conf` généré utilise la méthode `ident` pour les connexions TCP locales. L'application échoue alors avec `Ident authentication failed for user "kanzen"`.

Dans `/var/lib/pgsql/data/postgresql.conf` :

```ini
listen_addresses = 'localhost'
password_encryption = scram-sha-256
shared_buffers = 1GB                    # ≈ 25 % de la RAM
effective_cache_size = 3GB              # ≈ 75 % de la RAM
log_connections = on
log_disconnections = on
log_line_prefix = '%m [%p] %q%u@%d '
log_min_duration_statement = 1000
```

Dans `/var/lib/pgsql/data/pg_hba.conf`, ne conserver que :

```
local   all       postgres                    peer
local   all       all                         peer
host    kanzen    kanzen    127.0.0.1/32      scram-sha-256
host    kanzen    kanzen    ::1/128           scram-sha-256
```

```bash
systemctl enable --now postgresql

PGPASS=$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v pw="$PGPASS" <<'SQL'
CREATE ROLE kanzen LOGIN PASSWORD :'pw';
CREATE DATABASE kanzen OWNER kanzen ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE kanzen FROM PUBLIC;
\c kanzen
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO kanzen;
SQL
```

Garder la variable `PGPASS` dans ce shell jusqu'au § 6.2.

### 5.4 SELinux

```bash
getenforce                                           # Enforcing
setsebool -P httpd_can_network_connect 1             # nginx -> 127.0.0.1:3000
```

Le contexte des certificats est posé au § 6.4, une fois les fichiers en place.

---

## 6. Installation de KanZen

### 6.1 Contrôle et installation du RPM

```bash
cd /root/kanzen-livraison
sha256sum -c --ignore-missing SHA256SUMS
rpm -K kanzen-3.2.0-2.x86_64.rpm                      # « digests signatures OK » si signé

# Simulation : la résolution ne doit proposer AUCUN paquet extérieur aux miroirs internes,
# ni PostgreSQL 13, ni nodejs
dnf install --assumeno ./kanzen-3.2.0-2.x86_64.rpm

dnf install -y ./kanzen-3.2.0-2.x86_64.rpm            # ou : dnf install -y kanzen (dépôt interne)
kanzenctl version
```

Le paquet crée le compte système `kanzen`, l'arborescence (`/opt/kanzen`, `/etc/kanzen`, `/var/lib/kanzen`, `/var/backups/kanzen`) et les unités systemd, **sans les démarrer**.

### 6.2 Secrets et configuration

```bash
# Chaîne de connexion PostgreSQL, hors du fichier de configuration
install -m 0640 -o root -g kanzen /dev/null /etc/kanzen/secrets/database_url
printf 'postgresql://kanzen:%s@127.0.0.1:5432/kanzen?schema=public' "$PGPASS" > /etc/kanzen/secrets/database_url
unset PGPASS

# Mot de passe du compte de service AD (une seule ligne)
install -m 0640 -o root -g kanzen /dev/null /etc/kanzen/secrets/ldap_bind_password
vi /etc/kanzen/secrets/ldap_bind_password

# CA pour LDAPS : racine + intermédiaire, PEM
cat corp-root-ca.pem corp-issuing-ca.pem > /etc/kanzen/ca/corp-ca.pem
chown root:kanzen /etc/kanzen/ca/corp-ca.pem && chmod 0640 /etc/kanzen/ca/corp-ca.pem
```

Dans `/etc/kanzen/kanzen.env` (valeurs du § 4) :

```ini
PUBLIC_URL=https://kanzen.corp.local
# supprimer la ligne DATABASE_URL=… et la remplacer par :
DATABASE_URL_FILE=/etc/kanzen/secrets/database_url

AUTH_LOCAL_ENABLED=true
AUTH_LDAP_ENABLED=true
LDAP_URL=ldaps://dc1.corp.local:636,ldaps://dc2.corp.local:636
LDAP_BIND_DN=CN=svc-kanzen,OU=Comptes de service,DC=corp,DC=local
LDAP_BIND_PASSWORD_FILE=/etc/kanzen/secrets/ldap_bind_password
LDAP_BASE_DN=DC=corp,DC=local
LDAP_GROUP_USERS=CN=GG_KanZen_Users,OU=Groupes,DC=corp,DC=local
LDAP_GROUP_ADMINS=CN=GG_KanZen_Admins,OU=Groupes,DC=corp,DC=local
LDAP_CA_FILE=/etc/kanzen/ca/corp-ca.pem

# Si le chiffrement des sauvegardes est retenu (§ 6.3 du plan générique)
# BACKUP_GPG_RECIPIENT=sauvegardes@corp.local
```

Le détail de chaque paramètre est au § 4.3 du [plan générique](04-plan-de-deploiement.md).

### 6.3 Initialisation et diagnostic

```bash
kanzenctl migrate                 # crée le schéma
kanzenctl check jdupont           # configuration, base, stockage, bind AD, groupes, compte de test
kanzenctl create-admin secours    # administrateur local de secours (mot de passe sur l'entrée standard)
```

Le diagnostic doit se terminer par « Tout est conforme ». En cas d'échec AD, suivre le § 6.2 du plan générique (`openssl s_client`, `ldapsearch`).

### 6.4 Certificat serveur et nginx

```bash
cd /etc/kanzen/tls
openssl req -new -newkey rsa:3072 -nodes -keyout kanzen.key -out kanzen.csr \
  -subj "/CN=kanzen.corp.local" \
  -addext "subjectAltName=DNS:kanzen.corp.local,DNS:kanzen01.corp.local" \
  -addext "extendedKeyUsage=serverAuth"
chown root:kanzen kanzen.key && chmod 0640 kanzen.key
# … soumission de kanzen.csr à la PKI, récupération de kanzen.crt (PEM) …
cat kanzen.crt corp-issuing-ca.pem > kanzen.fullchain.pem
openssl verify -CAfile corp-root-ca.pem -untrusted corp-issuing-ca.pem kanzen.crt    # OK

# Contexte SELinux des certificats lus par nginx
semanage fcontext -a -t cert_t '/etc/kanzen/tls(/.*)?'
restorecon -Rv /etc/kanzen/tls

cp /usr/share/kanzen/nginx/kanzen.conf /etc/nginx/conf.d/kanzen.conf
sed -i 's/kanzen\.corp\.local/<FQDN du service>/g' /etc/nginx/conf.d/kanzen.conf
nginx -t
systemctl enable --now nginx
```

### 6.5 Démarrage et contrôles

```bash
systemctl enable --now kanzen kanzen-backup.timer
systemctl status kanzen --no-pager
journalctl -u kanzen -n 50 --no-pager
curl -fsS https://kanzen.corp.local/api/health          # {"status":"ok"}

# Contrôles propres à RHEL
ps -eZ | grep -E 'kanzen|node|nginx'     # node : unconfined_service_t ; nginx : httpd_t
ausearch -m AVC -ts recent               # aucune ligne attendue
# Révocation : désactiver un compte de test dans l'AD (ou le retirer du groupe), puis
kanzenctl ad-sync                        # compte désactivé ; ses onglets ouverts perdent le temps réel en 60 s au plus
kanzenctl backup && ls -l /var/backups/kanzen/
```

La recette technique, sécurité et fonctionnelle se poursuit avec le § 5 du [plan générique](04-plan-de-deploiement.md#5-recette).

---

## 7. Maintien en condition opérationnelle et de sécurité

### 7.1 Mises à jour de l'OS

```bash
dnf update                 # les flux postgresql:16 et nginx:1.26 restent figés : seules leurs versions mineures évoluent
systemctl restart postgresql nginx kanzen    # ou redémarrage planifié de la VM
```

- Un changement de version majeure de PostgreSQL (16 vers une version ultérieure) n'est **jamais** automatique : il suppose `dnf module switch-to`, puis `pg_upgrade` ou une sauvegarde et restauration. À planifier comme un changement, avec une sauvegarde `kanzenctl backup` vérifiée juste avant.
- Si les miroirs suivent « la dernière RHEL 9 » et non EUS, la VM change de version mineure à chaque `dnf update` (9.6 vers 9.7…). C'est le comportement normal de RHEL ; il faut seulement qu'il soit choisi et non subi (§ 2.1).

### 7.2 Mises à jour de KanZen

```bash
kanzenctl backup
dnf install -y ./kanzen-3.2.0-2.x86_64.rpm   # ou dnf update kanzen (dépôt interne)
```

Le paquet redémarre le service s'il tournait ; les migrations de schéma s'appliquent au démarrage. Pour la montée 3.1.0 vers 3.2.0-2, ce sont `20261126120000_kanban_wiki_lot1` et `20261126140000_kanban_wiki_lot2_3`, qui ne font qu'ajouter des tables et des colonnes (aucune suppression ni réécriture de données) : `journalctl -u kanzen -b | grep -i migration` doit les montrer appliquées. Les diagrammes Mermaid et l'impression du wiki sont embarqués dans l'interface : rien à ouvrir, aucun CDN. `/etc/kanzen/kanzen.env` n'est jamais écrasé (`%config(noreplace)`) ; s'il a été modifié, la nouvelle version du modèle est déposée en `kanzen.env.rpmnew`, à comparer.

### 7.3 Suivi des vulnérabilités

| Composant | Source des correctifs |
|---|---|
| OS, PostgreSQL, nginx, OpenSSL système | Errata Red Hat, via les miroirs internes |
| Node.js embarqué, dépendances npm | **Nouvelle version du RPM KanZen** : rebuild côté connecté (`build.sh` refuse toute vulnérabilité *high* ou *critical*), puis passage du sas |

Le SBOM (`sbom.cdx.json`) livré avec chaque version permet au RSSI de croiser les composants embarqués avec les avis de sécurité, sans accès à la cible.

---

## Annexe : dépannage propre à RHEL 9.6

| Symptôme | Cause probable | Action |
|---|---|---|
| `dnf module list` : « No matching Modules to list » | Miroir sans `modules.yaml` | Resynchronisation par l'équipe des dépôts (§ 2.2) |
| `dnf install kanzen…rpm` : `nothing provides postgresql >= 14` | Module `postgresql:16` non activé | `dnf module enable postgresql:16` |
| `Package kanzen… is not signed` | `localpkg_gpgcheck=1` | Signer le RPM ou passer par le dépôt interne (§ 1.3) |
| `nginx -t` : `unknown directive "http2"` | Modèle antérieur à la correction | Mettre à jour le RPM, ou remplacer `http2 on;` par `listen 443 ssl http2;` |
| nginx : `502 Bad Gateway`, AVC `name_connect` dans `audit.log` | Booléen SELinux absent | `setsebool -P httpd_can_network_connect 1` |
| nginx : `cannot load certificate`, AVC sur `/etc/kanzen/tls` | Contexte SELinux des certificats | `semanage fcontext` + `restorecon` (§ 6.4) |
| `Ident authentication failed for user "kanzen"` | `pg_hba.conf` RHEL par défaut | Méthode `scram-sha-256` (§ 5.3), `systemctl reload postgresql` |
| `pg_dump: error: aborting because of server version mismatch` | Client plus ancien que le serveur | Aligner le client sur la version majeure du serveur |
| `initdb: invalid locale name "fr_FR.UTF-8"` | Pack de langue absent | `dnf install glibc-langpack-fr` |
| Service KanZen bloqué au démarrage, AVC ou refus fapolicyd (`ausearch -m FANOTIFY`) | Fichiers modifiés hors RPM, ou installation par le bundle | Réinstaller par le RPM ; pour le bundle, `fapolicyd-cli --file add /opt/kanzen/ && fapolicyd-cli --update` |
