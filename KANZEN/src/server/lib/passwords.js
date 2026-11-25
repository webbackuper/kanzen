import argon2 from 'argon2';

// Paramètres argon2id recommandés par l'OWASP (m=19 Mio, t=2, p=1).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

// Hash factice : on vérifie quand même un mot de passe pour les comptes inexistants
// afin que le temps de réponse ne révèle pas l'existence d'un compte.
let dummyHash;
export async function dummyVerify(password) {
  dummyHash ??= await argon2.hash('kanzen-dummy-password', OPTIONS);
  await argon2.verify(dummyHash, String(password ?? ''));
  return false;
}

export const hashPassword = (password) => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash, password) {
  if (!hash || typeof password !== 'string') return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Politique : 12 caractères minimum, au moins 3 classes parmi minuscules, majuscules, chiffres, spéciaux. */
export function checkPasswordPolicy(password, { username } = {}) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 12) problems.push('12 caractères minimum');
  if (password && password.length > 256) problems.push('256 caractères maximum');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password ?? '')).length;
  if (classes < 3) problems.push('au moins 3 types de caractères parmi minuscules, majuscules, chiffres, spéciaux');
  if (username && password?.toLowerCase().includes(username.toLowerCase())) problems.push('ne doit pas contenir l\'identifiant');
  return problems;
}
