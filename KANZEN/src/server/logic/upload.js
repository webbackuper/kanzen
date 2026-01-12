import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import util from 'util';

const pump = util.promisify(pipeline);

// Correction : Utilisation de process.cwd() pour cibler la racine du projet de manière fiable
// Dans Docker, process.cwd() est "/app". Le dossier uploads sera donc "/app/uploads"
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

// On s'assure que le dossier existe au chargement du module
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export async function handleUpload(prisma, taskId, multipartData) {
  // Sécurisation du nom de fichier pour éviter les écrasements
  const safeFilename = `${Date.now()}-${path.basename(multipartData.filename)}`;
  const savePath = path.join(UPLOAD_DIR, safeFilename);

  console.log(`[UPLOAD] Réception fichier pour tâche ${taskId} -> ${savePath}`);

  // 1. Écriture physique du fichier (Streaming)
  await pump(multipartData.file, fs.createWriteStream(savePath));

  // 2. Enregistrement en base de données
  // Note: 'path' stocké est l'URL relative accessible via le serveur statique
  const attachment = await prisma.attachment.create({
    data: {
      filename: multipartData.filename,
      mimetype: multipartData.mimetype,
      path: `/uploads/${safeFilename}`, 
      size: 0, // Idéalement, on récupérerait la taille réelle après écriture (fs.statSync(savePath).size)
      taskId: taskId
    }
  });

  return attachment;
}