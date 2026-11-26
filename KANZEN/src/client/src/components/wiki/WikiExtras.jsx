// Wiki : commentaires de page, page vérifiée, modèles d'équipe, pages à revoir.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, CheckCircle2, CircleAlert, MessageSquare, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { ErrorBox, Loading, Modal, btnGhost, btnPrimary, card, input, useApi } from '../../ui';
import { fmt } from './WikiPanels';

const fmtDate = (d) => new Date(d).toLocaleDateString('fr-FR', { dateStyle: 'medium' });

// ---------------------------------------------------------------------------
// Commentaires
// ---------------------------------------------------------------------------
function CommentBody({ c, user, role, canComment, onChanged, onError, children }) {
  const [editing, setEditing] = useState(null);
  const mine = c.author?.id === user?.id;
  const run = (fn) => async (e) => { e?.preventDefault?.(); try { await fn(); onChanged(); } catch (x) { onError(x); } };
  return (
    <div>
      <div className="text-xs text-gray-500 flex flex-wrap justify-between gap-2">
        <span><strong className="text-gray-800 dark:text-gray-200 font-medium">{c.author?.displayName ?? 'Utilisateur supprimé'}</strong> · {fmt(c.createdAt)}{c.editedAt ? ' · modifié' : ''}</span>
        <span className="flex gap-2 kz-noprint">
          {children}
          {mine && canComment && <button type="button" className="hover:text-indigo-600" onClick={() => setEditing(c.content)} aria-label="Modifier le commentaire"><Pencil size={12} /></button>}
          {(mine || role === 'OWNER') && <button type="button" className="hover:text-red-600" onClick={run(async () => { if (window.confirm('Supprimer ce commentaire (et ses réponses) ?')) await api.del(`/wiki/comments/${c.id}`); })} aria-label="Supprimer le commentaire"><Trash2 size={12} /></button>}
        </span>
      </div>
      {editing !== null ? (
        <form className="mt-1 space-y-2" onSubmit={run(async () => { await api.patch(`/wiki/comments/${c.id}`, { content: editing }); setEditing(null); })}>
          <textarea className={input} value={editing} onChange={(e) => setEditing(e.target.value)} required maxLength={5000} aria-label="Commentaire" autoFocus />
          <div className="flex gap-2"><button className={btnPrimary}>Enregistrer</button><button type="button" className={btnGhost} onClick={() => setEditing(null)}>Annuler</button></div>
        </form>
      ) : <p className="mt-0.5 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">{c.content}</p>}
    </div>
  );
}

function Thread({ t, user, role, canComment, pageId, onChanged, onError }) {
  const [reply, setReply] = useState(null);
  const resolved = Boolean(t.resolvedAt);
  const run = (fn) => async (e) => { e?.preventDefault?.(); try { await fn(); onChanged(); } catch (x) { onError(x); } };
  return (
    <li className={`${card} p-3 ${resolved ? 'opacity-75' : ''}`}>
      <CommentBody c={t} user={user} role={role} canComment={canComment} onChanged={onChanged} onError={onError}>
        {canComment && (resolved
          ? <button type="button" className="hover:text-indigo-600 inline-flex items-center gap-0.5" onClick={run(() => api.post(`/wiki/comments/${t.id}/resolve`, { resolved: false }))}><RotateCcw size={12} /> Rouvrir</button>
          : <button type="button" className="hover:text-green-700 inline-flex items-center gap-0.5" onClick={run(() => api.post(`/wiki/comments/${t.id}/resolve`, { resolved: true }))}><CheckCircle2 size={12} /> Résoudre</button>)}
      </CommentBody>
      {resolved && <p className="text-xs text-green-700 dark:text-green-400 mt-1">Résolu par {t.resolvedBy?.displayName ?? '—'} le {fmt(t.resolvedAt)}</p>}
      {t.replies.length > 0 && (
        <ul className="mt-2 ml-4 pl-3 border-l-2 border-gray-200 dark:border-slate-700 space-y-2">
          {t.replies.map((r) => <li key={r.id}><CommentBody c={r} user={user} role={role} canComment={canComment} onChanged={onChanged} onError={onError} /></li>)}
        </ul>
      )}
      {canComment && (reply === null
        ? <button type="button" className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline kz-noprint" onClick={() => setReply('')}>Répondre</button>
        : (
          <form className="mt-2 ml-4 space-y-2" onSubmit={run(async () => { await api.post(`/wiki/pages/${pageId}/comments`, { content: reply, parentId: t.id }); setReply(null); })}>
            <textarea className={input} value={reply} onChange={(e) => setReply(e.target.value)} required maxLength={5000} placeholder="Votre réponse" aria-label="Réponse" autoFocus />
            <div className="flex gap-2"><button className={btnPrimary}>Répondre</button><button type="button" className={btnGhost} onClick={() => setReply(null)}>Annuler</button></div>
          </form>
        ))}
    </li>
  );
}

