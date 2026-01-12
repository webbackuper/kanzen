import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import util from 'util';

const execPromise = util.promisify(exec);

/**
 * Crée une sauvegarde à chaud de la base SQLite et gère la rotation.
 * Utilise la variable DATABASE_URL pour trouver le fichier, peu importe son nom.
 * @returns {Promise<string>} Le chemin complet du fichier de sauvegarde créé.
 */
export async function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // 1. Récupération dynamique du chemin de la BDD
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    throw new Error("CRITIQUE : DATABASE_URL n'est pas définie. Impossible de localiser la base de données pour le backup.");
  }

  // Nettoyage du préfixe "file:" utilisé par Prisma pour obtenir le vrai chemin système
  // Ex: "file:/app/data/zenkan.db" deviendra "/app/data/zenkan.db"
  const dbPath = dbUrl.replace(/^file:/, '');

  // Chemin fixe pour les backups (correspondant au volume Docker monté)
  const backupDir = '/app/backups';
  const backupFile = path.join(backupDir, `backup-${timestamp}.db`);

  console.log(`🛡️  Démarrage de la sauvegarde de la base : ${dbPath}...`);

  try {
    // 2. S'assurer que le dossier de backup existe
    await fs.mkdir(backupDir, { recursive: true });

    // 3. Exécution de la commande SQLite .backup (Atomique et sûr)
    // Note: Cela nécessite que le paquet 'sqlite3' soit installé dans l'image Docker
    await execPromise(`sqlite3 "${dbPath}" ".backup '${backupFile}'"`);
    console.log(`✅ Sauvegarde réussie : ${backupFile}`);

    // 4. Rotation : Suppression des vieux backups (> 7 jours ou > 7 fichiers)
    const files = await fs.readdir(backupDir);
    const dbFiles = files
      .filter(f => f.endsWith('.db'))
      .map(f => path.join(backupDir, f))
      .sort(); // Tri alphabétique (correspondant à l'ordre chronologique via le timestamp ISO)

    // On garde seulement les 7 fichiers les plus récents
    if (dbFiles.length > 7) {
      const filesToDelete = dbFiles.slice(0, dbFiles.length - 7);
      for (const file of filesToDelete) {
        await fs.unlink(file);
        console.log(`🗑️  Rotation : Suppression de l'ancienne sauvegarde ${path.basename(file)}`);
      }
    }

    return backupFile;

  } catch (err) {
    console.error('❌ Échec critique de la sauvegarde :', err);
    // On propage l'erreur pour qu'elle puisse être gérée ou loguée par l'appelant
    throw err;
  }
}