import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus, MoreHorizontal } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { api } from '../api';
import { input, btnPrimary, btnGhost, btnDanger } from '../ui';

export function Column({ column, canEdit, onOpen, onError, onDelete, isLast, total, addSignal }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' } });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.title);
  const [wip, setWip] = useState(null); // saisie de la limite WIP en cours (null = fermée)
  const menuRef = useRef(null);
  const count = total ?? column.tasks.length; // total réel (hors filtre) pour la limite WIP
  const over = column.wipLimit && count > column.wipLimit;

  // Raccourci « n » (nouvelle carte) relayé par le tableau
  useEffect(() => { if (addSignal) setAdding(true); }, [addSignal]);
  // Menu : fermeture par Échap ou clic à l'extérieur
  useEffect(() => {
    if (!menu) return undefined;
    const key = (e) => { if (e.key === 'Escape') { setMenu(false); setWip(null); } };
    const click = (e) => { if (!menuRef.current?.contains(e.target)) { setMenu(false); setWip(null); } };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', click); };
  }, [menu]);

  const run = (fn) => async (e) => { e?.preventDefault(); try { await fn(); } catch (x) { onError(x); } };
  const addTask = run(async () => { await api.post(`/columns/${column.id}/tasks`, { title }); setTitle(''); setAdding(false); });
  const rename = run(async () => {
    const t = name.trim();
    setRenaming(false);
    if (t && t !== column.title) await api.patch(`/columns/${column.id}`, { title: t });
  });
  const saveWip = run(async () => {
    const v = String(wip ?? '').trim();
    if (v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 1)) throw new Error('Limite WIP : entier supérieur ou égal à 1, ou vide');
    await api.patch(`/columns/${column.id}`, { wipLimit: v === '' ? null : Number(v) });
    setWip(null); setMenu(false);
  });

  return (
    <section aria-label={`Colonne ${column.title}`} className="flex flex-col w-72 shrink-0 max-h-full">
      <div className="flex items-center justify-between mb-2 px-1 relative">
        {renaming ? (
          <form onSubmit={rename} className="flex-1 mr-2">
            <input autoFocus className={`${input} py-1`} value={name} maxLength={80} aria-label="Nom de la colonne"
              onChange={(e) => setName(e.target.value)} onBlur={rename}
              onKeyDown={(e) => { if (e.key === 'Escape') { setName(column.title); setRenaming(false); } }} />
          </form>
        ) : (
          <h3 className="font-semibold text-gray-700 dark:text-gray-300 uppercase text-xs tracking-wider"
            onDoubleClick={() => { if (canEdit) { setName(column.title); setRenaming(true); } }}
            title={canEdit ? 'Double-clic pour renommer' : undefined}>{column.title}</h3>
        )}
        <span className="flex items-center gap-1">
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${over ? 'bg-red-200 text-red-800' : 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-gray-300'}`}
            title={over ? 'Limite WIP dépassée' : undefined}>
            {count !== column.tasks.length ? `${column.tasks.length} / ` : ''}{count}{column.wipLimit ? ` (WIP ${column.wipLimit})` : ''}
          </span>
          {canEdit && <button className="text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100" onClick={() => setMenu(!menu)} aria-label={`Options de la colonne ${column.title}`} aria-expanded={menu}><MoreHorizontal size={16} /></button>}
        </span>
        {menu && (
          <div ref={menuRef} className="absolute right-0 top-6 z-10 bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-md shadow-lg flex flex-col p-1 w-52">
            <button className={btnGhost} onClick={() => { setMenu(false); setName(column.title); setRenaming(true); }}>Renommer</button>
            {wip === null
              ? <button className={btnGhost} onClick={() => setWip(column.wipLimit ?? '')}>Limite WIP{column.wipLimit ? ` (${column.wipLimit})` : ''}</button>
              : (
                <form onSubmit={saveWip} className="flex gap-1 p-1">
                  <input autoFocus className={`${input} py-1`} inputMode="numeric" placeholder="Aucune" value={wip} onChange={(e) => setWip(e.target.value)} aria-label="Limite WIP (vide = aucune)" />
                  <button className={btnPrimary}>OK</button>
                </form>
              )}
            <button className={btnDanger} onClick={() => { setMenu(false); onDelete(column); }}>Supprimer</button>
          </div>
        )}
      </div>
      <div ref={setNodeRef} className={`flex-1 rounded-xl p-2 border-2 border-dashed overflow-y-auto min-h-[120px] ${isOver ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-900/20' : 'border-gray-200 dark:border-slate-700 bg-gray-100/50 dark:bg-slate-800/50'}`}>
        <SortableContext items={column.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {column.tasks.map((t) => <TaskCard key={t.id} task={t} onOpen={onOpen} disabled={!canEdit} done={isLast} />)}
        </SortableContext>
        {canEdit && (adding ? (
          <form onSubmit={addTask} className="space-y-2">
            <input autoFocus className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre de la tâche" maxLength={300} required onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} aria-label={`Nouvelle tâche dans ${column.title}`} />
            <div className="flex gap-2"><button className={btnPrimary}>Ajouter</button><button type="button" className={btnGhost} onClick={() => setAdding(false)}>Annuler</button></div>
          </form>
        ) : (
          <button className={`${btnGhost} w-full justify-center`} onClick={() => setAdding(true)}><Plus size={14} /> Ajouter une tâche</button>
        ))}
      </div>
    </section>
  );
}
