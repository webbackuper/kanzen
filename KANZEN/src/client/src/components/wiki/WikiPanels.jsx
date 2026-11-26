// Panneaux et fenêtres du wiki : nouvelle page (modèles, import), icône, sommaire, historique avec comparaison,
// accès restreint, rétroliens, tâches liées.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileText, FileUp, GitCompare, Link2, Lock, Plus, RotateCcw, Search, SquareKanban, Unlink } from 'lucide-react';
import { api } from '../../api';
import { ErrorBox, Loading, Modal, ROLE_LABEL, btnGhost, btnPrimary, card, input, useApi } from '../../ui';
import { WikiEditor } from './WikiEditor';
import { TEMPLATES } from './templates';

export const fmt = (d) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

// --- Texte brut d'un document (comparaison de versions) ---
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock', 'tableRow', 'horizontalRule', 'fileAttachment', 'callout', 'detailsSummary', 'image']);
export function docText(doc) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'text') parts.push(n.text);
    else if (n.type === 'hardBreak') parts.push('\n');
    else if (n.type === 'image') parts.push(`[image ${n.attrs?.alt ?? ''}]`);
    else if (n.type === 'fileAttachment') parts.push(`[fichier ${n.attrs?.filename ?? ''}]`);
    else if (n.type === 'horizontalRule') parts.push('———');
    else if (n.type === 'taskItem') parts.push(n.attrs?.checked ? '☑ ' : '☐ ');
    for (const c of n.content ?? []) walk(c);
    if (n.type === 'tableCell' || n.type === 'tableHeader') parts.push(' | ');
    else if (BLOCKS.has(n.type)) parts.push('\n');
  };
  walk(doc);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** Titres du document, dans l'ordre d'affichage (index = rang parmi tous les titres rendus). */
export function docHeadings(doc) {
  const out = [];
  const walk = (n) => {
    if (n.type === 'heading') out.push({ index: out.length, level: n.attrs?.level ?? 1, text: (n.content ?? []).map((c) => c.text ?? '').join('').trim() });
    for (const c of n.content ?? []) walk(c);
  };
  if (doc) walk(doc);
  return out;
}

// --- Sommaire ---
export function Toc({ headings, containerRef, compact }) {
  const shown = headings.filter((h) => h.level <= 3 && h.text);
  if (shown.length < 2) return null;
  const go = (h) => {
    const el = containerRef.current?.querySelectorAll('.kz-prose h1, .kz-prose h2, .kz-prose h3, .kz-prose h4')[h.index];
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const min = Math.min(...shown.map((h) => h.level));
  const list = (
    <ul className="space-y-1 text-sm">
      {shown.map((h) => (
        <li key={h.index} style={{ paddingLeft: (h.level - min) * 12 }}>
          <button type="button" onClick={() => go(h)} className="text-left text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-300 leading-snug">{h.text}</button>
        </li>
      ))}
    </ul>
  );
  if (compact) {
    return (
      <details className={`${card} p-3 mb-6 xl:hidden kz-noprint`}>
        <summary className="cursor-pointer text-sm font-semibold text-gray-700 dark:text-gray-300">Sommaire</summary>
        <div className="mt-2">{list}</div>
      </details>
    );
  }
  return (
    <nav aria-label="Sommaire" className="kz-noprint">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Sommaire</h2>
      {list}
    </nav>
  );
}

// --- Choix d'une icône ---
const EMOJIS = ['📄', '📘', '📙', '📗', '📕', '📁', '🗂️', '📌', '⭐', '✅', '⚠️', '⛔', '💡', '🔧', '🛠️', '⚙️', '🖥️', '💾', '🗄️', '🌐', '🔒', '🔑', '🛡️', '🧯', '🚀', '📦', '🐧', '🪟', '🐘', '☁️', '📊', '📈', '🗓️', '📝', '👥', '🎓', '🏷️', '🔍', '🧪', '🧭'];
export function IconPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} title="Icône de la page" aria-label="Choisir l'icône de la page"
        className="text-3xl w-12 h-12 rounded-lg border border-dashed border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-800 flex items-center justify-center">
        {value || <span className="text-base text-gray-500 dark:text-gray-400">+ 🙂</span>}
      </button>
      {open && (
        <div className="absolute z-30 left-0 top-14 w-72 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-2">
          <div className="grid grid-cols-8 gap-1">
            {EMOJIS.map((e) => (
              <button key={e} type="button" onClick={() => { onChange(e); setOpen(false); }} className="text-xl rounded hover:bg-gray-100 dark:hover:bg-slate-800 p-0.5" aria-label={`Icône ${e}`}>{e}</button>
            ))}
          </div>
          <form className="flex gap-1 mt-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { onChange([...custom.trim()].slice(0, 2).join('')); setOpen(false); setCustom(''); } }}>
            <input className={`${input} py-1`} placeholder="Autre emoji" value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={8} aria-label="Autre emoji" />
            <button className={btnGhost}>OK</button>
          </form>
          {value && <button type="button" className={`${btnGhost} mt-1 w-full justify-center`} onClick={() => { onChange(null); setOpen(false); }}>Retirer l&apos;icône</button>}
        </div>
      )}
    </span>
  );
}