/** Discussion en pied de page (à la Outline / Confluence). */
export function PageComments({ page, user, refreshKey }) {
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const load = () => api.get(`/wiki/pages/${page.id}/comments`).then((r) => { setThreads(r.threads); setError(null); }, setError);
  useEffect(() => { load(); }, [page.id, refreshKey]);
  const canComment = page.myRole !== 'VIEWER' && !page.deletedAt;
  const open = (threads ?? []).filter((t) => !t.resolvedAt);
  const resolved = (threads ?? []).filter((t) => t.resolvedAt);
  const add = async (e) => {
    e.preventDefault();
    try { await api.post(`/wiki/pages/${page.id}/comments`, { content: text }); setText(''); load(); } catch (x) { setError(x); }
  };
  return (
    <section className="mt-10" aria-labelledby="kz-comments">
      <h2 id="kz-comments" className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center gap-1">
        <MessageSquare size={14} /> Commentaires {threads && `(${open.length})`}
      </h2>
      <ErrorBox error={error} />
      {!threads ? (!error && <Loading />) : (
        <>
          {open.length === 0 && <p className="text-sm text-gray-500 mb-2">Aucune discussion en cours{canComment ? ' : signalez une étape obsolète, posez une question…' : '.'}</p>}
          <ul className="space-y-2">
            {open.map((t) => <Thread key={t.id} t={t} user={user} role={page.myRole} canComment={canComment} pageId={page.id} onChanged={load} onError={setError} />)}
          </ul>
          {resolved.length > 0 && (
            <button type="button" className="mt-2 text-xs text-gray-600 dark:text-gray-400 hover:underline kz-noprint" onClick={() => setShowResolved((v) => !v)} aria-expanded={showResolved}>
              {showResolved ? 'Masquer' : 'Afficher'} les {resolved.length} discussion(s) résolue(s)
            </button>
          )}
          {showResolved && (
            <ul className="space-y-2 mt-2">
              {resolved.map((t) => <Thread key={t.id} t={t} user={user} role={page.myRole} canComment={canComment} pageId={page.id} onChanged={load} onError={setError} />)}
            </ul>
          )}
          {canComment && (
            <form onSubmit={add} className="mt-3 space-y-2 kz-noprint">
              <textarea className={input} value={text} onChange={(e) => setText(e.target.value)} required maxLength={5000} placeholder="Ajouter un commentaire" aria-label="Nouveau commentaire" />
              <button className={btnGhost}><MessageSquare size={14} /> Commenter</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page vérifiée
// ---------------------------------------------------------------------------
export const REVIEW_PERIODS = [[30, '1 mois'], [90, '3 mois'], [180, '6 mois'], [365, '1 an']];

/** Badge affiché sous le titre de la page. */
export function VerificationBadge({ verification: v, onClick }) {
  if (!v || v.status === 'none') return null;
  const ok = v.status === 'verified';
  const text = ok
    ? `Vérifiée le ${fmtDate(v.verifiedAt)}${v.verifiedBy ? ` par ${v.verifiedBy.displayName}` : ''}`
    : v.verifiedAt ? `À revoir : dernière vérification le ${fmtDate(v.verifiedAt)}` : 'À revoir : jamais vérifiée';
  return (
    <button type="button" onClick={onClick} title={v.owner ? `Propriétaire : ${v.owner.displayName}` : undefined}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${ok
        ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200'
        : 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200'}`}>
      {ok ? <BadgeCheck size={11} /> : <CircleAlert size={11} />} {text}
    </button>
  );
}

/** Réglages : propriétaire, périodicité, vérification. */
export function VerificationModal({ page, onClose, onChanged }) {
  const v = page.verification;
  const canEdit = page.myRole !== 'VIEWER' && !page.deletedAt;
  const { data: ws } = useApi(() => api.get(`/workspaces/${page.workspaceId}`), [page.workspaceId]);
  const [ownerId, setOwnerId] = useState(v.owner?.id ?? '');
  const [period, setPeriod] = useState(v.reviewEveryDays ?? '');
  const [error, setError] = useState(null);
  const run = (fn) => async (e) => { e?.preventDefault?.(); try { setError(null); await fn(); onChanged(); } catch (x) { setError(x); } };
  const saveSettings = run(() => api.put(`/wiki/pages/${page.id}/verification`, { ownerId: ownerId || null, reviewEveryDays: period ? Number(period) : null }));
  return (
    <Modal title="Vérification de la page" onClose={onClose}>
      <ErrorBox error={error} />
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Une page vérifiée affiche qui garantit son contenu et quand. Avec une périodicité de revue, elle repasse « à revoir » à l&apos;échéance
        et apparaît dans la liste « À revoir » de l&apos;accueil du wiki.
      </p>
      <div className="mb-4 text-sm">
        {v.status === 'verified' && <p className="text-green-700 dark:text-green-400 flex items-center gap-1"><BadgeCheck size={16} /> Vérifiée le {fmtDate(v.verifiedAt)}{v.verifiedBy ? ` par ${v.verifiedBy.displayName}` : ''}{v.dueAt ? `, prochaine revue avant le ${fmtDate(v.dueAt)}` : ''}.</p>}
        {v.status === 'expired' && <p className="text-orange-700 dark:text-orange-300 flex items-center gap-1"><CircleAlert size={16} /> À revoir{v.verifiedAt ? ` depuis le ${fmtDate(v.dueAt ?? v.verifiedAt)}` : ' : jamais vérifiée'}.</p>}
        {v.status === 'none' && <p className="text-gray-500">Page non vérifiée.</p>}
      </div>
      {canEdit ? (
        <>
          <form onSubmit={saveSettings} className="space-y-3">
            <label className="block text-xs text-gray-500">Propriétaire (garant du contenu)
              <select className={input} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Aucun</option>
                {(ws?.workspace.members ?? []).map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-500">Revue périodique
              <select className={input} value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="">Aucune</option>
                {REVIEW_PERIODS.map(([d, l]) => <option key={d} value={d}>Tous les {l}</option>)}
              </select>
            </label>
            <button className={btnGhost}>Enregistrer les réglages</button>
          </form>
          <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
            <button type="button" className={btnPrimary} onClick={run(() => api.post(`/wiki/pages/${page.id}/verify`))}><BadgeCheck size={16} /> Je confirme que la page est à jour</button>
            {v.verifiedAt && <button type="button" className={btnGhost} onClick={run(() => api.del(`/wiki/pages/${page.id}/verify`))}>Retirer la vérification</button>}
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-500">{v.owner ? `Propriétaire : ${v.owner.displayName}.` : 'Aucun propriétaire désigné.'}</p>
      )}
    </Modal>
  );
}

/** Pages à revoir et pages dont je suis propriétaire (accueil du wiki). */
export function ReviewLists({ workspaceId, refreshKey }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/workspaces/${workspaceId}/wiki/review`).then(setData, () => setData(null)); }, [workspaceId, refreshKey]);
  if (!data || (!data.expired.length && !data.mine.length)) return null;
  const item = (p) => (
    <li key={p.id}><Link to={`/wiki/${p.id}`} className="flex justify-between gap-4 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800/60">
      <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{p.icon ? `${p.icon} ` : ''}{p.title}</span>
      <span className={`text-xs shrink-0 ${p.status === 'expired' ? 'text-orange-700 dark:text-orange-300' : 'text-gray-500'}`}>
        {p.status === 'expired' ? (p.verifiedAt ? `vérifiée le ${fmtDate(p.verifiedAt)}` : 'jamais vérifiée') : p.status === 'verified' ? 'à jour' : 'non vérifiée'}
        {p.owner ? ` · ${p.owner.displayName}` : ''}
      </span>
    </Link></li>
  );
  return (
    <>
      {data.expired.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300 flex items-center gap-1"><CircleAlert size={14} /> À revoir ({data.expired.length})</h2>
          <ul className={`${card} divide-y divide-gray-100 dark:divide-slate-800`}>{data.expired.slice(0, 15).map(item)}</ul>
        </>
      )}
      {data.mine.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1"><BadgeCheck size={14} /> Pages dont je suis propriétaire</h2>
          <ul className={`${card} divide-y divide-gray-100 dark:divide-slate-800`}>{data.mine.slice(0, 15).map(item)}</ul>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modèles d'équipe
// ---------------------------------------------------------------------------
export function SaveTemplateModal({ page, onClose }) {
  const [title, setTitle] = useState(page.title);
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/workspaces/${page.workspaceId}/wiki/templates`, { title, description, icon: page.icon ?? null, pageId: page.id });
      setDone(true);
    } catch (x) { setError(x); }
  };
  return (
    <Modal title="Enregistrer comme modèle" onClose={onClose}>
      <ErrorBox error={error} />
      {done ? (
        <>
          <p className="text-sm text-gray-700 dark:text-gray-200 mb-4">Modèle « {title} » enregistré. Il est proposé à tous les membres de l&apos;espace à la création d&apos;une page.</p>
          <button type="button" className={btnPrimary} onClick={onClose}>Fermer</button>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-gray-500">Nom du modèle<input className={input} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
          <label className="block text-xs text-gray-500">Description<input className={input} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="À quoi sert ce modèle" /></label>
          <p className="text-xs text-gray-500">Le contenu actuel de la page est repris, sans les images ni les fichiers joints.</p>
          <button className={btnPrimary}>Enregistrer</button>
        </form>
      )}
    </Modal>
  );
}
