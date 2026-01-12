import bcrypt from 'bcryptjs';

/**
 * Hache un mot de passe pour le stocker en base de données.
 * @param {string} password - Le mot de passe en clair.
 * @returns {Promise<string>} - Le hash sécurisé.
 */
export async function hashPassword(password) {
  // Le "salt" est généré automatiquement par bcrypt avec un coût de 10
  return await bcrypt.hash(password, 10);
}

/**
 * Compare un mot de passe en clair avec un hash.
 * @param {string} password - Mot de passe fourni par l'utilisateur.
 * @param {string} hash - Hash stocké en BDD.
 * @returns {Promise<boolean>}
 */
export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

/**
 * Middleware (Décorateur) pour vérifier les rôles utilisateurs.
 * S'assure que l'utilisateur connecté a les droits nécessaires.
 * @param {Array<string>} roles - Liste des rôles autorisés (ex: ['ADMIN']).
 */
export const authorize = (roles) => {
  return async (request, reply) => {
    // request.user est peuplé par @fastify/jwt lors de la vérification du token
    if (!request.user || !request.user.role) {
      return reply.code(401).send({ error: "Non authentifié" });
    }

    const { role } = request.user;
    
    if (!roles.includes(role)) {
      return reply.code(403).send({ 
        error: `Accès interdit. Rôle requis : ${roles.join(' ou ')}` 
      });
    }
  };
};