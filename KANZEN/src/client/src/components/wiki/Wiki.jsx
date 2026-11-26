// Module Wiki : arborescence de pages par espace, lecture / édition (co-édition), historique, corbeille, recherche.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import {
  BookOpen, ChevronDown, ChevronRight, Clock, Download, Ellipsis, FileArchive, FileText, FileUp, FolderInput, History, House,
  Lock, Pencil, Plus, Printer, RotateCcw, Save, Search, Star, Trash2, X,
} from 'lucide-react';
import { api } from '../../api';
import { ErrorBox, Loading, Modal, btnDanger, btnGhost, btnPrimary, card, input, useApi } from '../../ui';
import { WikiEditor } from './WikiEditor';
import { colorOf } from './colors';
// Co-édition (Yjs) chargée à la demande, au passage en édition
const loadCollab = () => import('./collab');
import {
  AccessModal, Backlinks, HistoryModal, IconPicker, NewPageModal, Peers, TaskLinks, Toc, docHeadings, fmt,
} from './WikiPanels';

/** Arbre à partir de la liste plate { id, parentId, … } (déjà triée par position). */
function buildTree(pages) {
  const byParent = new Map();
  for (const p of pages) {
    const k = p.parentId ?? 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(p);
  }
  const make = (k) => (byParent.get(k) ?? []).map((p) => ({ ...p, children: make(p.id) }));
  return make('root');
}

/** Chemin lisible d'une page (« Exploitation › Sauvegardes »), pour les suggestions « [[ ». */
function withPaths(pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return pages.map((p) => {
    const chain = [];
    let cur = p.parentId ? byId.get(p.parentId) : null;
    for (let i = 0; cur && i < 20; i++) { chain.unshift(cur.title); cur = cur.parentId ? byId.get(cur.parentId) : null; }
    return { ...p, path: chain.join(' › ') };
  });
}

/** Extrait de recherche : les balises \u0001…\u0002 de PostgreSQL deviennent <mark>, sans jamais interpréter de HTML. */
export function Snippet({ text }) {
  // eslint-disable-next-line no-control-regex -- balises d'extrait posées par ts_headline (serveur)
  const parts = String(text ?? '').split(/(\u0001[^\u0002]*\u0002)/);
  return <>{parts.map((s, i) => (s.startsWith('\u0001') ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-700/60 rounded px-0.5">{s.slice(1, -1)}</mark> : <span key={i}>{s}</span>))}</>;
}

// --- Données de l'espace (arborescence, favoris, récents) partagées par les vues, rafraîchies en temps réel ---
function useWikiTree(workspaceId, onEvent) {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const load = useCallback(() => {
    if (!workspaceId) return;
    setError(null);
    api.get(`/workspaces/${workspaceId}/wiki`).then((t) => { setTree(t); setError(null); }, setError);
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId) return undefined;
    load();
    const socket = io({ path: '/socket.io', withCredentials: true });
    let timer = null;
    let connectedOnce = false;
    const reloadSoon = () => { clearTimeout(timer); timer = setTimeout(load, 250); }; // rafales regroupées
    socket.on('connect', () => {
      socket.emit('wiki:join', workspaceId);
      // Reconnexion : rattrapage de l'arborescence et de la page affichée (modifications manquées pendant la coupure)
      if (connectedOnce) { reloadSoon(); eventRef.current?.({ workspaceId, reason: 'resync' }); }
      connectedOnce = true;
    });
    socket.on('wiki:changed', (e) => { if (e.workspaceId === workspaceId) { reloadSoon(); eventRef.current?.(e); } });
    return () => { clearTimeout(timer); socket.disconnect(); };
  }, [workspaceId, load]);
  return { tree, error, reload: load };
}

// --- Arborescence (glisser-déposer : au-dessus, en dessous, ou dans une page) ---
function TreeNode({ node, depth, currentId, canEdit, onAdd, expanded, toggle, dnd }) {
  const open = expanded.has(node.id);
  const zone = dnd.target?.id === node.id ? dnd.target.zone : null;
  const onDragOver = (e) => {
    if (!dnd.dragging || !dnd.canDrop(node.id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    dnd.setTarget({ id: node.id, zone: y < r.height * 0.28 ? 'before' : y > r.height * 0.72 ? 'after' : 'inside' });
  };
  return (
    <li>
      <div
        draggable={canEdit}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', node.title); e.dataTransfer.effectAllowed = 'move'; dnd.start(node.id); }}
        onDragEnd={dnd.end}
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && dnd.target?.id === node.id) dnd.setTarget(null); }}
        onDrop={(e) => { e.preventDefault(); dnd.drop(); }}
        className={`group flex items-center gap-1 rounded-md pr-1 border-y-2 ${zone === 'before' ? 'border-t-indigo-500 border-b-transparent' : zone === 'after' ? 'border-b-indigo-500 border-t-transparent' : 'border-transparent'}
          ${zone === 'inside' ? 'bg-indigo-100 dark:bg-indigo-900/60' : node.id === currentId ? 'bg-indigo-50 dark:bg-indigo-900/40' : 'hover:bg-gray-100 dark:hover:bg-slate-800'}
          ${dnd.dragging === node.id ? 'opacity-40' : ''}`}
        style={{ paddingLeft: depth * 12 }}
      >
        <button type="button" onClick={() => toggle(node.id)} aria-label={open ? 'Replier' : 'Déplier'} aria-expanded={open}
          className={`p-0.5 text-gray-500 dark:text-gray-400 ${node.children.length ? '' : 'invisible'}`}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Link to={`/wiki/${node.id}`} draggable={false} className={`flex-1 truncate py-1 text-sm ${node.id === currentId ? 'font-semibold text-indigo-700 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-300'}`}>
          {node.icon ? `${node.icon} ` : ''}{node.title}
        </Link>
        {node.restricted && <Lock size={12} className="text-amber-500 shrink-0" aria-label="Accès restreint" />}
        {canEdit && (
          <button type="button" onClick={() => onAdd(node.id)} aria-label={`Nouvelle sous-page de ${node.title}`} title="Nouvelle sous-page"
            className="p-0.5 text-gray-500 dark:text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 focus:opacity-100">
            <Plus size={14} />
          </button>
        )}
      </div>
      {open && node.children.length > 0 && (
        <ul>{node.children.map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} currentId={currentId} canEdit={canEdit} onAdd={onAdd} expanded={expanded} toggle={toggle} dnd={dnd} />)}</ul>
      )}
    </li>
  );
}

