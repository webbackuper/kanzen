import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { DndContext, closestCorners, useSensor, useSensors, PointerSensor, KeyboardSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { io } from 'socket.io-client';
import { isPast } from 'date-fns';
import { BarChart3, Download, Filter, Keyboard, Plus, X } from 'lucide-react';
import { Column } from './Column';
import { TaskDetail } from './TaskDetail';
import { api, setSocketId } from '../api';
import { ErrorBox, Loading, Modal, Toast, btnGhost, btnPrimary, input, isTyping } from '../ui';

const UNDO_MS = 8000;
const COLOR_LABEL = { white: 'Blanc', red: 'Rouge', orange: 'Orange', yellow: 'Jaune', green: 'Vert', blue: 'Bleu', purple: 'Violet', gray: 'Gris' };

// Annonces en français pour les lecteurs d'écran pendant un déplacement au clavier ou à la souris
const titleOf = (board, id) => board?.columns.flatMap((c) => c.tasks).find((t) => t.id === id)?.title ?? 'la carte';
const colOf = (board, over) => {
  if (!over) return null;
  const id = over.data.current?.type === 'task' ? over.data.current.columnId : over.id;
  return board?.columns.find((c) => c.id === id)?.title ?? null;
};

export function KanbanBoard({ user }) {
  const { id } = useParams();
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [params, setParams] = useSearchParams();
  const [newCol, setNewCol] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null); // { column, timer } : suppression annulable
  const [help, setHelp] = useState(false);
  const [addSignal, setAddSignal] = useState(0);
  const filterRef = useRef(null);
  const pendingRef = useRef(null);
  pendingRef.current = pendingDelete;

  // Filtres, conservés dans l'URL (lien partageable) : q, who (me | id), late, color
  // Texte : état local (saisie fluide), recopié dans l'adresse après 300 ms sans frappe
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const who = params.get('who') ?? '';
  const lateOnly = params.get('late') === '1';
  const color = params.get('color') ?? '';
  const setFilter = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const clearFilters = () => setQ('') || setParams((p) => { const n = new URLSearchParams(p); ['q', 'who', 'late', 'color'].forEach((k) => n.delete(k)); return n; }, { replace: true });
  const filtering = !!(q || who || lateOnly || color);
  useEffect(() => {
    const t = setTimeout(() => { if ((params.get('q') ?? '') !== q) setFilter('q', q); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Ouverture directe d'une tâche (lien depuis le wiki ou « Copier le lien » : /b/:id?task=…)
  useEffect(() => {
    const t = params.get('task');
    if (t && /^[0-9a-f-]{36}$/.test(t)) {
      setOpenTask(t);
      setParams((p) => { const n = new URLSearchParams(p); n.delete('task'); return n; }, { replace: true });
    }
  }, [params]);

  const load = useCallback(() => api.get(`/boards/${id}`).then((r) => setBoard(r.board), setError), [id]);

  useEffect(() => {
    load();
    // Temps réel : le serveur authentifie la websocket par le cookie de session
    const socket = io({ path: '/socket.io', withCredentials: true });
    let timer = null;
    let connectedOnce = false;
    // Rafale de modifications (réunion, déplacements successifs) : un seul rechargement après 250 ms de calme
    const reloadSoon = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
    socket.on('connect', () => {
      setSocketId(socket.id);
      socket.emit('board:join', id);
      // Reconnexion (veille du poste, coupure réseau, redémarrage du service) : rattrapage des modifications manquées
      if (connectedOnce) reloadSoon();
      connectedOnce = true;
    });
    socket.on('board:updated', (e) => {
      if (e.boardId !== id) return;
      // Écho de notre propre déplacement : déjà appliqué localement (mise à jour optimiste)
      if (e.reason === 'move' && e.origin && e.origin === socket.id) return;
      reloadSoon();
    });
    return () => { clearTimeout(timer); setSocketId(null); socket.disconnect(); };
  }, [id, load]);

  // Suppression de colonne en attente : exécutée si on quitte la page avant la fin du délai d'annulation
  useEffect(() => () => {
    const p = pendingRef.current;
    if (p) { clearTimeout(p.timer); api.del(`/columns/${p.column.id}`).catch(() => {}); }
  }, [id]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Espace prend / pose la carte (Entrée reste réservée à l'ouverture de la carte), Échap annule
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] } }),
  );

  // Colonnes affichées : suppression en attente masquée, filtres appliqués (le total réel reste visible pour le WIP)
  const columns = useMemo(() => {
    if (!board) return [];
    const term = q.trim().toLowerCase();
    const keep = (t) => (!term || t.title.toLowerCase().includes(term) || t.description?.toLowerCase().includes(term))
      && (!who || (who === 'none' ? !t.assignees.length : t.assignees.some((a) => a.id === (who === 'me' ? user?.id : who))))
      && (!lateOnly || (t.dueDate && isPast(new Date(t.dueDate))))
      && (!color || t.color === color);
    const visible = board.columns.filter((c) => c.id !== pendingDelete?.column.id);
    return visible.map((c, i) => ({
      ...c, total: c.tasks.length, isLast: i === visible.length - 1,
      tasks: filtering ? c.tasks.filter((t) => keep(t) && !(lateOnly && i === visible.length - 1)) : c.tasks,
    }));
  }, [board, q, who, lateOnly, color, filtering, pendingDelete, user?.id]);

  const members = useMemo(() => {
    const m = new Map();
    for (const c of board?.columns ?? []) for (const t of c.tasks) for (const a of t.assignees) m.set(a.id, a);
    return [...m.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [board]);

  // Raccourcis : / filtre, n nouvelle carte, ? aide
  useEffect(() => {
    const k = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping() || openTask || help) return;
      if (e.key === '/') { e.preventDefault(); filterRef.current?.focus(); }
      else if (e.key === 'n' && board?.myRole !== 'VIEWER' && columns.length) { e.preventDefault(); setAddSignal((n) => n + 1); }
      else if (e.key === '?') { e.preventDefault(); setHelp(true); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [board?.myRole, columns.length, openTask, help]);

  const onDragEnd = async ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const overType = over.data.current?.type;
    const targetColId = overType === 'task' ? over.data.current.columnId : over.id;
    const target = columns.find((c) => c.id === targetColId);
    if (!target) return;
    // Voisins calculés sur les cartes affichées (filtrées ou non) : la position reste cohérente côté serveur
    const others = target.tasks.filter((t) => t.id !== active.id);
    let index = others.length;
    if (overType === 'task') index = others.findIndex((t) => t.id === over.id);
    const afterId = others[index - 1]?.id ?? null;
    const beforeId = others[index]?.id ?? null;

    // Mise à jour optimiste
    const moving = board.columns.flatMap((c) => c.tasks).find((t) => t.id === active.id);
    const next = board.columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== active.id) }));
    const dest = next.find((c) => c.id === targetColId).tasks;
    const at = beforeId ? dest.findIndex((t) => t.id === beforeId) : afterId ? dest.findIndex((t) => t.id === afterId) + 1 : dest.length;
    dest.splice(at < 0 ? dest.length : at, 0, { ...moving, columnId: targetColId });
    setBoard({ ...board, columns: next });
    try {
      await api.post(`/tasks/${active.id}/move`, { columnId: targetColId, afterId, beforeId });
    } catch (x) { setError(x); load(); }
  };

  const addColumn = async (e) => {
    e.preventDefault();
    try { await api.post(`/boards/${id}/columns`, { title: newCol }); setNewCol(''); } catch (x) { setError(x); }
  };

  // Suppression d'une colonne : masquée tout de suite, supprimée après UNDO_MS sauf « Annuler »
  const requestDelete = (column) => {
    if (pendingRef.current) { clearTimeout(pendingRef.current.timer); api.del(`/columns/${pendingRef.current.column.id}`).catch(setError); }
    const timer = setTimeout(async () => {
      setPendingDelete(null);
      try { await api.del(`/columns/${column.id}`); } catch (x) { setError(x); load(); }
    }, UNDO_MS);
    setPendingDelete({ column, timer });
  };
  const undoDelete = () => { clearTimeout(pendingDelete?.timer); setPendingDelete(null); };

  if (!board) return error ? <div className="p-6"><ErrorBox error={error} /></div> : <Loading />;
  const canEdit = board.myRole !== 'VIEWER';
  const firstColId = columns[0]?.id;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60">
        <div>
          <Link to={`/w/${board.workspace.id}`} className="text-xs text-gray-500 hover:underline">← {board.workspace.name}</Link>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">{board.title}</h1>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btnGhost} onClick={() => setHelp(true)} aria-label="Raccourcis clavier" title="Raccourcis clavier (?)"><Keyboard size={16} /></button>
          <Link to={`/b/${id}/stats`} className={btnGhost}><BarChart3 size={16} /> Statistiques</Link>
          <a href={`/api/boards/${id}/export.csv`} className={btnGhost}><Download size={16} /> Export CSV</a>
        </div>
      </div>
      <form role="search" aria-label="Filtrer les cartes" className="px-6 pt-3 flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => e.preventDefault()}>
        <Filter size={14} className="text-gray-500 dark:text-gray-400" aria-hidden="true" />
        <input ref={filterRef} className={`${input} w-56 py-1`} placeholder="Filtrer (touche /)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Texte recherché dans les cartes" maxLength={100} />
        <select className={`${input} w-48 py-1`} value={who} onChange={(e) => setFilter('who', e.target.value)} aria-label="Assigné">
          <option value="">Tous les assignés</option>
          <option value="me">Mes cartes</option>
          <option value="none">Non assignées</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
        </select>
        <select className={`${input} w-36 py-1`} value={color} onChange={(e) => setFilter('color', e.target.value)} aria-label="Couleur">
          <option value="">Toutes couleurs</option>
          {Object.entries(COLOR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setFilter('late', e.target.checked ? '1' : '')} /> En retard
        </label>
        {filtering && <button type="button" className={btnGhost} onClick={clearFilters}><X size={14} /> Effacer les filtres</button>}
        <span className="sr-only" aria-live="polite">{filtering ? `${columns.reduce((n, c) => n + c.tasks.length, 0)} carte(s) affichée(s)` : ''}</span>
      </form>
      {error && <div className="px-6 pt-3"><ErrorBox error={error} /></div>}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-6">
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}
          accessibility={{
            screenReaderInstructions: { draggable: 'Carte déplaçable : Entrée pour l\'ouvrir. Espace pour la prendre, flèches pour la déplacer, Espace pour la poser, Échap pour annuler.' },
            announcements: {
              onDragStart: ({ active }) => `Carte « ${titleOf(board, active.id)} » prise.`,
              onDragOver: ({ active, over }) => (over ? `Carte « ${titleOf(board, active.id)} » au-dessus de la colonne ${colOf(board, over) ?? ''}.` : 'Hors d\'une colonne.'),
              onDragEnd: ({ active, over }) => (over ? `Carte « ${titleOf(board, active.id)} » posée dans la colonne ${colOf(board, over) ?? ''}.` : 'Déplacement annulé.'),
              onDragCancel: ({ active }) => `Déplacement de « ${titleOf(board, active.id)} » annulé.`,
            },
          }}>
          <div className="flex h-full gap-4 items-start">
            {columns.map((col) => (
              <Column key={col.id} column={col} total={col.total} isLast={col.isLast} canEdit={canEdit} onOpen={setOpenTask} onError={setError}
                onDelete={requestDelete} addSignal={col.id === firstColId ? addSignal : 0} />
            ))}
            {canEdit && (
              <form onSubmit={addColumn} className="w-72 shrink-0 space-y-2">
                <input className={input} placeholder="Nouvelle colonne" value={newCol} onChange={(e) => setNewCol(e.target.value)} required maxLength={80} aria-label="Nom de la nouvelle colonne" />
                <button className={btnPrimary}><Plus size={14} /> Ajouter la colonne</button>
              </form>
            )}
          </div>
        </DndContext>
      </div>
      {openTask && <TaskDetail taskId={openTask} boardId={id} workspaceId={board.workspace.id} onClose={() => setOpenTask(null)} onChanged={load} />}
      {pendingDelete && (
        <Toast message={`Colonne « ${pendingDelete.column.title} » et ses ${pendingDelete.column.total} tâche(s) supprimées.`} action="Annuler" onAction={undoDelete} />
      )}
      {help && (
        <Modal title="Raccourcis clavier" onClose={() => setHelp(false)}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm text-gray-700 dark:text-gray-200">
            <dt><kbd>/</kbd></dt><dd>Filtrer les cartes</dd>
            <dt><kbd>n</kbd></dt><dd>Nouvelle carte dans la première colonne</dd>
            <dt><kbd>Entrée</kbd></dt><dd>Ouvrir la carte sélectionnée</dd>
            <dt><kbd>Espace</kbd></dt><dd>Prendre / poser la carte, flèches pour la déplacer, Échap pour annuler</dd>
            <dt><kbd>?</kbd></dt><dd>Cette aide</dd>
          </dl>
        </Modal>
      )}
    </div>
  );
}