// --- Nouvelle page : modèle ou import Markdown ---
export function NewPageModal({ workspaceId, parentId, parentTitle, onClose, onCreated }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const create = async (tpl) => {
    setBusy(true);
    try {
      const { page } = await api.post(`/workspaces/${workspaceId}/wiki`, {
        title: tpl.id === 'blank' ? 'Sans titre' : tpl.title, icon: tpl.id === 'blank' ? null : tpl.icon, parentId: parentId ?? null,
        ...(tpl.content ? { content: tpl.content } : {}),
      });
      onCreated(page, { edit: true });
    } catch (x) { setErr(x); setBusy(false); }
  };
  const importFiles = async (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      const { markdownToPage } = await import('./markdownImport'); // marked chargé à la demande
      let first = null;
      for (const f of files) {
        if (f.size > 1.5 * 1024 * 1024) throw new Error(`« ${f.name} » dépasse 1,5 Mo`);
        const { title, content } = markdownToPage(await f.text(), f.name.replace(/\.(md|markdown|txt)$/i, ''));
        const { page } = await api.post(`/workspaces/${workspaceId}/wiki`, { title, parentId: parentId ?? null, content });
        first ??= page;
      }
      onCreated(first, { edit: false, count: files.length });
    } catch (x) { setErr(x); setBusy(false); }
  };
  return (
    <Modal title={parentTitle ? `Nouvelle sous-page de « ${parentTitle} »` : 'Nouvelle page'} wide onClose={onClose}>
      <ErrorBox error={err} />
      <div className="grid sm:grid-cols-2 gap-2">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" disabled={busy} onClick={() => create(t)}
            className={`${card} text-left p-3 hover:border-indigo-400 hover:shadow-sm disabled:opacity-50 flex gap-3`}>
            <span className="text-2xl" aria-hidden="true">{t.icon}</span>
            <span><span className="block font-medium text-gray-900 dark:text-white text-sm">{t.title}</span><span className="block text-xs text-gray-500">{t.description}</span></span>
          </button>
        ))}
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
          className={`${card} text-left p-3 border-dashed hover:border-indigo-400 disabled:opacity-50 flex gap-3`}>
          <FileUp size={24} className="text-gray-500 dark:text-gray-400 shrink-0" />
          <span><span className="block font-medium text-gray-900 dark:text-white text-sm">Importer du Markdown</span><span className="block text-xs text-gray-500">Un ou plusieurs fichiers .md : une page par fichier.</span></span>
        </button>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple className="hidden" onChange={importFiles} aria-label="Fichiers Markdown à importer" />
      </div>
    </Modal>
  );
}

