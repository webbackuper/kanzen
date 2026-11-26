// Vues alternatives du tableau : Liste (tableau triable) et Chronologie (Gantt début → échéance).
// Elles reçoivent les colonnes déjà filtrées par la barre de filtres du tableau.
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Ban } from 'lucide-react';
import { Avatars } from './TaskCard';
import { LabelChip, PRIORITY, PriorityIcon, fieldText } from './boardMeta';
import { btnGhost } from '../ui';

const PRIO_RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const day = (d) => (d ? d.slice(0, 10) : '');
const fmt = (d) => (d ? new Date(`${day(d)}T12:00:00Z`).toLocaleDateString('fr-FR') : '');
const todayStr = () => new Date().toISOString().slice(0, 10);

/** Cartes à plat, avec leur colonne et un indicateur « terminée » (dernière colonne). */
function flatten(columns) {
  return columns.flatMap((c) => c.tasks.map((t, i) => ({ ...t, columnTitle: c.title, columnIndex: columns.indexOf(c), rank: i, done: c.isLast })));
}

export function ListView({ columns, board, labelsById, onOpen }) {
  const [sort, setSort] = useState({ key: 'column', dir: 1 });
  const fields = board.fields ?? [];
  const cols = useMemo(() => [
    { key: 'title', label: 'Titre', value: (t) => t.title.toLowerCase() },
    { key: 'column', label: 'Colonne', value: (t) => t.columnIndex * 100000 + t.rank },
    { key: 'priority', label: 'Priorité', value: (t) => PRIO_RANK[t.priority] ?? 0 },
    { key: 'labels', label: 'Étiquettes', value: (t) => (t.labelIds ?? []).map((id) => labelsById.get(id)?.name ?? '').join(',').toLowerCase() },
    { key: 'assignees', label: 'Assignés', value: (t) => t.assignees.map((a) => a.displayName).join(',').toLowerCase() },
    { key: 'startDate', label: 'Début', value: (t) => day(t.startDate) },
    { key: 'dueDate', label: 'Échéance', value: (t) => day(t.dueDate) },
    { key: 'estimate', label: 'Estim.', value: (t) => t.estimate ?? null },
    ...fields.map((f) => ({ key: `f:${f.id}`, label: f.name, field: f, value: (t) => {
      const v = t.fieldValues?.[f.id];
      return v === undefined || v === null ? null : typeof v === 'string' ? v.toLowerCase() : Number(v);
    } })),
  ], [fields, labelsById]);

  const rows = useMemo(() => {
    const col = cols.find((c) => c.key === sort.key) ?? cols[1];
    const all = flatten(columns);
    // Valeurs vides toujours en fin de liste, quel que soit le sens du tri
    const empty = (v) => v === null || v === '';
    return all.sort((a, b) => {
      const va = col.value(a); const vb = col.value(b);
      if (empty(va) || empty(vb)) return empty(va) - empty(vb);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [columns, cols, sort]);

  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const today = todayStr();
  const th = 'px-3 py-2 text-left text-xs font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm text-gray-800 dark:text-gray-200 align-top';

  return (
    <div className="overflow-auto h-full rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800">
        <caption className="sr-only">Cartes du tableau, {rows.length} ligne(s). Les en-têtes de colonne trient la liste.</caption>
        <thead className="bg-gray-50 dark:bg-slate-800/60 sticky top-0 z-10">
          <tr>
            {cols.map((c) => (
              <th key={c.key} scope="col" className={th} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="inline-flex items-center gap-1 hover:text-indigo-600" onClick={() => toggle(c.key)}>
                  {c.label}
                  {sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
          {rows.length === 0 && <tr><td className={td} colSpan={cols.length}>Aucune carte.</td></tr>}
          {rows.map((t) => {
            const late = !t.done && t.dueDate && day(t.dueDate) < today;
            return (
              <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50">
                <td className={`${td} max-w-xs`}>
                  <button type="button" className="text-left font-medium hover:underline break-words" onClick={() => onOpen(t.id)}>{t.title}</button>
                  {t.blocked && <span className="ml-2 inline-flex items-center gap-0.5 text-xs text-red-700 dark:text-red-300"><Ban size={11} aria-hidden="true" /> Bloquée</span>}
                </td>
                <td className={td}>{t.columnTitle}</td>
                <td className={td}><span className="inline-flex items-center gap-1"><PriorityIcon priority={t.priority} />{t.priority !== 'NONE' ? PRIORITY[t.priority].label : ''}</span></td>
                <td className={td}><span className="flex flex-wrap gap-1">{(t.labelIds ?? []).map((id) => <LabelChip key={id} label={labelsById.get(id)} small />)}</span></td>
                <td className={td}><Avatars users={t.assignees} max={3} /></td>
                <td className={`${td} whitespace-nowrap`}>{fmt(t.startDate)}</td>
                <td className={`${td} whitespace-nowrap ${late ? 'text-red-700 dark:text-red-300 font-medium' : ''}`}>{fmt(t.dueDate)}{late && <span className="sr-only"> (en retard)</span>}</td>
                <td className={`${td} text-right`}>{t.estimate ?? ''}</td>
                {fields.map((f) => <td key={f.id} className={td}>{fieldText(f, t.fieldValues?.[f.id])}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Chronologie ---
const MS_DAY = 86400000;
const toNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / MS_DAY;
const fromNum = (n) => new Date(n * MS_DAY);
const ROW = 34;
const LABEL_W = 260;
const ZOOMS = { day: { w: 32, label: 'Jours' }, week: { w: 12, label: 'Semaines' }, month: { w: 4, label: 'Mois' } };

export function TimelineView({ columns, onOpen }) {
  const [zoom, setZoom] = useState('day');
  const all = flatten(columns);
  const dated = all.filter((t) => t.startDate || t.dueDate);
  const undated = all.length - dated.length;
  const today = toNum(todayStr());

  if (!dated.length) {
    return <p className="text-sm text-gray-600 dark:text-gray-300">Aucune carte datée. Renseignez une date de début ou une échéance pour la voir sur la chronologie{undated ? ` (${undated} carte(s) sans date)` : ''}.</p>;
  }
  const items = dated.map((t) => {
    const s = toNum(day(t.startDate || t.dueDate));
    const e = toNum(day(t.dueDate || t.startDate));
    return { t, s: Math.min(s, e), e: Math.max(s, e) };
  });
  const from = Math.min(today, ...items.map((i) => i.s)) - 3;
  const to = Math.max(today, ...items.map((i) => i.e)) + 7;
  const W = ZOOMS[zoom].w;
  const width = (to - from + 1) * W;
  const x = (n) => (n - from) * W;
  const rowOf = new Map(items.map((i, k) => [i.t.id, k]));

  // Graduations : jours (zoom jour), lundis (semaine) ou 1er du mois
  const ticks = [];
  for (let n = from; n <= to; n++) {
    const d = fromNum(n);
    const major = d.getUTCDate() === 1;
    if (zoom === 'day' || (zoom === 'week' && d.getUTCDay() === 1) || major) ticks.push({ n, d, major });
  }
  // Flèches de dépendance : de la fin de la carte bloquante au début de la carte bloquée
  const links = items.flatMap((i) => (i.t.blockedByIds ?? []).filter((b) => rowOf.has(b)).map((b) => ({ from: items[rowOf.get(b)], to: i })));

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
        <span role="group" aria-label="Échelle" className="inline-flex gap-1">
          {Object.entries(ZOOMS).map(([k, z]) => (
            <button key={k} type="button" aria-pressed={zoom === k} className={`${btnGhost} ${zoom === k ? '!bg-gray-200 dark:!bg-slate-700' : ''}`} onClick={() => setZoom(k)}>{z.label}</button>
          ))}
        </span>
        {undated > 0 && <span>{undated} carte(s) sans date non affichée(s).</span>}
      </div>
      <div className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900" role="region" aria-label="Chronologie des cartes">
        <div className="relative" style={{ width: LABEL_W + width, height: 40 + items.length * ROW }}>
          {/* En-tête des dates */}
          <div className="sticky top-0 z-20 flex h-10 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
            <div className="sticky left-0 z-30 shrink-0 bg-gray-50 dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 px-3 flex items-center text-xs font-semibold text-gray-600 dark:text-gray-300" style={{ width: LABEL_W }}>Carte</div>
            <div className="relative" style={{ width }}>
              {ticks.map(({ n, d, major }) => (
                <span key={n} className={`absolute top-0 h-10 border-l text-[10px] pl-0.5 pt-0.5 ${major ? 'border-gray-400 dark:border-slate-500 font-semibold text-gray-700 dark:text-gray-200' : 'border-gray-200 dark:border-slate-700 text-gray-500'}`} style={{ left: x(n) }}>
                  {major || zoom !== 'day' ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : d.getUTCDate()}
                </span>
              ))}
            </div>
          </div>
          {/* Aujourd'hui */}
          <div className="absolute z-10 w-px bg-red-500" style={{ left: LABEL_W + x(today) + W / 2, top: 40, bottom: 0 }} aria-hidden="true" title="Aujourd'hui" />
          <svg className="absolute z-10 pointer-events-none" style={{ left: LABEL_W, top: 40 }} width={width} height={items.length * ROW} aria-hidden="true">
            <defs><marker id="kz-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="fill-gray-500" /></marker></defs>
            {links.map(({ from: a, to: b }) => {
              const x1 = x(a.e) + W; const y1 = rowOf.get(a.t.id) * ROW + ROW / 2;
              const x2 = x(b.s); const y2 = rowOf.get(b.t.id) * ROW + ROW / 2;
              const mid = Math.max(x1 + 6, x2 - 6);
              return <path key={`${a.t.id}-${b.t.id}`} d={`M${x1},${y1} H${mid} V${y2} H${x2}`} fill="none" className="stroke-gray-500" strokeWidth="1.2" markerEnd="url(#kz-arrow)" />;
            })}
          </svg>
          {items.map(({ t, s, e }, k) => {
            const late = !t.done && t.dueDate && toNum(day(t.dueDate)) < today;
            const color = t.done ? 'bg-gray-400 dark:bg-slate-500' : late ? 'bg-red-600' : t.blocked ? 'bg-amber-600' : 'bg-indigo-600';
            const label = `${t.title}, ${t.columnTitle}, ${t.startDate ? `du ${fmt(t.startDate)} ` : ''}${t.dueDate ? `au ${fmt(t.dueDate)}` : ''}${late ? ', en retard' : ''}${t.blocked ? ', bloquée' : ''}`;
            return (
              <div key={t.id} className="absolute left-0 flex border-b border-gray-100 dark:border-slate-800" style={{ top: 40 + k * ROW, height: ROW, width: LABEL_W + width }}>
                <div className="sticky left-0 z-10 shrink-0 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-700 px-3 flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200" style={{ width: LABEL_W }}>
                  <span className="truncate" title={t.title}>{t.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-gray-500">{t.columnTitle}</span>
                </div>
                <div className="relative" style={{ width }}>
                  <button type="button" onClick={() => onOpen(t.id)} aria-label={label} title={label}
                    className={`absolute top-1.5 h-[22px] rounded text-white text-[11px] px-1.5 truncate text-left shadow-sm hover:brightness-110 focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500 ${color}`}
                    style={{ left: x(s), width: Math.max(W * (e - s + 1), 10) }}>
                    {W * (e - s + 1) > 60 ? t.title : ''}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-4">
        <span><span className="inline-block w-3 h-2 rounded-sm bg-indigo-600 mr-1" />En cours</span>
        <span><span className="inline-block w-3 h-2 rounded-sm bg-amber-600 mr-1" />Bloquée</span>
        <span><span className="inline-block w-3 h-2 rounded-sm bg-red-600 mr-1" />En retard</span>
        <span><span className="inline-block w-3 h-2 rounded-sm bg-gray-400 mr-1" />Terminée</span>
        <span><span className="inline-block w-px h-3 bg-red-500 mr-1 align-middle" />Aujourd&apos;hui</span>
      </p>
    </div>
  );
}
