# ⚡ KanZen - Modern Open Source Kanban

**KanZen** est une solution de gestion de projet auto-hébergée, conçue selon des principes de performance absolue et de simplicité. Elle combine la fluidité d'une Single Page App moderne avec la robustesse d'un backend minimaliste.

![KanZen Screenshot](https://via.placeholder.com/800x400?text=Interface+KanZen+Preview)

## ✨ Pourquoi KanZen ?

Contrairement aux usines à gaz habituelles, KanZen se concentre sur l'essentiel :
* **Performance** : Backend Fastify + Frontend React/Vite. Chargement instantané.
* **Zéro Dépendance Lourde** : Pas de Redis, pas de Postgres obligatoire. Tout tient dans une image Docker avec SQLite.
* **Sécurité RBAC** : Rôles Admin/User stricts intégrés au cœur de l'API.
* **Automatisation** : Moteur de règles (Si Tâche X -> Alors Webhook Y) natif.
* **Résilience** : Système de backup automatique avec rotation sur 7 jours.

## 🛠 Stack Technique

* **Frontend** : React 18, TailwindCSS, @dnd-kit (Drag & Drop), Recharts.
* **Backend** : Node.js 20, Fastify, Prisma ORM.
* **Database** : PostgreSQL 16 (voir `docs/01-etat-des-lieux.md`).
* **DevOps** : Docker Multi-stage build, Caddy (Reverse Proxy HTTPS).

## 🚀 Installation Rapide (Docker)

C'est la méthode recommandée pour la production.

1.  **Cloner le dépôt**
    ```bash
    git clone [https://github.com/votre-user/KanZen.git](https://github.com/votre-user/KanZen.git)
    cd KanZen
    ```

2.  **Configurer l'environnement**
    Copiez le fichier d'exemple et éditez le secret JWT.
    ```bash
    cp .env.example .env
    nano .env
    ```

3.  **Lancer la stack**
    ```bash
    docker-compose up -d --build
    ```
    *L'installation initiale prend environ 2 minutes (build du frontend + backend).*

4.  **Accéder à l'application**
    Ouvrez `http://localhost` (ou votre domaine configuré dans Caddyfile).

## 🔐 Comptes par défaut

Au premier lancement, la base de données est peuplée avec ces utilisateurs :

| Rôle | Email | Mot de passe | Accès |
| :--- | :--- | :--- | :--- |
| **Admin** | `admin@KanZen.io` | `password123` | Full access, Analytics, Backups |
| **User** | `manager@KanZen.io` | `password123` | Gestion des tâches uniquement |

> ⚠️ **Important** : Changez ces mots de passe immédiatement après la première connexion (ou supprimez `prisma/seed.js` avant le build).

## ⚙️ Fonctionnalités Avancées

### Sauvegardes
* **Automatique** : Tous les jours à 03:00 AM (fichiers conservés 7 jours dans `/backups`).
* **Manuel** : Via le bouton "Sauvegarder la base" dans le dashboard Analytics (Admin).

### Webhooks
Pour connecter KanZen à Slack/Discord :
1.  Connectez-vous en Admin.
2.  Utilisez l'API (ou via DB direct pour l'instant) pour créer une `Rule` :
    * `triggerId` : ID de la colonne "Done".
    * `action` : `SEND_WEBHOOK`.
    * `value` : `https://hooks.slack.com/...`.

## 🧑‍💻 Développement Local

Si vous souhaitez contribuer au code :

1.  Installer les dépendances : `npm install`
2.  Initialiser la DB : `npx prisma migrate dev`
3.  Lancer le mode dev (Client + Serveur) :
    ```bash
    npm run dev
    ```
    * Frontend : `http://localhost:5173`
    * Backend : `http://localhost:3000`

## 📄 Licence

Distribué sous licence MIT. Vous êtes libre de modifier et distribuer KanZen pour votre entreprise.