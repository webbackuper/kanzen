// Module Wiki : arborescence de pages par espace, lecture / édition, historique, corbeille, recherche.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import {
  BookOpen, ChevronDown, ChevronRight, Download, FileText, FolderInput, History, Pencil, Plus, RotateCcw, Save, Search, Trash2, X,
} from 'lucide-react';
import { api } from '../../api';
import { ErrorBox, Loading, Modal, btnDanger, btnGhost, btnPrimary, card, input, useApi } from '../../ui';
import { WikiEditor } from './WikiEditor';

const fmt = (d) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

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

/** Extrait de recherche : les balises \u0001…\u0002 de PostgreSQL deviennent <mark>, sans jamais interpréter de HTML. */
export function Snippet({ text }) {
  // eslint-disable-next-line no-control-regex -- balises d'extrait posées par ts_headline (serveur)
  const parts = String(text ?? '').split(/(\u0001[^\u0002]*\u0002)/);
  return <>{parts.map((s, i) => (s.startsWith('\u0001') ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-700/60 rounded px-0.5">{s.slice(1, -1)}</mark> : <span key={i}>{s}</span>))}</>;
}

// --- Données de l'espace (arborescence) partagées par les vues, rafraîchies en temps réel ---
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
    socket.on('connect', () => socket.emit('wiki:join', workspaceId));
    socket.on('wiki:changed', (e) => { if (e.workspaceId === workspaceId) { load(); eventRef.current?.(e); } });
    return () => socket.disconnect();
  }, [workspaceId, load]);
  return { tree, error, reload: load };
}

