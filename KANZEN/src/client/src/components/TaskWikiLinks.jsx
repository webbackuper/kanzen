// Fiche tâche : pages du wiki liées (lien dans les deux sens avec le panneau « Tâches liées » du wiki).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Plus, Unlink } from 'lucide-react';
import { api } from '../api';
import { ErrorBox, btnGhost, input, useApi } from '../ui';

export function TaskWikiLinks({ taskId, workspaceId }) {
  const { data, error, reload } = useApi(() => api.get(`/tasks/${taskId}/wiki-pages`), [taskId]);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!picking || pages) return;
    api.get(`/workspaces/${workspaceId}/wiki`).then((t) => setPages(t.pages), setErr);
  }, [picking, pages, workspaceId]);
  const linked = useMemo(() => new Set((data?.pages ?? []).map((p) => p.id)), [data]);
  const results = useMemo(() => {
    const n = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return (pages ?? []).filter((p) => !linked.has(p.id) && (!q.trim() || n(p.title).includes(n(q.trim())))).slice(0, 8);
  }, [pages, q, linked]);

  if (!data) return error ? <ErrorBox error={error} /> : null;
  const link = async (p) => { try { setErr(null); await api.post(`/tasks/${taskId}/wiki-pages`, { pageId: p.id }); setPicking(false); setQ(''); reload(); } catch (x) { setErr(x); } };
  const unlink = async (p) => { try { setErr(null); await api.del(`/tasks/${taskId}/wiki-pages/${p.id}`); reload(); } catch (x) { setErr(x); } };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold dark:text-gray-200 flex items-center gap-1"><BookOpen size={14} /> Pages du wiki</h3>
      <ErrorBox error={err} />
      {data.pages.length === 0 && !picking && <p className="text-xs text-gray-500">Aucune page liée.</p>}
      <ul className="space-y-1">
        {data.pages.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-sm dark:text-gray-200">
            <Link to={`/wiki/${p.id}`} className="truncate hover:underline">{p.icon ? `${p.icon} ` : ''}{p.title}</Link>
            {data.canEdit && <button type="button" className="ml-auto text-gray-400 hover:text-red-600" onClick={() => unlink(p)} aria-label={`Retirer le lien avec ${p.title}`} title="Retirer le lien"><Unlink size={12} /></button>}
          </li>
        ))}
      </ul>
      {data.canEdit && (picking ? (
        <div className="space-y-1">
          <input className={`${input} py-1`} placeholder="Titre de la page" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Rechercher une page du wiki" maxLength={200} />
          <ul className="max-h-48 overflow-y-auto">
            {results.map((p) => (
              <li key={p.id}><button type="button" onClick={() => link(p)} className="w-full text-left text-sm px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 dark:text-gray-200 truncate">{p.icon ? `${p.icon} ` : ''}{p.title}</button></li>
            ))}
            {pages && results.length === 0 && <li className="text-xs text-gray-500 px-2">Aucune page trouvée.</li>}
          </ul>
          <button type="button" className={btnGhost} onClick={() => setPicking(false)}>Annuler</button>
        </div>
      ) : <button type="button" className={btnGhost} onClick={() => setPicking(true)}><Plus size={14} /> Lier une page</button>)}
    </section>
  );
}