// --- Historique, avec comparaison de versions ---
function DiffView({ before, after }) {
  const [parts, setParts] = useState(null);
  useEffect(() => {
    let alive = true;
    import('diff').then((m) => alive && setParts(m.diffWordsWithSpace(before, after))); // chargé à la demande
    return () => { alive = false; };
  }, [before, after]);
  if (!parts) return <Loading />;
  if (!parts.some((p) => p.added || p.removed)) return <p className="text-sm text-gray-500">Aucune différence de texte.</p>;
  return (
    <div className="text-sm whitespace-pre-wrap leading-relaxed text-gray-800 dark:text-gray-200">
      {parts.map((p, i) => (p.added
        ? <ins key={i} className="bg-green-100 dark:bg-green-900/50 text-green-900 dark:text-green-100 no-underline rounded px-0.5">{p.value}</ins>
        : p.removed
          ? <del key={i} className="bg-red-100 dark:bg-red-900/50 text-red-900 dark:text-red-100 rounded px-0.5">{p.value}</del>
          : <span key={i}>{p.value}</span>))}
    </div>
  );
}

export function HistoryModal({ page, canEdit, onClose, onRestored }) {
  const { data, error } = useApi(() => api.get(`/wiki/pages/${page.id}/revisions`), [page.id]);
  const [preview, setPreview] = useState(null);
  const [compare, setCompare] = useState('none'); // none | current | previous
  const [previous, setPrevious] = useState(null);
  const [err, setErr] = useState(null);
  const show = async (r) => {
    try {
      setPreview((await api.get(`/wiki/revisions/${r.id}`)).revision);
      const idx = data.revisions.findIndex((x) => x.id === r.id);
      const prev = data.revisions[idx + 1];
      setPrevious(prev ? (await api.get(`/wiki/revisions/${prev.id}`)).revision : null);
    } catch (x) { setErr(x); }
  };
  const restore = async () => {
    if (!window.confirm(`Restaurer la version ${preview.version} ? La version actuelle reste disponible dans l'historique.`)) return;
    try { const r = await api.post(`/wiki/revisions/${preview.id}/restore`, { version: page.version }); onRestored(r.page); } catch (x) { setErr(x); }
  };
  const base = compare === 'current' ? { title: page.title, content: page.content } : compare === 'previous' ? previous : null;
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
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">{preview.title}</h3>
              <label className="text-xs text-gray-500 flex items-center gap-1"><GitCompare size={14} />
                <select className="text-xs rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 dark:text-gray-200 px-1 py-0.5" value={compare} onChange={(e) => setCompare(e.target.value)} aria-label="Comparer">
                  <option value="none">Aperçu</option>
                  <option value="previous" disabled={!previous}>Comparer à la version précédente</option>
                  <option value="current" disabled={preview.version === page.version}>Comparer à la version actuelle</option>
                </select>
              </label>
            </div>
            {base ? (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  {compare === 'current' ? <>Du texte de la version {preview.version} vers la version actuelle : </> : <>De la version {previous.version} vers la version {preview.version} : </>}
                  <ins className="bg-green-100 dark:bg-green-900/50 no-underline px-1 rounded">ajouts</ins> <del className="bg-red-100 dark:bg-red-900/50 px-1 rounded">suppressions</del>
                </p>
                {base.title !== preview.title && <p className="text-sm mb-2">Titre : <del className="bg-red-100 dark:bg-red-900/50 px-1 rounded">{compare === 'current' ? preview.title : base.title}</del> → <ins className="bg-green-100 dark:bg-green-900/50 no-underline px-1 rounded">{compare === 'current' ? base.title : preview.title}</ins></p>}
                {compare === 'current'
                  ? <DiffView before={docText(preview.content)} after={docText(base.content)} />
                  : <DiffView before={docText(base.content)} after={docText(preview.content)} />}
              </>
            ) : <WikiEditor key={preview.id} content={preview.content} />}
          </>}
        </div>
      </div>
      {preview && canEdit && preview.version !== page.version && (
        <div className="mt-4 flex justify-end"><button type="button" className={btnPrimary} onClick={restore}><RotateCcw size={16} /> Restaurer cette version</button></div>
      )}
    </Modal>
  );
}

