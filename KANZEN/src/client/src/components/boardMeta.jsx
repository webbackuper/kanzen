// Métadonnées partagées des cartes : étiquettes, priorités, libellés du journal d'activité.
import { ChevronsUp, ChevronUp, ChevronDown, Flame } from 'lucide-react';

/** Couleurs des étiquettes : mêmes clés que le serveur (routes/boards.js, LABEL_COLORS). Contraste AA texte/fond. */
export const LABEL_COLORS = {
  gray: 'bg-gray-200 text-gray-800 dark:bg-slate-600 dark:text-gray-100',
  red: 'bg-red-200 text-red-900 dark:bg-red-800 dark:text-red-50',
  orange: 'bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-50',
  yellow: 'bg-yellow-200 text-yellow-900 dark:bg-yellow-700 dark:text-yellow-50',
  green: 'bg-green-200 text-green-900 dark:bg-green-800 dark:text-green-50',
  teal: 'bg-teal-200 text-teal-900 dark:bg-teal-800 dark:text-teal-50',
  blue: 'bg-blue-200 text-blue-900 dark:bg-blue-800 dark:text-blue-50',
  indigo: 'bg-indigo-200 text-indigo-900 dark:bg-indigo-800 dark:text-indigo-50',
  purple: 'bg-purple-200 text-purple-900 dark:bg-purple-800 dark:text-purple-50',
  pink: 'bg-pink-200 text-pink-900 dark:bg-pink-800 dark:text-pink-50',
};
export const LABEL_COLOR_NAMES = {
  gray: 'Gris', red: 'Rouge', orange: 'Orange', yellow: 'Jaune', green: 'Vert', teal: 'Turquoise', blue: 'Bleu', indigo: 'Indigo', purple: 'Violet', pink: 'Rose',
};

export function LabelChip({ label, small }) {
  if (!label) return null;
  return (
    <span className={`inline-block max-w-full truncate rounded font-medium ${small ? 'text-[10px] px-1.5 py-px' : 'text-xs px-2 py-0.5'} ${LABEL_COLORS[label.color] ?? LABEL_COLORS.gray}`}>
      {label.name}
    </span>
  );
}

export const PRIORITIES = [
  { value: 'NONE', label: 'Aucune' },
  { value: 'LOW', label: 'Basse', icon: ChevronDown, cls: 'text-sky-700 dark:text-sky-300' },
  { value: 'MEDIUM', label: 'Normale', icon: ChevronUp, cls: 'text-amber-700 dark:text-amber-300' },
  { value: 'HIGH', label: 'Haute', icon: ChevronsUp, cls: 'text-orange-700 dark:text-orange-300' },
  { value: 'CRITICAL', label: 'Critique', icon: Flame, cls: 'text-red-700 dark:text-red-300' },
];
export const PRIORITY = Object.fromEntries(PRIORITIES.map((p) => [p.value, p]));

export function PriorityIcon({ priority, size = 14 }) {
  const p = PRIORITY[priority];
  if (!p?.icon) return null;
  const Icon = p.icon;
  return <span className={p.cls} title={`Priorité : ${p.label}`}><Icon size={size} aria-hidden="true" /><span className="sr-only">Priorité {p.label}</span></span>;
}

const FIELD = {
  title: 'le titre', description: 'la description', color: 'la couleur', priority: 'la priorité', dueDate: 'l\'échéance',
  startDate: 'la date de début', assignees: 'les assignés', labels: 'les étiquettes', estimate: 'l\'estimation',
};
const fmtDay = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR') : 'aucune');

const fmtValue = (v) => (v === null || v === undefined || v === '' ? 'vide' : v === true ? 'oui' : v === false ? 'non'
  : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDay(v) : `« ${v} »`);

/** Types de champs personnalisés : mêmes clés que le serveur (routes/boards.js, FIELD_TYPES). */
export const FIELD_TYPES = [
  { value: 'TEXT', label: 'Texte' },
  { value: 'NUMBER', label: 'Nombre' },
  { value: 'DATE', label: 'Date' },
  { value: 'SELECT', label: 'Liste de choix' },
  { value: 'CHECKBOX', label: 'Case à cocher' },
];

/** Valeur d'un champ personnalisé pour l'affichage (carte, liste). */
export function fieldText(field, v) {
  if (v === undefined || v === null || v === '') return '';
  if (field.type === 'CHECKBOX') return v ? 'Oui' : 'Non';
  if (field.type === 'DATE') return fmtDay(v);
  if (field.type === 'NUMBER') return Number(v).toLocaleString('fr-FR');
  return String(v);
}

/** Phrase lisible d'une entrée du journal d'activité. */
export function describeActivity(a) {
  const d = a.data ?? {};
  switch (a.type) {
    case 'create': return 'a créé la carte';
    case 'move': return `a déplacé la carte de « ${d.from} » vers « ${d.to} »`;
    case 'archive': return 'a archivé la carte';
    case 'restore': return 'a restauré la carte';
    case 'comment': return 'a commenté';
    case 'attachment': return `a joint « ${d.filename} »`;
    case 'duplicate': return `a créé la carte en dupliquant « ${d.fromTitle} »`;
    case 'dependency': return d.added ? `a indiqué que la carte est bloquée par « ${d.added} »` : `a retiré le blocage par « ${d.removed} »`;
    case 'field': return `a modifié le champ « ${d.name} » (${fmtValue(d.from)} → ${fmtValue(d.to)})`;
    case 'transfer': return `a transféré la carte du tableau « ${d.fromBoard} » vers « ${d.toBoard} » (${d.to})`;
    case 'update': return `a modifié ${(d.changes ?? []).map((c) => {
      if (c.field === 'priority') return `la priorité (${PRIORITY[c.from]?.label} → ${PRIORITY[c.to]?.label})`;
      if (c.field === 'dueDate' || c.field === 'startDate') return `${FIELD[c.field]} (${fmtDay(c.from)} → ${fmtDay(c.to)})`;
      if (c.field === 'assignees' || c.field === 'labels') {
        const parts = [...(c.added ?? []).map((n) => `+${n}`), ...(c.removed ?? []).map((n) => `−${n}`)];
        return `${FIELD[c.field]} (${parts.join(', ')})`;
      }
      if (c.field === 'estimate') return `l'estimation (${c.from ?? 'aucune'} → ${c.to ?? 'aucune'})`;
      if (c.field === 'title') return `le titre (« ${c.from} » → « ${c.to} »)`;
      return FIELD[c.field] ?? c.field;
    }).join(', ')}`;
    default: return a.type;
  }
}