/** Glisser-déposer dans l'arborescence : calcule le parent et les voisins, puis appelle /move. */
function useTreeDnd(pages, onMoved, expand) {
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);
  const byId = useMemo(() => new Map((pages ?? []).map((p) => [p.id, p])), [pages]);
  const isInside = (id, ancestorId) => {
    for (let cur = byId.get(id), i = 0; cur && i < 100; cur = byId.get(cur.parentId), i++) if (cur.id === ancestorId) return true;
    return false;
  };
  const siblings = (parentId) => (pages ?? []).filter((p) => (p.parentId ?? null) === (parentId ?? null) && p.id !== dragging);
  const moveTo = async (pageId, parentId, afterId, beforeId) => {
    try {
      await api.post(`/wiki/pages/${pageId}/move`, { parentId, afterId, beforeId });
      if (parentId) expand(parentId);
      onMoved();
    } catch (x) { window.alert(x.message); }
  };
  return {
    dragging, target, setTarget,
    start: (id) => setDragging(id),
    end: () => { setDragging(null); setTarget(null); },
    canDrop: (id) => dragging && id !== dragging && !isInside(id, dragging),
    drop: async () => {
      const t = target;
      const id = dragging;
      setDragging(null); setTarget(null);
      if (!t || !id) return;
      const node = byId.get(t.id);
      if (t.zone === 'inside') {
        const kids = siblings(node.id);
        return moveTo(id, node.id, kids.at(-1)?.id ?? null, null);
      }
      const list = siblings(node.parentId);
      const i = list.findIndex((p) => p.id === node.id);
      if (t.zone === 'before') return moveTo(id, node.parentId ?? null, list[i - 1]?.id ?? null, node.id);
      return moveTo(id, node.parentId ?? null, node.id, list[i + 1]?.id ?? null);
    },
    /** Dépôt sous la liste : fin de la racine */
    dropRoot: async () => {
      const id = dragging;
      setDragging(null); setTarget(null);
      if (id) await moveTo(id, null, siblings(null).at(-1)?.id ?? null, null);
    },
  };
}

