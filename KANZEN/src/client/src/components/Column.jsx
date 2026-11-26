import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus, MoreHorizontal } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { api } from '../api';
import { input, btnPrimary, btnGhost, btnDanger } from '../ui';

export function Column({ column, canEdit, onOpen, onError }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, data: { type: 'column' } });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState(false);
  const over = column.wipLimit && column.tasks.length > column.wipLimit;

  const run = (fn) => async (e) => { e?.preventDefault(); try { await fn(); } catch (x) { onError(x); } };
  const addTask = run(async () => { await api.post(`/columns/${column.id}/tasks`, { title }); setTitle(''); setAdding(false); });
  const rename = run(async () => { const t = window.prompt('Nom de la colonne', column.title); if (t) await api.patch(`/columns/${column.id}`, { title: t }); setMenu(false); });
  const setWip = run(async () => {
    const v = window.prompt('Limite WIP (vide = aucune)', column.wipLimit ?? '');
    if (v !== null) await api.patch(`/columns/${column.id}`, { wipLimit: v === '' ? null : Number(v) });
    setMenu(false);
  });
  const remove = run(async () => {
    if (window.confirm(`Supprimer la colonne « ${column.title} » et ses ${column.tasks.length} tâche(s) ?`)) await api.del(`/columns/${column.id}`);
    setMenu(false);
  });

  return (
    <div className="flex flex-col w-72 shrink-0 max-h-full">
      <div className="flex items-center justify-between mb-2 px-1 relative">
        <h3 className="font-semibold text-gray-700 dark:text-gray-300 uppercase text-xs tracking-wider">{column.title}</h3>
        <span className="flex items-center gap-1">
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${over ? 'bg-red-200 text-red-800' : 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-gray-300'}`}>
            {column.tasks.length}{column.wipLimit ? `/${column.wipLimit}` : ''}
          </span>
          {canEdit && <button className="text-gray-400 hover:text-gray-700" onClick={() => setMenu(!menu)} aria-label="Options de la colonne"><MoreHorizontal size={16} /></button>}
        </span>
        {menu && (
          <div className="absolute right-0 top-6 z-10 bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-md shadow-lg flex flex-col p-1 w-44">
            <button className={btnGhost} onClick={rename}>Renommer</button>
            <button className={btnGhost} onClick={setWip}>Limite WIP</button>
            <button className={btnDanger} onClick={remove}>Supprimer</button>
          </div>
        )}
      </div>
      <div ref={setNodeRef} className={`flex-1 rounded-xl p-2 border-2 border-dashed overflow-y-auto min-h-[120px] ${isOver ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-900/20' : 'border-gray-200 dark:border-slate-700 bg-gray-100/50 dark:bg-slate-800/50'}`}>
        <SortableContext items={column.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {column.tasks.map((t) => <TaskCard key={t.id} task={t} onOpen={onOpen} disabled={!canEdit} />)}
        </SortableContext>
        {canEdit && (adding ? (
          <form onSubmit={addTask} className="space-y-2">
            <input autoFocus className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre de la tâche" maxLength={300} required onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} />
            <div className="flex gap-2"><button className={btnPrimary}>Ajouter</button><button type="button" className={btnGhost} onClick={() => setAdding(false)}>Annuler</button></div>
          </form>
        ) : (
          <button className={`${btnGhost} w-full justify-center`} onClick={() => setAdding(true)}><Plus size={14} /> Ajouter une tâche</button>
        ))}
      </div>
    </div>
  );
}
