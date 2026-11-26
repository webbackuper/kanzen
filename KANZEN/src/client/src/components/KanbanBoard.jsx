import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { DndContext, closestCorners, useSensor, useSensors, PointerSensor, KeyboardSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { io } from 'socket.io-client';
import { BarChart3, Download, Plus } from 'lucide-react';
import { Column } from './Column';
import { TaskDetail } from './TaskDetail';
import { api } from '../api';
import { ErrorBox, Loading, btnGhost, btnPrimary, input } from '../ui';

export function KanbanBoard() {
  const { id } = useParams();
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [params, setParams] = useSearchParams();
  // Ouverture directe d'une tâche (lien depuis le wiki : /b/:id?task=…)
  useEffect(() => {
    const t = params.get('task');
    if (t && /^[0-9a-f-]{36}$/.test(t)) { setOpenTask(t); setParams({}, { replace: true }); }
  }, [params]);
  const [newCol, setNewCol] = useState('');

  const load = useCallback(() => api.get(`/boards/${id}`).then((r) => setBoard(r.board), setError), [id]);

  useEffect(() => {
    load();
    // Temps réel : le serveur authentifie la websocket par le cookie de session
    const socket = io({ path: '/socket.io', withCredentials: true });
    socket.on('connect', () => socket.emit('board:join', id));
    socket.on('board:updated', (e) => e.boardId === id && load());
    return () => socket.disconnect();
  }, [id, load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = async ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const overType = over.data.current?.type;
    const targetColId = overType === 'task' ? over.data.current.columnId : over.id;
    const target = board.columns.find((c) => c.id === targetColId);
    if (!target) return;
    const others = target.tasks.filter((t) => t.id !== active.id);
    let index = others.length;
    if (overType === 'task') index = others.findIndex((t) => t.id === over.id);
    const afterId = others[index - 1]?.id ?? null;
    const beforeId = others[index]?.id ?? null;

    // Mise à jour optimiste
    const moving = board.columns.flatMap((c) => c.tasks).find((t) => t.id === active.id);
    const next = board.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== active.id) }));
    next.find((c) => c.id === targetColId).tasks.splice(index, 0, { ...moving, columnId: targetColId });
    setBoard({ ...board, columns: next });
    try {
      await api.post(`/tasks/${active.id}/move`, { columnId: targetColId, afterId, beforeId });
    } catch (x) { setError(x); load(); }
  };

  const addColumn = async (e) => {
    e.preventDefault();
    try { await api.post(`/boards/${id}/columns`, { title: newCol }); setNewCol(''); } catch (x) { setError(x); }
  };

  if (!board) return error ? <div className="p-6"><ErrorBox error={error} /></div> : <Loading />;
  const canEdit = board.myRole !== 'VIEWER';

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60">
        <div>
          <Link to={`/w/${board.workspace.id}`} className="text-xs text-gray-500 hover:underline">← {board.workspace.name}</Link>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">{board.title}</h1>
        </div>
        <div className="flex gap-2">
          <Link to={`/b/${id}/stats`} className={btnGhost}><BarChart3 size={16} /> Statistiques</Link>
          <a href={`/api/boards/${id}/export.csv`} className={btnGhost}><Download size={16} /> Export CSV</a>
        </div>
      </div>
      {error && <div className="px-6 pt-3"><ErrorBox error={error} /></div>}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-6">
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="flex h-full gap-4 items-start">
            {board.columns.map((col) => <Column key={col.id} column={col} canEdit={canEdit} onOpen={setOpenTask} onError={setError} />)}
            {canEdit && (
              <form onSubmit={addColumn} className="w-72 shrink-0 space-y-2">
                <input className={input} placeholder="Nouvelle colonne" value={newCol} onChange={(e) => setNewCol(e.target.value)} required maxLength={80} />
                <button className={btnPrimary}><Plus size={14} /> Ajouter la colonne</button>
              </form>
            )}
          </div>
        </DndContext>
      </div>
      {openTask && <TaskDetail taskId={openTask} workspaceId={board.workspace.id} onClose={() => setOpenTask(null)} onChanged={load} />}
    </div>
  );
}
