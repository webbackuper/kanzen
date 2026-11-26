// Modèles de pages proposés à la création. Documents ProseMirror (mêmes nœuds que l'éditeur).
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...parts) => {
  const c = parts.filter((x) => x !== '');
  return { type: 'paragraph', ...(c.length ? { content: c.map((x) => (typeof x === 'string' ? t(x) : x)) } : {}) };
};
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const ul = (...items) => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const ol = (...items) => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const todo = (...items) => ({ type: 'taskList', content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(i)] })) });
const callout = (variant, ...c) => ({ type: 'callout', attrs: { variant }, content: c });
const code = (language, text) => ({ type: 'codeBlock', attrs: { language }, content: [t(text)] });
const b = (text) => t(text, [{ type: 'bold' }]);
const table = (...rows) => ({
  type: 'table',
  content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((cell) => ({ type: i === 0 ? 'tableHeader' : 'tableCell', content: [p(...(cell ? [cell] : []))] })) })),
});
const doc = (...content) => ({ type: 'doc', content });

export const TEMPLATES = [
  { id: 'blank', title: 'Page vierge', icon: '📄', description: 'Une page vide.', content: null },
  {
    id: 'procedure', title: 'Procédure d\'exploitation', icon: '🛠️', description: 'Runbook : prérequis, étapes, vérification, retour arrière.',
    content: doc(
      callout('info', p(b('Objet : '), 'à quoi sert cette procédure, quand l\'appliquer.')),
      h(2, 'Prérequis'), todo('Accès nécessaires (comptes, droits)', 'Fenêtre de maintenance validée', 'Sauvegarde récente vérifiée'),
      h(2, 'Étapes'), ol('Première étape', 'Deuxième étape', 'Troisième étape'),
      code('bash', '# commandes à exécuter\nsudo systemctl status kanzen'),
      h(2, 'Vérification'), ul('Contrôle fonctionnel', 'Contrôle des journaux'),
      h(2, 'Retour arrière'), callout('warning', p('Décrire comment revenir à l\'état initial si une étape échoue.')),
      h(2, 'Contacts'), table(['Rôle', 'Nom', 'Téléphone'], ['Responsable', '', ''], ['Astreinte', '', '']),
    ),
  },
  {
    id: 'meeting', title: 'Compte rendu de réunion', icon: '📝', description: 'Participants, ordre du jour, décisions, actions.',
    content: doc(
      table(['Date', 'Lieu / visio', 'Animateur'], ['', '', '']),
      h(2, 'Participants'), ul(''),
      h(2, 'Ordre du jour'), ol('Point 1', 'Point 2'),
      h(2, 'Décisions'), ul(''),
      h(2, 'Actions'), table(['Action', 'Responsable', 'Échéance'], ['', '', '']),
      h(2, 'Prochaine réunion'), p(''),
    ),
  },
  {
    id: 'server', title: 'Fiche serveur', icon: '🖥️', description: 'Identité, rôle, accès, sauvegardes, supervision.',
    content: doc(
      h(2, 'Identité'), table(['Propriété', 'Valeur'], ['Nom (FQDN)', ''], ['Adresse IP', ''], ['Système', ''], ['Environnement', 'production / recette'], ['Hébergement', '']),
      h(2, 'Rôle et services'), ul(''),
      h(2, 'Accès'), callout('danger', p('Ne jamais noter de mot de passe ici : indiquer seulement où il est conservé (coffre-fort).')), ul('Comptes d\'administration :', 'Flux réseau ouverts :'),
      h(2, 'Sauvegardes'), ul('Périmètre :', 'Fréquence et rétention :', 'Dernier test de restauration :'),
      h(2, 'Supervision'), ul('Sondes :', 'Seuils d\'alerte :'),
      h(2, 'Historique des interventions'), table(['Date', 'Intervenant', 'Description'], ['', '', '']),
    ),
  },
  {
    id: 'postmortem', title: 'Post-mortem d\'incident', icon: '🧯', description: 'Chronologie, impact, cause racine, actions correctives.',
    content: doc(
      callout('tip', p('Analyse sans recherche de coupable : on s\'intéresse aux causes et aux améliorations.')),
      h(2, 'Résumé'), table(['Début', 'Fin', 'Durée', 'Gravité'], ['', '', '', '']), p(''),
      h(2, 'Impact'), ul('Utilisateurs ou services touchés :', 'Données concernées :'),
      h(2, 'Chronologie'), table(['Heure', 'Événement'], ['', ''], ['', '']),
      h(2, 'Cause racine'), p(''),
      h(2, 'Ce qui a bien fonctionné'), ul(''),
      h(2, 'Actions correctives'), todo('Action — responsable — échéance'),
    ),
  },
  {
    id: 'decision', title: 'Décision technique', icon: '⚖️', description: 'Contexte, options étudiées, décision et conséquences.',
    content: doc(
      table(['Statut', 'Date', 'Décideurs'], ['proposée / acceptée / remplacée', '', '']),
      h(2, 'Contexte'), p(''),
      h(2, 'Options étudiées'), h(3, 'Option A'), ul('Avantages :', 'Inconvénients :'), h(3, 'Option B'), ul('Avantages :', 'Inconvénients :'),
      h(2, 'Décision'), callout('info', p('')),
      h(2, 'Conséquences'), ul(''),
    ),
  },
];