function TreeNode({ node, depth, currentId, canEdit, onAdd, expanded, toggle }) {
  const open = expanded.has(node.id);
  return (
    <li>
      <div className={`group flex items-center gap-1 rounded-md pr-1 ${node.id === currentId ? 'bg-indigo-50 dark:bg-indigo-900/40' : 'hover:bg-gray-100 dark:hover:bg-slate-800'}`} style={{ paddingLeft: depth * 12 }}>
        <button type="button" onClick={() => toggle(node.id)} aria-label={open ? 'Replier' : 'Déplier'} aria-expanded={open}
          className={`p-0.5 text-gray-400 ${node.children.length ? '' : 'invisible'}`}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Link to={`/wiki/${node.id}`} className={`flex-1 truncate py-1 text-sm ${node.id === currentId ? 'font-semibold text-indigo-700 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-300'}`}>
          {node.icon ? `${node.icon} ` : ''}{node.title}
        </Link>
        {canEdit && (
          <button type="button" onClick={() => onAdd(node.id)} aria-label={`Nouvelle sous-page de ${node.title}`} title="Nouvelle sous-page"
            className="p-0.5 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 focus:opacity-100">
            <Plus size={14} />
          </button>
        )}
      </div>
      {open && node.children.length > 0 && (
        <ul>{node.children.map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} currentId={currentId} canEdit={canEdit} onAdd={onAdd} expanded={expanded} toggle={toggle} />)}</ul>
      )}
    </li>
  );
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
  const [q, setQ] = useState('');

  const canEdit = tree && tree.myRole !== 'VIEWER';
  const add = async (parentId = null) => {
    try {
      const { page } = await api.post(`/workspaces/${workspaceId}/wiki`, { title: 'Sans titre', parentId });
      if (parentId) setExpanded((s) => new Set([...s, parentId]));
      reload();
      navigate(`/wiki/${page.id}?edit=1`);
    } catch (x) { window.alert(x.message); }
  };
  const nodes = useMemo(() => (tree ? buildTree(tree.pages) : []), [tree]);

  return (
    <div className="h-full flex">
      <aside className="w-64 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 flex flex-col">
        <div className="p-3 border-b border-gray-200 dark:border-slate-800 space-y-2">
          {tree && <Link to={`/w/${workspaceId}`} className="text-xs text-gray-500 hover:underline">← {tree.workspace.name}</Link>}
          <Link to={`/w/${workspaceId}/wiki`} className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white"><BookOpen size={16} /> Wiki</Link>
          <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}&workspaceId=${workspaceId}`); }}>
            <label className="relative block">
              <span className="sr-only">Rechercher dans ce wiki</span>
              <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
              <input className={`${input} pl-8 py-1.5`} placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
            </label>
          </form>
        </div>
        <nav aria-label="Pages du wiki" className="flex-1 overflow-y-auto p-2">
          {error && tree && <ErrorBox error={error} />}
          {error && !tree ? (
            <div className="space-y-2">
              <ErrorBox error={error} />
              <button type="button" className={btnGhost} onClick={reload}><RotateCcw size={16} /> Réessayer</button>
            </div>
          ) : !tree ? <Loading /> : nodes.length === 0
            ? <p className="text-sm text-gray-500 p-2">Aucune page.</p>
            : <ul>{nodes.map((n) => <TreeNode key={n.id} node={n} depth={0} currentId={currentId} canEdit={canEdit} onAdd={add} expanded={expanded} toggle={toggle} />)}</ul>}
        </nav>
        {canEdit && (
          <div className="p-2 border-t border-gray-200 dark:border-slate-800 flex justify-between">
            <button type="button" className={btnGhost} onClick={() => add(null)}><Plus size={16} /> Nouvelle page</button>
            <NavLink to={`/w/${workspaceId}/wiki/trash`} className={btnGhost} title="Corbeille" aria-label="Corbeille"><Trash2 size={16} /></NavLink>
          </div>
        )}
      </aside>
      <section className="flex-1 overflow-y-auto">{typeof children === 'function' ? children({ tree, error, reloadTree: reload, add }) : children}</section>
    </div>
  );
}

// --- Accueil du wiki d'un espace ---
export function WikiHome() {
  const { id } = useParams();
  return (
    <WikiShell workspaceId={id}>
      {({ tree, error, add }) => {
        // En erreur, le message et « Réessayer » sont dans le panneau de gauche : pas de chargement sans fin ici
        if (!tree) return error ? <p className="p-8 text-sm text-gray-500">Le wiki de cet espace n&apos;a pas pu être chargé.</p> : <Loading />;
        const recent = [...tree.pages].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 10);
        return (
          <div className="p-8 max-w-3xl mx-auto">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Wiki · {tree.workspace.name}</h1>
            <p className="text-sm text-gray-500 mb-6">Documentation de l&apos;espace : procédures, architecture, comptes rendus…</p>
            {tree.myRole !== 'VIEWER' && <button type="button" className={btnPrimary} onClick={() => add(null)}><Plus size={16} /> Nouvelle page</button>}
            <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Modifiées récemment</h2>
            {recent.length === 0 ? <p className="text-sm text-gray-500">Aucune page pour l&apos;instant.</p> : (
              <ul className={`${card} divide-y divide-gray-100 dark:divide-slate-800`}>
                {recent.map((p) => (
                  <li key={p.id}><Link to={`/wiki/${p.id}`} className="flex justify-between gap-4 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800/60">
                    <span className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"><FileText size={14} className="text-gray-400" /> {p.icon ? `${p.icon} ` : ''}{p.title}</span>
                    <span className="text-xs text-gray-500 shrink-0">{fmt(p.updatedAt)}</span>
                  </Link></li>
                ))}
              </ul>
            )}
          </div>
        );
      }}
    </WikiShell>
  );
}

// --- Historique d'une page ---
function HistoryModal({ page, canEdit, onClose, onRestored }) {
  const { data, error } = useApi(() => api.get(`/wiki/pages/${page.id}/revisions`), [page.id]);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const show = async (r) => { try { setPreview((await api.get(`/wiki/revisions/${r.id}`)).revision); } catch (x) { setErr(x); } };
  const restore = async () => {
    if (!window.confirm(`Restaurer la version ${preview.version} ? La version actuelle reste disponible dans l'historique.`)) return;
    try { const r = await api.post(`/wiki/revisions/${preview.id}/restore`, { version: page.version }); onRestored(r.page); } catch (x) { setErr(x); }
  };
  return (
    <Modal title={`Historique : ${page.title}`} wide onClose={onClose}>
      <ErrorBox error={error ?? err} />
      <div className="grid md:grid-cols-3 gap-4">
        <ul className="md:col-span-1 max-h-[60vh] overflow-y-auto divide-y divide-gray-100 dark:divide-slate-800">
          {!data ? <Loading /> : data.revisions.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => show(r)} className={`w-full text-left px-2 py-2 text-sm ${preview?.id === r.id ? 'bg-indigo-50 dark:bg-indigo-900/40' : 'hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
                <span className="block font-medium text-gray-800 dark:text-gray-200">Version {r.version}{r.version === page.version ? ' (actuelle)' : ''}</span>
                <span className="block text-xs text-gray-500">{fmt(r.createdAt)} · {r.author?.displayName ?? 'compte supprimé'}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="md:col-span-2 max-h-[60vh] overflow-y-auto border border-gray-200 dark:border-slate-700 rounded-lg p-4">
          {!preview ? <p className="text-sm text-gray-500">Choisissez une version à consulter.</p> : <>
            <h3 className="text-xl font-bold mb-3 text-gray-900 dark:text-white">{preview.title}</h3>
            <WikiEditor key={preview.id} content={preview.content} />
          </>}
        </div>
      </div>
      {preview && canEdit && preview.version !== page.version && (
        <div className="mt-4 flex justify-end"><button type="button" className={btnPrimary} onClick={restore}><RotateCcw size={16} /> Restaurer cette version</button></div>
      )}
    </Modal>
  );
}

// --- Déplacement dans l'arborescence ---
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
    const walk = (nodes, depth) => { for (const n of nodes) { if (excluded.has(n.id)) continue; out.push({ id: n.id, label: `${'  '.repeat(depth)}${n.title}` }); walk(n.children, depth + 1); } };
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

// --- Page : lecture et édition ---
export function WikiPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null); // { title, content }
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const editingRef = useRef(false);
  editingRef.current = editing;

  const load = useCallback(() => api.get(`/wiki/pages/${id}`).then((r) => { setPage(r.page); setError(null); }, setError), [id]);
  useEffect(() => { setEditing(false); setDirty(false); setConflict(null); setNotice(null); setModal(null); load(); }, [id, load]);

  // Ouverture directe en édition (nouvelle page)
  useEffect(() => {
    if (page && params.get('edit') === '1' && page.myRole !== 'VIEWER' && !page.deletedAt) {
      startEdit(page);
      setParams({}, { replace: true });
    }
  }, [page]);

  // Modifications d'autres utilisateurs reçues en temps réel
  const onEvent = useCallback((e) => {
    if (e.pageId !== id) return;
    if (e.reason === 'purge') { navigate(-1); return; }
    if (editingRef.current) { if (e.reason === 'update') setNotice(`${e.by} vient d'enregistrer cette page. Votre enregistrement sera contrôlé.`); } else load();
  }, [id, load, navigate]);

  // Protection contre la perte de saisie
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  function startEdit(p = page) { setDraft({ title: p.title, content: p.content }); setDirty(false); setConflict(null); setNotice(null); setEditing(true); }
  const cancel = () => {
    if (dirty && !window.confirm('Abandonner vos modifications ?')) return;
    setEditing(false); setDirty(false); setConflict(null); setNotice(null);
  };

  const save = async (version = page.version) => {
    setSaving(true);
    try {
      const r = await api.patch(`/wiki/pages/${id}`, { version, title: draft.title.trim() || 'Sans titre', content: draft.content });
      setPage((p) => ({ ...p, ...r.page }));
      setEditing(false); setDirty(false); setConflict(null); setNotice(null);
    } catch (x) {
      if (x.status === 409 && x.code === 'WIKI_CONFLICT') setConflict(x);
      else setError(x);
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
  const discardMine = async () => { setEditing(false); setDirty(false); setConflict(null); await load(); };

  const uploadImage = async (file) => {
    try { return (await api.upload(`/wiki/pages/${id}/files`, file)).file.url; } catch (x) { window.alert(x.message); return null; }
  };
  const trash = async () => {
    if (!window.confirm(`Placer « ${page.title} » et ses sous-pages dans la corbeille ?`)) return;
    try { await api.del(`/wiki/pages/${id}`); navigate(page.parentId ? `/wiki/${page.parentId}` : `/w/${page.workspaceId}/wiki`); } catch (x) { setError(x); }
  };
  const restore = async () => { try { await api.post(`/wiki/pages/${id}/restore`); load(); } catch (x) { setError(x); } };

  if (!page) return error ? <div className="p-6"><ErrorBox error={error} /></div> : <Loading />;
  const canEdit = page.myRole !== 'VIEWER' && !page.deletedAt;

  return (
    <WikiShell workspaceId={page.workspaceId} currentId={page.id} ancestorIds={page.breadcrumb.map((b) => b.id)} onEvent={onEvent}>
      {({ tree, reloadTree }) => (
        <article className="max-w-4xl mx-auto px-6 py-6">
          <nav aria-label="Fil d'Ariane" className="text-xs text-gray-500 mb-3 flex flex-wrap gap-1">
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
          {notice && !conflict && <div role="status" className="mb-4 p-3 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-sm">{notice}</div>}

          <header className="flex flex-wrap items-start justify-between gap-3 mb-4">
            {editing
              ? <input className="flex-1 min-w-0 text-3xl font-bold bg-transparent border-b border-dashed border-gray-300 dark:border-slate-600 focus:outline-none text-gray-900 dark:text-white" aria-label="Titre de la page"
                  value={draft.title} maxLength={200} onChange={(e) => { setDraft((d) => ({ ...d, title: e.target.value })); setDirty(true); }} />
              : <h1 className="flex-1 min-w-0 text-3xl font-bold text-gray-900 dark:text-white break-words">{page.icon ? `${page.icon} ` : ''}{page.title}</h1>}
            <div className="flex flex-wrap gap-1">
              {editing ? <>
                <button type="button" className={btnPrimary} onClick={() => save()} disabled={saving}><Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}</button>
                <button type="button" className={btnGhost} onClick={cancel}><X size={16} /> Annuler</button>
              </> : <>
                {canEdit && <button type="button" className={btnPrimary} onClick={() => startEdit()}><Pencil size={16} /> Modifier</button>}
                <button type="button" className={btnGhost} onClick={() => setModal('history')}><History size={16} /> Historique</button>
                <a className={btnGhost} href={`/api/wiki/pages/${page.id}/export.md`}><Download size={16} /> Markdown</a>
                {canEdit && <button type="button" className={btnGhost} onClick={() => setModal('move')}><FolderInput size={16} /> Déplacer</button>}
                {canEdit && <button type="button" className={btnDanger} onClick={trash} aria-label="Placer dans la corbeille"><Trash2 size={16} /></button>}
              </>}
            </div>
          </header>
          <p className="text-xs text-gray-500 mb-6">
            Modifiée le {fmt(page.updatedAt)}{page.updatedBy ? ` par ${page.updatedBy.displayName}` : ''} · version {page.version}
          </p>

          <WikiEditor
            content={editing ? draft.content : page.content}
            editable={editing}
            onChange={(c) => { setDraft((d) => ({ ...d, content: c })); setDirty(true); }}
            onUploadImage={uploadImage}
            onNavigate={(href) => navigate(href)}
          />

          {!editing && page.children.length > 0 && (
            <section className="mt-10">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Sous-pages</h2>
              <ul className="grid sm:grid-cols-2 gap-2">
                {page.children.map((c) => (
                  <li key={c.id}><Link to={`/wiki/${c.id}`} className={`${card} flex items-center gap-2 px-3 py-2 text-sm hover:shadow-sm text-gray-800 dark:text-gray-200`}><FileText size={14} className="text-gray-400" /> {c.icon ? `${c.icon} ` : ''}{c.title}</Link></li>
                ))}
              </ul>
            </section>
          )}

          {modal === 'history' && <HistoryModal page={page} canEdit={canEdit} onClose={() => setModal(null)} onRestored={(p) => { setPage((x) => ({ ...x, ...p })); setModal(null); }} />}
          {modal === 'move' && tree && <MoveModal page={page} pages={tree.pages} onClose={() => setModal(null)} onMoved={() => { setModal(null); reloadTree(); load(); }} />}
        </article>
      )}
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