// --- Accès restreint ---
export function AccessModal({ page, onClose, onSaved }) {
  const { data, error } = useApi(async () => {
    const [access, ws] = await Promise.all([api.get(`/wiki/pages/${page.id}/access`), api.get(`/workspaces/${page.workspaceId}`)]);
    return { access, members: ws.workspace.members };
  }, [page.id]);
  const [restricted, setRestricted] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!data) return;
    setRestricted(data.access.restricted);
    setSelected(new Set(data.access.members.map((m) => m.id)));
  }, [data]);
  if (!data) return <Modal title="Accès à la page" onClose={onClose}>{error ? <ErrorBox error={error} /> : <Loading />}</Modal>;
  const { access, members } = data;
  const ro = !access.canManage;
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = async (e) => {
    e.preventDefault();
    try { await api.put(`/wiki/pages/${page.id}/access`, { restricted, userIds: restricted ? [...selected] : [] }); onSaved(); } catch (x) { setErr(x); }
  };
  return (
    <Modal title={`Accès : ${page.title}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <ErrorBox error={err} />
        {access.inherited.length > 0 && (
          <p className="text-xs p-2 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200">
            Déjà restreinte par la section {access.inherited.map((p) => `« ${p.title} »`).join(', ')} : les deux restrictions s&apos;appliquent.
          </p>
        )}
        <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input type="checkbox" className="mt-1" checked={restricted} disabled={ro} onChange={(e) => setRestricted(e.target.checked)} />
          <span><strong>Accès restreint</strong><span className="block text-xs text-gray-500">La page et ses sous-pages ne sont visibles que des personnes cochées ci-dessous et des propriétaires de l&apos;espace.</span></span>
        </label>
        {restricted && (
          <ul className={`${card} divide-y divide-gray-100 dark:divide-slate-800 max-h-72 overflow-y-auto`}>
            {members.map((m) => {
              const always = m.role === 'OWNER';
              return (
                <li key={m.id}>
                  <label className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-800 dark:text-gray-200">
                    <span className="flex items-center gap-2">
                      <input type="checkbox" checked={always || selected.has(m.id)} disabled={ro || always} onChange={() => toggle(m.id)} />
                      {m.displayName}
                    </span>
                    <span className="text-xs text-gray-500">{always ? 'Propriétaire : accès toujours' : ROLE_LABEL[m.role]}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {ro ? <p className="text-xs text-gray-500">Seuls les propriétaires de l&apos;espace peuvent modifier les accès.</p>
          : <div className="flex justify-end"><button className={btnPrimary}><Lock size={16} /> Enregistrer</button></div>}
      </form>
    </Modal>
  );
}

// --- Rétroliens ---
export function Backlinks({ pageId, refreshKey }) {
  const { data } = useApi(() => api.get(`/wiki/pages/${pageId}/backlinks`), [pageId, refreshKey]);
  if (!data?.pages.length) return null;
  return (
    <section className="mt-8 kz-noprint">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-1"><Link2 size={14} /> Pages qui pointent ici</h2>
      <ul className="flex flex-wrap gap-2">
        {data.pages.map((p) => (
          <li key={p.id}><Link to={`/wiki/${p.id}`} className={`${card} inline-flex items-center gap-1.5 px-3 py-1.5 text-sm hover:shadow-sm text-gray-800 dark:text-gray-200`}>
            {p.icon ? <span>{p.icon}</span> : <FileText size={14} className="text-gray-500 dark:text-gray-400" />} {p.title}
          </Link></li>
        ))}
      </ul>
    </section>
  );
}

// --- Tâches liées (Kanban) ---
function TaskPicker({ workspaceId, exclude, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const { data, error } = useApi(() => api.get(`/workspaces/${workspaceId}/tasks?q=${encodeURIComponent(query)}`), [workspaceId, query]);
  return (
    <Modal title="Lier une tâche" onClose={onClose}>
      <label className="relative block mb-3">
        <Search size={14} className="absolute left-2.5 top-3 text-gray-500 dark:text-gray-400" />
        <input className={`${input} pl-8`} placeholder="Rechercher une tâche par son titre" value={q} onChange={(e) => setQ(e.target.value)} autoFocus maxLength={200} aria-label="Rechercher une tâche" />
      </label>
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <ul className="divide-y divide-gray-100 dark:divide-slate-800 max-h-80 overflow-y-auto">
          {data.tasks.filter((t) => !exclude.has(t.id)).map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onPick(t)} className="w-full text-left px-2 py-2 hover:bg-gray-50 dark:hover:bg-slate-800 rounded">
                <span className="block text-sm text-gray-900 dark:text-gray-100">{t.title}</span>
                <span className="block text-xs text-gray-500">{t.board.title} · {t.column}</span>
              </button>
            </li>
          ))}
          {data.tasks.length === 0 && <li className="text-sm text-gray-500 p-2">Aucune tâche trouvée.</li>}
        </ul>
      )}
    </Modal>
  );
}

export function TaskLinks({ page, canEdit, refreshKey }) {
  const { data, error, reload } = useApi(() => api.get(`/wiki/pages/${page.id}/tasks`), [page.id, refreshKey]);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState(null);
  const navigate = useNavigate();
  if (!data) return error ? <ErrorBox error={error} /> : null;
  if (!data.tasks.length && !canEdit) return null;
  const link = async (t) => { try { setErr(null); await api.post(`/wiki/pages/${page.id}/tasks`, { taskId: t.id }); setPicking(false); reload(); } catch (x) { setErr(x); } };
  const unlink = async (t) => { try { setErr(null); await api.del(`/wiki/pages/${page.id}/tasks/${t.id}`); reload(); } catch (x) { setErr(x); } };
  return (
    <section className="mt-8 kz-noprint">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1"><SquareKanban size={14} /> Tâches liées</h2>
        {canEdit && <button type="button" className={btnGhost} onClick={() => setPicking(true)}><Plus size={14} /> Lier une tâche</button>}
      </div>
      <ErrorBox error={err} />
      {data.tasks.length === 0 ? <p className="text-sm text-gray-500">Aucune tâche liée. Les tâches liées affichent aussi cette page dans leur fiche.</p> : (
        <ul className="grid sm:grid-cols-2 gap-2">
          {data.tasks.map((t) => (
            <li key={t.id} className={`${card} flex items-start justify-between gap-2 px-3 py-2`}>
              <button type="button" className="text-left min-w-0" onClick={() => navigate(`/b/${t.board.id}?task=${t.id}`)}>
                <span className="block text-sm text-gray-900 dark:text-gray-100 truncate hover:underline">{t.title}</span>
                <span className="block text-xs text-gray-500 truncate">{t.board.title} · {t.column}{t.assignees.length ? ` · ${t.assignees.map((a) => a.displayName).join(', ')}` : ''}</span>
              </button>
              {canEdit && <button type="button" onClick={() => unlink(t)} className="text-gray-500 dark:text-gray-400 hover:text-red-600 p-1" title="Retirer le lien" aria-label={`Retirer le lien avec ${t.title}`}><Unlink size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      {picking && <TaskPicker workspaceId={page.workspaceId} exclude={new Set(data.tasks.map((t) => t.id))} onPick={link} onClose={() => setPicking(false)} />}
    </section>
  );
}

/** Présence des co-éditeurs */
export function Peers({ peers }) {
  if (!peers.length) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-gray-500" aria-label={`Également en édition : ${peers.map((p) => p.name).join(', ')}`}>
      <span className="flex -space-x-1.5">
        {peers.slice(0, 5).map((p) => (
          <span key={p.clientId} title={p.name} className="w-6 h-6 rounded-full ring-2 ring-white dark:ring-slate-900 text-white text-[10px] font-bold flex items-center justify-center" style={{ background: p.color }}>
            {(p.name.match(/[\p{L}\p{N}]+/gu) ?? ['?']).map((x) => x[0]).slice(0, 2).join('').toUpperCase()}
          </span>
        ))}
      </span>
      <span className="hidden sm:inline">{peers.length === 1 ? `${peers[0].name} modifie aussi` : `${peers.length} autres personnes modifient`}</span>
    </span>
  );
}

