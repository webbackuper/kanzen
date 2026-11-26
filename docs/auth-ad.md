# KanZen : authentification Active Directory et comptes locaux

## Principe

KanZen accepte deux sources d'authentification, activables séparément :

| Source | Variable | Usage |
|---|---|---|
| Active Directory (LDAPS) | `AUTH_LDAP_ENABLED=true` | Comptes du domaine, accès filtré par groupe |
| Comptes locaux | `AUTH_LOCAL_ENABLED=true` | Prestataires hors domaine, comptes de service, **admin de secours** quand l'AD est indisponible |

L'utilisateur saisit simplement son identifiant : `jdupont`, `CORP\jdupont` ou `jdupont@corp.local`.

**Règle de résolution :** si un compte **local** porte cet identifiant, il est vérifié localement. Sinon, l'AD est interrogé. Un compte AD qui porterait le même identifiant qu'un compte local est refusé, pour empêcher l'usurpation dans les deux sens.

## Déroulé d'une connexion AD

1. Bind LDAPS avec le **compte de service** (lecture seule).
2. Recherche de l'utilisateur : `LDAP_USER_FILTER`, avec `sAMAccountName` par défaut, la valeur étant échappée selon la RFC 4515.
3. Refus si le compte est désactivé (`userAccountControl` & 2).
4. Contrôle d'appartenance **récursive** (groupes imbriqués, `LDAP_MATCHING_RULE_IN_CHAIN 1.2.840.113556.1.4.1941`) à `GG_KanZen_Admins`, puis à `GG_KanZen_Users`.
5. **Bind avec le DN de l'utilisateur et son mot de passe** : c'est l'AD qui valide le mot de passe et applique sa propre politique de verrouillage. Un mot de passe vide est refusé avant tout appel, pour bloquer l'*unauthenticated bind*.
6. Provisionnement ou mise à jour du compte dans KanZen (clé stable : `objectGUID`). Le rôle est **recalculé à chaque connexion** : `GG_KanZen_Admins` donne ADMIN, `GG_KanZen_Users` donne USER.
7. Retirer l'utilisateur des groupes coupe l'accès dès sa connexion suivante et ferme ses sessions. Une session déjà ouverte expire au plus tard après `SESSION_TTL_HOURS`. Pour une coupure immédiate : **Comptes**, puis « Fermer ses sessions ».

Si plusieurs URL sont configurées (`LDAP_URL` séparées par des virgules), KanZen bascule sur le contrôleur de domaine suivant en cas d'indisponibilité réseau.

## Préparation côté AD (PowerShell, sur un DC ou un poste avec RSAT)

```powershell
# 1. Groupes d'accès (globaux, de sécurité)
New-ADGroup -Name "GG_KanZen_Users"  -GroupScope Global -GroupCategory Security -Path "OU=Groupes,DC=corp,DC=local" -Description "Accès à KanZen"
New-ADGroup -Name "GG_KanZen_Admins" -GroupScope Global -GroupCategory Security -Path "OU=Groupes,DC=corp,DC=local" -Description "Administrateurs KanZen"

# 2. Compte de service : lecture seule, sans ouverture de session interactive
New-ADUser -Name "svc-kanzen" -SamAccountName "svc-kanzen" -Path "OU=Comptes de service,DC=corp,DC=local" `
  -AccountPassword (Read-Host -AsSecureString "Mot de passe") -Enabled $true `
  -PasswordNeverExpires $true -CannotChangePassword $true -Description "Bind LDAP KanZen (lecture seule)"
# Recommandé : refuser l'ouverture de session locale et RDP par GPO (« Interdire l'ouverture de session locale »).

# 3. Membres
Add-ADGroupMember -Identity "GG_KanZen_Users"  -Members "jdupont","GG_Equipe_Infra"
Add-ADGroupMember -Identity "GG_KanZen_Admins" -Members "adm-jdupont"
```

Le compte de service n'a besoin d'**aucun droit particulier** : la lecture des utilisateurs et des attributs `memberOf` est ouverte par défaut aux *Utilisateurs authentifiés*.

## Prérequis réseau et PKI

- **LDAPS (636/TCP)** depuis le serveur KanZen vers les DC. LDAP en clair est refusé par la configuration, sauf `LDAP_STARTTLS=true` sur 389.
- Les DC doivent présenter un certificat émis par la PKI interne, avec le FQDN du DC dans le SAN.
- La **chaîne de la CA racine (et intermédiaire)** au format PEM doit être déposée sur le serveur et référencée par `LDAP_CA_FILE`. TLS 1.2 minimum.
- La résolution DNS des DC et le décalage horaire (NTP) doivent être corrects.

Test depuis le serveur KanZen :

```bash
openssl s_client -connect dc1.corp.local:636 -CAfile /etc/pki/ca-trust/source/anchors/corp-root-ca.pem -verify_return_error </dev/null
ldapsearch -H ldaps://dc1.corp.local -D "CN=svc-kanzen,OU=Comptes de service,DC=corp,DC=local" -W \
  -b "DC=corp,DC=local" "(&(sAMAccountName=jdupont)(memberOf:1.2.840.113556.1.4.1941:=CN=GG_KanZen_Users,OU=Groupes,DC=corp,DC=local))" dn
```

## Comptes locaux

- Création par un admin KanZen (**Comptes**, puis « Compte local ») avec un mot de passe temporaire. Le changement est **imposé** à la première connexion.
- Politique : 12 caractères minimum, au moins 3 classes de caractères, ne doit pas contenir l'identifiant. Hachage **argon2id** (m = 19 Mio, t = 2, p = 1).
- Verrouillage de `LOGIN_LOCK_MINUTES` après `LOGIN_MAX_ATTEMPTS` échecs, plus un rate limiting par IP.
- **Admin de secours** (bris de glace) : `npm run admin:create -- secours`, depuis le serveur. Il fonctionne même si l'AD est indisponible. À conserver sous enveloppe scellée ou dans un coffre, et à contrôler dans le journal d'audit.
- Pour n'autoriser que l'AD : `AUTH_LOCAL_ENABLED=false`. Dans ce cas, le compte de secours ne fonctionne plus, ce qui doit être un choix assumé.

## Journal d'audit

Événements tracés : `auth.login` (succès et échec, avec le motif), `auth.lockout`, `auth.logout`, `auth.password_change`, `user.provision`, `user.create`, `user.update`, `user.reset_password`, `user.revoke_sessions`, `workspace.*`, `board.delete`. Ils sont consultables dans **Audit** et émis en JSON sur stdout (champ `audit`) pour collecte par journald, rsyslog ou le SIEM.
