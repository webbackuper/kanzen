import { Parser } from 'json2csv';

/**
 * Génère le contenu CSV des statistiques de mouvement.
 * @param {PrismaClient} prisma - Instance du client BDD.
 * @returns {Promise<string>} - Le contenu CSV brut.
 */
export async function generateStatsCSV(prisma) {
  // 1. Récupération des données enrichies
  const events = await prisma.taskEvent.findMany({
    include: {
      task: true, // Inclure le titre de la tâche
    },
    orderBy: {
      timestamp: 'desc' // Les plus récents d'abord
    }
  });

  if (events.length === 0) {
    return "Date,Tache,ID,De_Colonne,Vers_Colonne\n"; // Header vide
  }

  // 2. Transformation des données pour le format plat CSV
  const data = events.map(event => ({
    Date: event.timestamp.toISOString(),
    Tache: event.task ? event.task.content : 'Tâche supprimée',
    ID_Tache: event.taskId,
    De_Colonne: event.fromColumnId || 'CREATION',
    Vers_Colonne: event.toColumnId
  }));

  // 3. Parsing JSON -> CSV
  const json2csvParser = new Parser({
    fields: ['Date', 'Tache', 'ID_Tache', 'De_Colonne', 'Vers_Colonne'],
    delimiter: ','
  });

  return json2csvParser.parse(data);
}