/** Mise en page commune : arborescence à gauche, contenu à droite. */
function WikiShell({ workspaceId, currentId, ancestorIds = [], onEvent, children }) {
  const navigate = useNavigate();
  const { tree, error, reload } = useWikiTree(workspaceId, onEvent);
  const storageKey = `kz-wiki-open-${workspaceId}`;
  const [expanded, setExpanded] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]')); } catch { return new Set(); }
  });
  // La page courante est toujours visible : ses ancêtres sont dépliés
  useEffect(() => {
    if (ancestorIds.length) setExpanded((s) => new Set([...s, ...ancestorIds]));
  }, [ancestorIds.join(',')]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* stockage indisponible */ }
  }, [expanded, storageKey]);
  const toggle = (id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const expand = (id) => setExpanded((s) => new Set([...s, id]));
  const [q, setQ] = useState('');
  const [newPage, setNewPage] = useState(null); // { parentId }

  const canEdit = tree && tree.myRole !== 'VIEWER';
  const add = (parentId = null) => setNewPage({ parentId });
  const created = (page, { edit, count } = {}) => {
    if (newPage?.parentId) expand(newPage.parentId);
    setNewPage(null);
    reload();
    if (page) navigate(`/wiki/${page.id}${edit ? '?edit=1' : ''}`);
    if (count > 1) window.alert(`${count} pages importées.`);
  };
  const nodes = useMemo(() => (tree ? buildTree(tree.pages) : []), [tree]);
  const pagesById = useMemo(() => new Map((tree?.pages ?? []).map((p) => [p.id, p])), [tree]);
  const dnd = useTreeDnd(tree?.pages, reload, expand);
  const favorites = (tree?.favorites ?? []).map((id) => pagesById.get(id)).filter(Boolean);

  return (
    <div className="h-full flex">
      <aside className="w-64 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 flex flex-col kz-noprint">
        <div className="p-3 border-b border-gray-200 dark:border-slate-800 space-y-2">
          {tree && <Link to={`/w/${workspaceId}`} className="text-xs text-gray-500 hover:underline">← {tree.workspace.name}</Link>}
          <Link to={`/w/${workspaceId}/wiki`} className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white"><BookOpen size={16} /> Wiki</Link>
          <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}&workspaceId=${workspaceId}`); }}>
            <label className="relative block">
              <span className="sr-only">Rechercher dans ce wiki</span>
              <Search size={14} className="absolute left-2.5 top-2.5 text-gray-500 dark:text-gray-400" />
              <input className={`${input} pl-8 py-1.5`} placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
            </label>
          </form>
        </div>
        <nav aria-label="Pages du wiki" className="flex-1 overflow-y-auto p-2"
          onDragOver={(e) => { if (dnd.dragging && e.target === e.currentTarget) { e.preventDefault(); dnd.setTarget(null); } }}
          onDrop={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); dnd.dropRoot(); } }}>
          {favorites.length > 0 && (
            <div className="mb-3">
              <h2 className="px-1 mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1"><Star size={11} /> Favoris</h2>
              <ul>
                {favorites.map((p) => (
                  <li key={p.id}><Link to={`/wiki/${p.id}`} className={`block truncate rounded-md px-2 py-1 text-sm ${p.id === currentId ? 'bg-indigo-50 dark:bg-indigo-900/40 font-semibold text-indigo-700 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800'}`}>{p.icon ? `${p.icon} ` : ''}{p.title}</Link></li>
                ))}
              </ul>
              <h2 className="px-1 mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pages</h2>
            </div>
          )}
          {error && tree && <ErrorBox error={error} />}
          {error && !tree ? (
            <div className="space-y-2">
              <ErrorBox error={error} />
              <button type="button" className={btnGhost} onClick={reload}><RotateCcw size={16} /> Réessayer</button>
            </div>
          ) : !tree ? <Loading /> : nodes.length === 0
            ? <p className="text-sm text-gray-500 p-2">Aucune page.</p>
            : <ul>{nodes.map((n) => <TreeNode key={n.id} node={n} depth={0} currentId={currentId} canEdit={canEdit} onAdd={add} expanded={expanded} toggle={toggle} dnd={dnd} />)}</ul>}
          {canEdit && nodes.length > 1 && <p className="text-[11px] text-gray-500 dark:text-gray-400 px-2 mt-3">Astuce : glissez une page pour la réordonner ou la ranger dans une autre.</p>}
        </nav>
        {canEdit && (
          <div className="p-2 border-t border-gray-200 dark:border-slate-800 flex justify-between">
            <button type="button" className={btnGhost} onClick={() => add(null)}><Plus size={16} /> Nouvelle page</button>
            <NavLink to={`/w/${workspaceId}/wiki/trash`} className={btnGhost} title="Corbeille" aria-label="Corbeille"><Trash2 size={16} /></NavLink>
          </div>
        )}
      </aside>
      <section className="flex-1 overflow-y-auto">{typeof children === 'function' ? children({ tree, error, reloadTree: reload, add }) : children}</section>
      {newPage && (
        <NewPageModal workspaceId={workspaceId} parentId={newPage.parentId} parentTitle={newPage.parentId ? pagesById.get(newPage.parentId)?.title : null}
          onClose={() => setNewPage(null)} onCreated={created} />
      )}
    </div>
  );
}

// --- Accueil du wiki d'un espace ---
function HomePageBlock({ pageId }) {
  const navigate = useNavigate();
  const { data } = useApi(() => api.get(`/wiki/pages/${pageId}`), [pageId]);
  if (!data) return null;
  const p = data.page;
  return (
    <section className={`${card} p-6 mb-8`}>
      <div className="flex justify-between items-start gap-2 mb-3">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">{p.icon ? `${p.icon} ` : ''}{p.title}</h2>
        <Link to={`/wiki/${p.id}`} className={btnGhost}>Ouvrir</Link>
      </div>
      <WikiEditor content={p.content} onNavigate={(href) => navigate(href)} />
    </section>
  );
}

function PageList({ title, icon, pages, empty, meta }) {
  return (
    <>
      <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1">{icon} {title}</h2>
      {pages.length === 0 ? <p className="text-sm text-gray-500">{empty}</p> : (
        <ul className={`${card} divide-y divide-gray-100 dark:divide-slate-800`}>
          {pages.map((p) => (
            <li key={p.id}><Link to={`/wiki/${p.id}`} className="flex justify-between gap-4 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800/60">
              <span className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 min-w-0"><FileText size={14} className="text-gray-500 dark:text-gray-400 shrink-0" /> <span className="truncate">{p.icon ? `${p.icon} ` : ''}{p.title}</span></span>
              <span className="text-xs text-gray-500 shrink-0">{meta(p)}</span>
            </Link></li>
          ))}
        </ul>
      )}
    </>
  );
}

export function WikiHome() {
  const { id } = useParams();
  return (
    <WikiShell workspaceId={id}>
      {({ tree, error, add }) => {
        // En erreur, le message et « Réessayer » sont dans le panneau de gauche : pas de chargement sans fin ici
        if (!tree) return error ? <p className="p-8 text-sm text-gray-500">Le wiki de cet espace n&apos;a pas pu être chargé.</p> : <Loading />;
        const byId = new Map(tree.pages.map((p) => [p.id, p]));
        const recentlyChanged = [...tree.pages].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 8);
        const viewed = tree.recent.map((r) => ({ ...byId.get(r.pageId), viewedAt: r.viewedAt })).filter((p) => p.id);
        const favorites = tree.favorites.map((fid) => byId.get(fid)).filter(Boolean);
        return (
          <div className="p-8 max-w-3xl mx-auto">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Wiki · {tree.workspace.name}</h1>
                <p className="text-sm text-gray-500">Documentation de l&apos;espace : procédures, architecture, comptes rendus… Tapez « / » dans une page pour insérer un bloc, « [[ » pour lier une page.</p>
              </div>
              {tree.myRole !== 'VIEWER' && <button type="button" className={btnPrimary} onClick={() => add(null)}><Plus size={16} /> Nouvelle page</button>}
            </div>
            {tree.homePageId && <HomePageBlock pageId={tree.homePageId} />}
            {favorites.length > 0 && <PageList title="Mes favoris" icon={<Star size={14} />} pages={favorites} empty="" meta={(p) => fmt(p.updatedAt)} />}
            <PageList title="Consultées récemment" icon={<Clock size={14} />} pages={viewed} empty="Les pages que vous ouvrez apparaîtront ici." meta={(p) => `vue le ${fmt(p.viewedAt)}`} />
            <PageList title="Modifiées récemment" icon={<Pencil size={14} />} pages={recentlyChanged} empty="Aucune page pour l'instant." meta={(p) => fmt(p.updatedAt)} />
          </div>
        );
      }}
    </WikiShell>
  );
}

// --- Déplacement dans l'arborescence (alternative au glisser-déposer, accessible au clavier) ---
function MoveModal({ page, pages, onClose, onMoved }) {
  // Exclusion de la page et de sa descendance (pas de cycle)
  const excluded = useMemo(() => {
    const ex = new Set([page.id]);
    let grew = true;
    while (grew) { grew = false; for (const p of pages) if (p.parentId && ex.has(p.parentId) && !ex.has(p.id)) { ex.add(p.id); grew = true; } }
    return ex;
  }, [page.id, pages]);
  const options = useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => { for (const n of nodes) { if (excluded.has(n.id)) continue; out.push({ id: n.id, label: `${'  '.repeat(depth)}${n.title}` }); walk(n.children, depth + 1); } };
    walk(buildTree(pages), 0);
    return out;
  }, [pages, excluded]);
  const siblings = (parentId) => pages.filter((p) => (p.parentId ?? null) === parentId && p.id !== page.id);
  const [parentId, setParentId] = useState(page.parentId ?? '');
  const [beforeId, setBeforeId] = useState('');
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const pid = parentId || null;
      const list = siblings(pid);
      const idx = beforeId ? list.findIndex((p) => p.id === beforeId) : list.length;
      await api.post(`/wiki/pages/${page.id}/move`, { parentId: pid, afterId: list[idx - 1]?.id ?? null, beforeId: list[idx]?.id ?? null });
      onMoved();
    } catch (x) { setErr(x); }
  };
  return (
    <Modal title={`Déplacer « ${page.title} »`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <ErrorBox error={err} />
        <label className="block text-sm text-gray-700 dark:text-gray-300">Sous la page
          <select className={`${input} mt-1`} value={parentId} onChange={(e) => { setParentId(e.target.value); setBeforeId(''); }}>
            <option value="">(racine du wiki)</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="block text-sm text-gray-700 dark:text-gray-300">Position
          <select className={`${input} mt-1`} value={beforeId} onChange={(e) => setBeforeId(e.target.value)}>
            {siblings(parentId || null).map((p) => <option key={p.id} value={p.id}>Avant « {p.title} »</option>)}
            <option value="">À la fin</option>
          </select>
        </label>
        <div className="flex justify-end"><button className={btnPrimary}><FolderInput size={16} /> Déplacer</button></div>
      </form>
    </Modal>
  );
}

/** Menu « Plus » de la page */
function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="relative" ref={ref}>
      <button type="button" className={btnGhost} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Plus d'actions"><Ellipsis size={16} /></button>
      {open && (
        <span role="menu" className="absolute right-0 top-9 z-30 w-64 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-1">
          {items.filter(Boolean).map((it) => {
            const cls = `w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left ${it.danger ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800'}`;
            return it.href
              ? <a key={it.label} role="menuitem" href={it.href} className={cls} onClick={() => setOpen(false)}>{it.icon} {it.label}</a>
              : <button key={it.label} type="button" role="menuitem" className={cls} onClick={() => { setOpen(false); it.run(); }}>{it.icon} {it.label}</button>;
          })}
        </span>
      )}
    </span>
  );
}

// Brouillons locaux (localStorage, par page) : filet de sécurité côté poste. Toute erreur de stockage est ignorée.
const draftKey = (id) => `kz-wiki-draft:${id}`;
function writeLocalDraft(id, d) { try { localStorage.setItem(draftKey(id), JSON.stringify({ ...d, at: new Date().toISOString() })); } catch { /* stockage plein ou interdit */ } }
function readLocalDraft(id) { try { const d = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null'); return d?.content ? d : null; } catch { return null; } }
function clearLocalDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch { /* idem */ } }

// --- Page : lecture et édition (co-édition en temps réel quand c'est possible) ---
export function WikiPage({ user }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null); // { title, icon, content }
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const [session, setSession] = useState(null); // co-édition : objet de session, false = indisponible (édition seule)
  const [peers, setPeers] = useState([]);
  const [linksKey, setLinksKey] = useState(0);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const sessionRef = useRef(null);
  sessionRef.current = session;
  const articleRef = useRef(null);

  const load = useCallback(() => api.get(`/wiki/pages/${id}`).then((r) => { setPage(r.page); setError(null); }, setError), [id]);

  const closeSession = (opts) => { sessionRef.current?.close?.(opts); sessionRef.current = null; setSession(null); setPeers([]); };
  useEffect(() => { closeSession(); setEditing(false); setDirty(false); setConflict(null); setNotice(null); setModal(null); load(); }, [id, load]);
  useEffect(() => () => closeSession(), []);

  // Ouverture directe en édition (nouvelle page)
  useEffect(() => {
    if (page && params.get('edit') === '1' && page.myRole !== 'VIEWER' && !page.deletedAt) {
      startEdit(page);
      setParams({}, { replace: true });
    }
  }, [page]);

  // Modifications d'autres utilisateurs reçues en temps réel
  const onEvent = useCallback((e) => {
    if (e.reason === 'resync') { setLinksKey((k) => k + 1); if (!editingRef.current) load(); return; }
    if (e.reason === 'links') { setLinksKey((k) => k + 1); return; }
    if (e.pageId !== id) { setLinksKey((k) => k + 1); return; }
    if (e.reason === 'purge') { navigate(-1); return; }
    if (editingRef.current) {
      if (e.reason !== 'update') return;
      if (sessionRef.current) {
        // Co-édition : le contenu est déjà partagé, seule la version de référence change
        api.get(`/wiki/pages/${id}`).then((r) => setPage((p) => ({ ...p, version: r.page.version, updatedAt: r.page.updatedAt, updatedBy: r.page.updatedBy })), () => {});
        if (e.by !== user?.displayName) setNotice(`${e.by} a enregistré la page.`);
      } else {
        setNotice(`${e.by} vient d'enregistrer cette page. Votre enregistrement sera contrôlé.`);
      }
    } else load();
  }, [id, load, navigate, user?.displayName]);

  // Brouillon local : copie de la saisie dans le navigateur toutes les 2 s (coupure réseau, plantage, onglet fermé
  // en édition seule). Proposé à la réouverture de la page ; effacé à l'enregistrement ou à l'abandon.
  useEffect(() => {
    if (!editing || !dirty || !draft) return undefined;
    const t = setTimeout(() => writeLocalDraft(id, { ...draft, version: page?.version }), 2000);
    return () => clearTimeout(t);
  }, [editing, dirty, draft, id, page?.version]);
  const [localDraft, setLocalDraft] = useState(null);
  useEffect(() => { setLocalDraft(readLocalDraft(id)); }, [id]);
  const resumeDraft = () => {
    const d = localDraft;
    setLocalDraft(null);
    startEdit({ ...page, title: d.title, icon: d.icon, content: d.content });
    setDirty(true);
    if (d.version !== page.version) setNotice('La page a été modifiée depuis ce brouillon : relisez avant d\'enregistrer (la version actuelle reste dans l\'historique).');
  };
  const dropDraft = () => { clearLocalDraft(id); setLocalDraft(null); };

  // Protection contre la perte de saisie
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  function startEdit(p = page) {
    setDraft({ title: p.title, icon: p.icon ?? null, content: p.content });
    setDirty(false); setConflict(null); setNotice(null); setSession(null); setEditing(true);
    if (!user) { setSession(false); return; }
    loadCollab().then((m) => m.openCollab(p.id, user, {
      onPeers: setPeers,
      onReset: () => {
        closeSession(); setEditing(false); setDirty(false);
        setNotice('La page a été restaurée ou placée dans la corbeille par un autre utilisateur : l\'édition a été fermée.');
        load();
      },
    }).then((s) => ({ s, ext: { Collaboration: m.Collaboration, CollaborationCaret: m.CollaborationCaret } }))).then(({ s, ext }) => {
      s.extensions = ext;
      if (!editingRef.current) { s.close(); return; }
      if (s.seed) { s.meta.set('title', p.title); s.meta.set('icon', p.icon ?? ''); } else {
        setDraft((d) => ({ ...d, title: s.meta.get('title') ?? d.title, icon: s.meta.get('icon') || null }));
      }
      s.meta.observe((ev) => {
        if (ev.transaction.local) return;
        setDraft((d) => ({ ...d, title: s.meta.get('title') ?? d.title, icon: s.meta.get('icon') || null }));
      });
      setPeers(s.peers());
      setSession(s);
    }, () => setSession(false));
  }
  const setTitle = (v) => { setDraft((d) => ({ ...d, title: v })); setDirty(true); sessionRef.current?.meta?.set('title', v); };
  const setIcon = (v) => { setDraft((d) => ({ ...d, icon: v })); setDirty(true); sessionRef.current?.meta?.set('icon', v ?? ''); };

  const cancel = () => {
    const msg = peers.length
      ? 'Quitter l\'édition ? Les modifications restent dans le document partagé : elles seront enregistrées par les autres éditeurs ou automatiquement au départ du dernier.'
      : 'Abandonner vos modifications ?';
    if ((dirty || peers.length) && !window.confirm(msg)) return;
    // Seul éditeur : abandon explicite, rien n'est enregistré automatiquement
    closeSession({ discard: !peers.length }); clearLocalDraft(id); setEditing(false); setDirty(false); setConflict(null); setNotice(null);
  };

  const save = async (version = page.version, retried = false) => {
    setSaving(true);
    try {
      const r = await api.patch(`/wiki/pages/${id}`, { version, title: draft.title.trim() || 'Sans titre', icon: draft.icon || null, content: draft.content });
      setPage((p) => ({ ...p, ...r.page }));
      closeSession(); clearLocalDraft(id); setEditing(false); setDirty(false); setConflict(null); setNotice(null);
    } catch (x) {
      if (x.status === 409 && x.code === 'WIKI_CONFLICT') {
        // En co-édition, l'autre enregistrement porte sur le même document partagé : on enregistre par-dessus
        if (sessionRef.current && !retried) { const latest = (await api.get(`/wiki/pages/${id}`)).page; setSaving(false); return save(latest.version, true); }
        setConflict(x);
      } else setError(x);
    } finally { setSaving(false); }
  };
  // Ctrl+S
  useEffect(() => {
    if (!editing) return undefined;
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!saving) save(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const overwrite = async () => {
    const latest = (await api.get(`/wiki/pages/${id}`)).page;
    await save(latest.version); // la version de l'autre utilisateur reste dans l'historique
  };
  const discardMine = async () => { closeSession({ discard: !peers.length }); clearLocalDraft(id); setEditing(false); setDirty(false); setConflict(null); await load(); };

  const uploadFile = async (file) => {
    try {
      const f = (await api.upload(`/wiki/pages/${id}/files`, file)).file;
      return { url: f.url, inline: f.inline, filename: f.filename, size: f.size, mimetype: f.mimetype };
    } catch (x) { window.alert(x.message); return null; }
  };
  const trash = async () => {
    if (!window.confirm(`Placer « ${page.title} » et ses sous-pages dans la corbeille ?`)) return;
    try { await api.del(`/wiki/pages/${id}`); navigate(page.parentId ? `/wiki/${page.parentId}` : `/w/${page.workspaceId}/wiki`); } catch (x) { setError(x); }
  };
  const restore = async () => { try { await api.post(`/wiki/pages/${id}/restore`); load(); } catch (x) { setError(x); } };
  const toggleFavorite = async () => {
    try {
      if (page.favorite) await api.del(`/wiki/pages/${id}/favorite`); else await api.put(`/wiki/pages/${id}/favorite`);
      setPage((p) => ({ ...p, favorite: !p.favorite }));
    } catch (x) { setError(x); }
  };

  const headings = useMemo(() => docHeadings(page?.content), [page?.content]);

  if (!page) return error ? <div className="p-6"><ErrorBox error={error} /></div> : <Loading />;
  const canEdit = page.myRole !== 'VIEWER' && !page.deletedAt;
  const isOwner = page.myRole === 'OWNER';
  const collab = session ? { ydoc: session.ydoc, provider: session.provider, seed: session.seed, extensions: session.extensions, user: { name: user.displayName, color: colorOf(user.id) } } : undefined;

  return (
    <WikiShell workspaceId={page.workspaceId} currentId={page.id} ancestorIds={page.breadcrumb.map((b) => b.id)} onEvent={onEvent}>
      {({ tree, reloadTree, add }) => {
        const setHome = async (pageId) => { try { await api.put(`/workspaces/${page.workspaceId}/wiki/home`, { pageId }); reloadTree(); } catch (x) { setError(x); } };
        const isHome = tree?.homePageId === page.id;
        const linkPages = tree ? withPaths(tree.pages).filter((p) => p.id !== page.id) : [];
        return (
          <div className="flex justify-center gap-8 px-6 py-6">
            <article ref={articleRef} className="w-full max-w-4xl min-w-0">
              <nav aria-label="Fil d'Ariane" className="text-xs text-gray-500 mb-3 flex flex-wrap gap-1 kz-noprint">
                <Link to={`/w/${page.workspaceId}/wiki`} className="hover:underline">Wiki</Link>
                {page.breadcrumb.map((b) => <span key={b.id}>/ <Link to={`/wiki/${b.id}`} className="hover:underline">{b.title}</Link></span>)}
              </nav>
              {page.deletedAt && (
                <div role="status" className="mb-4 p-3 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-sm flex justify-between items-center gap-2">
                  Cette page est dans la corbeille depuis le {fmt(page.deletedAt)}.
                  {page.myRole !== 'VIEWER' && <button type="button" className={btnGhost} onClick={restore}><RotateCcw size={16} /> Restaurer</button>}
                </div>
              )}
              <ErrorBox error={error} />
              {conflict && (
                <div role="alert" className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 text-sm space-y-2">
                  <p><strong>{conflict.message}.</strong> Vos modifications ne sont pas perdues : choisissez comment continuer.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={btnPrimary} onClick={overwrite}>Enregistrer ma version (l&apos;autre reste dans l&apos;historique)</button>
                    <button type="button" className={btnGhost} onClick={discardMine}>Abandonner ma version et recharger</button>
                  </div>
                </div>
              )}
              {localDraft && !editing && canEdit && (
                <div role="status" className="mb-4 p-3 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-100 text-sm flex flex-wrap justify-between items-center gap-2">
                  <span>Un brouillon non enregistré du {fmt(localDraft.at)} existe pour cette page sur ce poste.</span>
                  <span className="flex gap-2">
                    <button type="button" className={btnPrimary} onClick={resumeDraft}>Reprendre le brouillon</button>
                    <button type="button" className={btnGhost} onClick={dropDraft}>Supprimer</button>
                  </span>
                </div>
              )}
              {notice && !conflict && (
                <div role="status" className="mb-4 p-3 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-sm flex justify-between gap-2">
                  <span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Fermer le message"><X size={14} /></button>
                </div>
              )}

              <header className="flex flex-wrap items-start justify-between gap-3 mb-2">
                {editing
                  ? <div className="flex-1 min-w-0 flex items-center gap-3">
                      <IconPicker value={draft.icon} onChange={setIcon} />
                      <input className="flex-1 min-w-0 text-3xl font-bold bg-transparent border-b border-dashed border-gray-300 dark:border-slate-600 focus:outline-none text-gray-900 dark:text-white" aria-label="Titre de la page"
                        value={draft.title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
                    </div>
                  : <h1 className="flex-1 min-w-0 text-3xl font-bold text-gray-900 dark:text-white break-words">{page.icon ? `${page.icon} ` : ''}{page.title}</h1>}
                <div className="flex flex-wrap items-center gap-1 kz-noprint">
                  {editing ? <>
                    <Peers peers={peers} />
                    <span role="status" aria-live="polite" className={`text-xs mr-1 ${dirty ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500'}`}>
                      {saving ? '' : dirty ? (session ? 'Non enregistré (sauvegarde auto. à la fermeture)' : 'Modifications non enregistrées') : 'Aucune modification'}
                    </span>
                    <button type="button" className={btnPrimary} onClick={() => save()} disabled={saving || session === null}><Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}</button>
                    <button type="button" className={btnGhost} onClick={cancel}><X size={16} /> {peers.length ? 'Quitter' : 'Annuler'}</button>
                  </> : <>
                    {canEdit && <button type="button" className={btnPrimary} onClick={() => startEdit()}><Pencil size={16} /> Modifier</button>}
                    <button type="button" className={btnGhost} onClick={toggleFavorite} aria-pressed={page.favorite} title={page.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} aria-label={page.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}>
                      <Star size={16} className={page.favorite ? 'fill-yellow-400 text-yellow-500' : ''} />
                    </button>
                    <button type="button" className={btnGhost} onClick={() => setModal('history')}><History size={16} /> Historique</button>
                    <MoreMenu items={[
                      canEdit && { label: 'Nouvelle sous-page', icon: <Plus size={14} />, run: () => add(page.id) },
                      canEdit && { label: 'Importer du Markdown ici', icon: <FileUp size={14} />, run: () => add(page.id) },
                      canEdit && { label: 'Déplacer…', icon: <FolderInput size={14} />, run: () => setModal('move') },
                      { label: page.restricted || page.restrictedBy.length ? 'Accès restreint…' : 'Restreindre l\'accès…', icon: <Lock size={14} />, run: () => setModal('access') },
                      isOwner && !page.deletedAt && (isHome
                        ? { label: 'Ne plus afficher en accueil', icon: <House size={14} />, run: () => setHome(null) }
                        : { label: 'Afficher en tête de l\'accueil', icon: <House size={14} />, run: () => setHome(page.id) }),
                      { label: 'Exporter en Markdown', icon: <Download size={14} />, href: `/api/wiki/pages/${page.id}/export.md` },
                      { label: 'Exporter la section (ZIP)', icon: <FileArchive size={14} />, href: `/api/wiki/pages/${page.id}/export.zip` },
                      { label: 'Imprimer / PDF', icon: <Printer size={14} />, run: () => window.print() },
                      canEdit && { label: 'Placer dans la corbeille', icon: <Trash2 size={14} />, run: trash, danger: true },
                    ]} />
                  </>}
                </div>
              </header>
              <p className="text-xs text-gray-500 mb-6 flex flex-wrap items-center gap-2">
                <span>Modifiée le {fmt(page.updatedAt)}{page.updatedBy ? ` par ${page.updatedBy.displayName}` : ''} · version {page.version}</span>
                {page.restrictedBy.length > 0 && (
                  <button type="button" onClick={() => setModal('access')} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200">
                    <Lock size={11} /> Accès restreint{page.restricted ? '' : ` (section « ${page.restrictedBy[0].title} »)`}
                  </button>
                )}
                {isHome && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200"><House size={11} /> Accueil du wiki</span>}
                {editing && session === false && <span className="text-amber-600">Co-édition indisponible : vous éditez seul.</span>}
              </p>

              {!editing && <Toc headings={headings} containerRef={articleRef} compact />}

              {editing && session === null ? <Loading /> : (
                <WikiEditor
                  key={editing ? (session ? `collab-${page.id}` : `solo-${page.id}`) : `read-${page.id}`}
                  content={editing ? draft.content : page.content}
                  editable={editing}
                  collab={editing ? collab : undefined}
                  pages={linkPages}
                  onChange={(c) => { setDraft((d) => ({ ...d, content: c })); setDirty(true); }}
                  onUploadFile={uploadFile}
                  onNavigate={(href) => navigate(href)}
                />
              )}

              {!editing && page.children.length > 0 && (
                <section className="mt-10 kz-noprint">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Sous-pages</h2>
                  <ul className="grid sm:grid-cols-2 gap-2">
                    {page.children.map((c) => (
                      <li key={c.id}><Link to={`/wiki/${c.id}`} className={`${card} flex items-center gap-2 px-3 py-2 text-sm hover:shadow-sm text-gray-800 dark:text-gray-200`}><FileText size={14} className="text-gray-500 dark:text-gray-400" /> {c.icon ? `${c.icon} ` : ''}{c.title}</Link></li>
                    ))}
                  </ul>
                </section>
              )}
              {!editing && !page.deletedAt && <TaskLinks page={page} canEdit={canEdit} refreshKey={linksKey} />}
              {!editing && <Backlinks pageId={page.id} refreshKey={`${linksKey}-${page.version}`} />}

              {modal === 'history' && <HistoryModal page={page} canEdit={canEdit} onClose={() => setModal(null)} onRestored={(p) => { setPage((x) => ({ ...x, ...p })); setModal(null); }} />}
              {modal === 'move' && tree && <MoveModal page={page} pages={tree.pages} onClose={() => setModal(null)} onMoved={() => { setModal(null); reloadTree(); load(); }} />}
              {modal === 'access' && <AccessModal page={page} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadTree(); load(); }} />}
            </article>
            {!editing && headings.filter((h) => h.level <= 3 && h.text).length >= 2 && (
              <aside className="hidden xl:block w-56 shrink-0">
                <div className="sticky top-6"><Toc headings={headings} containerRef={articleRef} /></div>
              </aside>
            )}
          </div>
        );
      }}
    </WikiShell>
  );
}

// --- Corbeille ---
export function WikiTrash() {
  const { id } = useParams();
  const { data, error, reload } = useApi(() => api.get(`/workspaces/${id}/wiki/trash`), [id]);
  const [err, setErr] = useState(null);
  const act = (fn) => async () => { try { setErr(null); await fn(); reload(); } catch (x) { setErr(x); } };
  return (
    <WikiShell workspaceId={id} onEvent={reload}>
      <div className="p-8 max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Corbeille</h1>
        <p className="text-sm text-gray-500 mb-6">Les pages restaurées reviennent avec leurs sous-pages. La suppression définitive est réservée aux propriétaires de l&apos;espace.</p>
        <ErrorBox error={error ?? err} />
        {!data ? <Loading /> : data.pages.length === 0 ? <p className="text-sm text-gray-500">La corbeille est vide.</p> : (
          <ul className={`${card} divide-y divide-gray-100 dark:divide-slate-800`}>
            {data.pages.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="text-sm text-gray-800 dark:text-gray-200">
                  <Link to={`/wiki/${p.id}`} className="hover:underline">{p.title}</Link>
                  <span className="block text-xs text-gray-500">supprimée le {fmt(p.deletedAt)}</span>
                </span>
                <span className="flex gap-1">
                  <button type="button" className={btnGhost} onClick={act(() => api.post(`/wiki/pages/${p.id}/restore`))}><RotateCcw size={16} /> Restaurer</button>
                  {data.myRole === 'OWNER' && (
                    <button type="button" className={btnDanger} onClick={act(async () => {
                      if (window.confirm(`Supprimer définitivement « ${p.title} », ses sous-pages, leur historique et leurs images ?`)) await api.del(`/wiki/pages/${p.id}/purge`);
                    })}><Trash2 size={16} /> Supprimer</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </WikiShell>
  );
}

// --- Recherche (tous les espaces accessibles, ou un seul) ---
export function WikiSearch() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const workspaceId = params.get('workspaceId');
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const { data, error } = useApi(
    () => (q.trim() ? api.get(`/wiki/search?q=${encodeURIComponent(q.trim())}${workspaceId ? `&workspaceId=${workspaceId}` : ''}`) : Promise.resolve({ results: [] })),
    [q, workspaceId],
  );
  const submit = (e) => { e.preventDefault(); setParams({ q: text, ...(workspaceId ? { workspaceId } : {}) }); };
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Recherche dans le wiki</h1>
      <form onSubmit={submit} className="flex gap-2 mb-2" role="search">
        <input className={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Mots-clés, « expression exacte », -exclusion" aria-label="Recherche" maxLength={200} autoFocus />
        <button className={btnPrimary}><Search size={16} /> Rechercher</button>
      </form>
      {workspaceId && <p className="text-xs text-gray-500 mb-4">Limité à un espace · <button type="button" className="underline" onClick={() => setParams({ q })}>chercher partout</button></p>}
      <ErrorBox error={error} />
      {q && !data ? <Loading /> : data && q && (
        data.results.length === 0 ? <p className="text-sm text-gray-500 mt-4">Aucun résultat.</p> : (
          <ul className="space-y-3 mt-4">
            {data.results.map((r) => (
              <li key={r.id} className={`${card} p-4`}>
                <Link to={`/wiki/${r.id}`} className="font-semibold text-indigo-700 dark:text-indigo-300 hover:underline">{r.icon ? `${r.icon} ` : ''}{r.title}</Link>
                <p className="text-xs text-gray-500 mb-1">{r.workspaceName} · {fmt(r.updatedAt)}</p>
                {r.snippet && <p className="text-sm text-gray-700 dark:text-gray-300"><Snippet text={r.snippet} /></p>}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
