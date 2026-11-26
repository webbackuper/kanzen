import { useEffect, useState } from 'react';
import { Archive, ArrowRightLeft, ClipboardCopy, Copy, Download, History, Link2, Paperclip, Pencil, RotateCcw, Tag, Trash2 } from 'lucide-react';
import { api } from '../api';
import { COLORS, initials } from './TaskCard';
import { ErrorBox, Loading, Modal, input, btnPrimary, btnGhost, btnDanger } from '../ui';
import { TaskWikiLinks } from './TaskWikiLinks';
import { LabelChip, LABEL_COLORS, PRIORITIES, describeActivity } from './boardMeta';

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.ceil(n / 1024)} ko`);
const toDay = (d) => d?.slice(0, 10) ?? '';
const toIso = (d) => (d ? new Date(`${d}T12:00:00Z`).toISOString() : null);
const fmtWhen = (d) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

/** Copie dans le presse-papiers ; repli pour les pages servies hors contexte sécurisé. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { return document.execCommand('copy'); } finally { t.remove(); }
  }
}

/** Journal d'activité de la carte (chargé à la demande). */
function ActivityLog({ taskId, refreshKey }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/tasks/${taskId}/activity`).then((r) => setItems(r.activities), setError); }, [taskId, refreshKey]);
  if (error) return <ErrorBox error={error} />;
  if (!items) return <Loading />;
  if (!items.length) return <p className="text-sm text-gray-500">Aucune activité enregistrée.</p>;
  return (
    <ol className="space-y-2">
      {items.map((a) => (
        <li key={a.id} className="text-sm text-gray-700 dark:text-gray-300 flex gap-2">
          <span className="w-6 h-6 shrink-0 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200 flex items-center justify-center text-[9px] font-bold" aria-hidden="true">{initials(a.actor?.displayName ?? '?')}</span>
          <span><strong className="font-medium">{a.actor?.displayName ?? 'Utilisateur supprimé'}</strong> {describeActivity(a)} <span className="text-xs text-gray-500">· {fmtWhen(a.createdAt)}</span></span>
        </li>
      ))}
    </ol>
  );
}

/** Transfert vers un autre tableau de l'espace. */
function TransferModal({ task, boards, onClose, onDone }) {
  const options = boards.filter((b) => b.id !== task.boardId);
  const [boardId, setBoardId] = useState(options[0]?.id ?? '');
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try { await api.post(`/tasks/${task.id}/transfer`, { boardId }); onDone(); } catch (x) { setError(x); }
  };
  return (
    <Modal title="Déplacer vers un autre tableau" onClose={onClose}>
      <ErrorBox error={error} />
      {options.length === 0 ? <p className="text-sm text-gray-500">Aucun autre tableau dans cet espace.</p> : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-gray-500">Tableau cible
            <select className={input} value={boardId} onChange={(e) => setBoardId(e.target.value)}>
              {options.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
          </label>
          <p className="text-xs text-gray-500">La carte arrive dans la première colonne. Ses étiquettes sont reprises par nom (créées si besoin), ses commentaires, pièces jointes et liens wiki la suivent.</p>
          <button className={btnPrimary}>Déplacer</button>
        </form>
      )}
    </Modal>
  );
}

export function TaskDetail({ taskId, workspaceId, user, onClose, onChanged, onOpenTask }) {
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [members, setMembers] = useState([]);
  const [boards, setBoards] = useState([]);
  const [sub, setSub] = useState('');
  const [comment, setComment] = useState('');
  const [editComment, setEditComment] = useState(null); // { id, content }
  const [tab, setTab] = useState('comments');
  const [activityKey, setActivityKey] = useState(0);
  const [transfer, setTransfer] = useState(false);
  const [copied, setCopied] = useState(null);

  // resetForm : uniquement au chargement et après enregistrement. Ajouter un commentaire ou une sous-tâche
  // ne doit pas écraser une modification en cours du formulaire (titre, assignés…).
  const load = ({ resetForm = false } = {}) => api.get(`/tasks/${taskId}`).then(({ task: t }) => {
    setTask(t);
    setActivityKey((k) => k + 1);
    if (resetForm) {
      setForm({
        title: t.title, description: t.description, color: t.color, priority: t.priority,
        dueDate: toDay(t.dueDate), startDate: toDay(t.startDate), assigneeIds: t.assignees.map((u) => u.id), labelIds: t.labelIds,
      });
    }
  }, setError);
  useEffect(() => { load({ resetForm: true }); }, [taskId]); // load dépend uniquement de taskId

  useEffect(() => {
    api.get(`/workspaces/${workspaceId}`).then((r) => { setMembers(r.workspace.members); setBoards(r.workspace.boards); }).catch(() => {});
  }, [workspaceId]);

  const run = (fn, opts) => async (e) => { e?.preventDefault?.(); try { setError(null); await fn(); await load(opts); onChanged(); } catch (x) { setError(x); } };
  if (!task || !form) return <Modal title="Tâche" onClose={onClose}>{error ? <ErrorBox error={error} /> : <Loading />}</Modal>;
  const ro = task.myRole === 'VIEWER';
  const archived = Boolean(task.archivedAt);

  const save = run(() => api.patch(`/tasks/${taskId}`, {
    title: form.title, description: form.description, color: form.color, priority: form.priority,
    dueDate: toIso(form.dueDate), startDate: toIso(form.startDate),
    assigneeIds: form.assigneeIds, labelIds: form.labelIds,
  }), { resetForm: true });
  const del = async () => {
    if (!window.confirm('Supprimer définitivement cette tâche ? Pour la retirer du tableau en gardant son historique, archivez-la plutôt.')) return;
    try { await api.del(`/tasks/${taskId}`); onChanged(); onClose(); } catch (x) { setError(x); }
  };
  const archive = async () => { try { await api.post(`/tasks/${taskId}/archive`); onChanged(); onClose(); } catch (x) { setError(x); } };
  const restore = run(() => api.post(`/tasks/${taskId}/restore`));
  const duplicate = async () => {
    try { const { task: copy } = await api.post(`/tasks/${taskId}/duplicate`, {}); onChanged(); onOpenTask?.(copy.id); } catch (x) { setError(x); }
  };
  const upload = run(async () => {
    const el = document.getElementById('kz-file');
    if (el.files[0]) await api.upload(`/tasks/${taskId}/attachments`, el.files[0]);
    el.value = '';
  });
  const set = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); };
  const toggle = (k, id) => setForm((f) => ({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] }));
  const tabCls = (t) => `px-2 py-1 text-sm rounded-md ${tab === t ? 'bg-gray-100 dark:bg-slate-800 font-semibold text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-800/60'}`;

  return (
    <Modal title={ro ? task.title : 'Modifier la tâche'} onClose={onClose} wide>
      {archived && (
        <div role="status" className="mb-4 p-3 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-sm flex justify-between items-center gap-2">
          <span>Carte archivée le {new Date(task.archivedAt).toLocaleDateString('fr-FR')} (colonne « {task.column.title} »).</span>
          {!ro && <button type="button" className={btnGhost} onClick={restore}><RotateCcw size={14} /> Restaurer</button>}
        </div>
      )}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
          <ErrorBox error={error} />
          <form onSubmit={save} className="space-y-3">
            <input className={input} value={form.title} onChange={set('title')} disabled={ro} required maxLength={300} aria-label="Titre" />
            <textarea className={`${input} min-h-[120px]`} value={form.description} onChange={set('description')} disabled={ro} placeholder="Description" maxLength={20000} aria-label="Description" />

            <div>
              <p className="text-xs text-gray-500 mb-1 flex items-center gap-1"><Tag size={12} /> Étiquettes</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Étiquettes">
                {task.boardLabels.map((l) => {
                  const on = form.labelIds.includes(l.id);
                  return (
                    <button key={l.id} type="button" disabled={ro} aria-pressed={on} onClick={() => toggle('labelIds', l.id)}
                      className={`text-xs px-2 py-0.5 rounded font-medium border-2 disabled:opacity-60 ${LABEL_COLORS[l.color] ?? LABEL_COLORS.gray} ${on ? 'border-indigo-600 dark:border-indigo-300' : 'border-transparent opacity-60 hover:opacity-100'}`}>
                      {on ? '✓ ' : ''}{l.name}
                    </button>
                  );
                })}
                {task.boardLabels.length === 0 && <span className="text-xs text-gray-500">Aucune étiquette sur ce tableau (bouton « Étiquettes » en haut du tableau).</span>}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 mb-1">Assignés {form.assigneeIds.length > 0 && `(${form.assigneeIds.length})`}</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Assignés">
                {members.map((m) => {
                  const on = form.assigneeIds.includes(m.id);
                  return (
                    <button key={m.id} type="button" disabled={ro} aria-pressed={on}
                      onClick={() => toggle('assigneeIds', m.id)}
                      className={`inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 ${on
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 hover:border-indigo-400'}`}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${on ? 'bg-white/25' : 'bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200'}`}>{initials(m.displayName)}</span>
                      {m.displayName}
                    </button>
                  );
                })}
                {members.length === 0 && <span className="text-xs text-gray-500">Aucun membre</span>}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label className="text-xs text-gray-500">Priorité
                <select className={input} value={form.priority} onChange={set('priority')} disabled={ro}>
                  {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500">Début<input type="date" className={input} value={form.startDate} onChange={set('startDate')} disabled={ro} max={form.dueDate || undefined} /></label>
              <label className="text-xs text-gray-500">Échéance<input type="date" className={input} value={form.dueDate} onChange={set('dueDate')} disabled={ro} min={form.startDate || undefined} /></label>
              <label className="text-xs text-gray-500">Couleur
                <select className={input} value={form.color} onChange={set('color')} disabled={ro}>
                  {Object.keys(COLORS).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            {!ro && <div className="flex justify-between"><button className={btnPrimary}>Enregistrer</button><button type="button" className={btnDanger} onClick={del}><Trash2 size={14} /> Supprimer</button></div>}
          </form>

          <section>
            <h3 className="text-sm font-semibold mb-2 dark:text-gray-200">Sous-tâches</h3>
            <ul className="space-y-1">
              {task.subtasks.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm dark:text-gray-200">
                  <input type="checkbox" checked={s.completed} disabled={ro} onChange={run(() => api.patch(`/subtasks/${s.id}`, { completed: !s.completed }))} aria-label={s.content} />
                  <span className={s.completed ? 'line-through text-gray-500' : ''}>{s.content}</span>
                  {!ro && <button className="ml-auto text-gray-500 hover:text-red-600" onClick={run(() => api.del(`/subtasks/${s.id}`))} aria-label="Supprimer"><Trash2 size={12} /></button>}
                </li>
              ))}
            </ul>
            {!ro && (
              <form onSubmit={run(async () => { await api.post(`/tasks/${taskId}/subtasks`, { content: sub }); setSub(''); })} className="flex gap-2 mt-2">
                <input className={input} value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Ajouter une sous-tâche" required maxLength={300} />
                <button className={btnGhost}>Ajouter</button>
              </form>
            )}
          </section>

          <section>
            <div className="flex gap-1 mb-2" role="tablist" aria-label="Discussion et activité">
              <button type="button" role="tab" aria-selected={tab === 'comments'} className={tabCls('comments')} onClick={() => setTab('comments')}>Commentaires ({task.comments.length})</button>
              <button type="button" role="tab" aria-selected={tab === 'activity'} className={tabCls('activity')} onClick={() => setTab('activity')}><History size={14} className="inline -mt-0.5" /> Activité</button>
            </div>
            {tab === 'activity' ? <ActivityLog taskId={taskId} refreshKey={activityKey} /> : (
              <>
                <ul className="space-y-2">
                  {task.comments.map((c) => {
                    const mine = c.author?.id === user?.id;
                    return (
                      <li key={c.id} className="text-sm bg-gray-50 dark:bg-slate-800 rounded-md p-2 dark:text-gray-200">
                        <div className="text-xs text-gray-500 mb-1 flex justify-between gap-2">
                          <span>{c.author?.displayName ?? 'Utilisateur supprimé'} · {fmtWhen(c.createdAt)}{c.editedAt ? ' · modifié' : ''}</span>
                          <span className="flex gap-2">
                            {mine && !ro && <button className="hover:text-indigo-600" onClick={() => setEditComment({ id: c.id, content: c.content })} aria-label="Modifier le commentaire"><Pencil size={12} /></button>}
                            {(mine || task.myRole === 'OWNER') && <button className="hover:text-red-600" onClick={run(() => api.del(`/comments/${c.id}`))} aria-label="Supprimer le commentaire"><Trash2 size={12} /></button>}
                          </span>
                        </div>
                        {editComment?.id === c.id ? (
                          <form onSubmit={run(async () => { await api.patch(`/comments/${c.id}`, { content: editComment.content }); setEditComment(null); })} className="space-y-2">
                            <textarea className={input} value={editComment.content} onChange={(e) => setEditComment({ ...editComment, content: e.target.value })} required maxLength={10000} aria-label="Commentaire" autoFocus />
                            <div className="flex gap-2"><button className={btnPrimary}>Enregistrer</button><button type="button" className={btnGhost} onClick={() => setEditComment(null)}>Annuler</button></div>
                          </form>
                        ) : <p className="whitespace-pre-wrap break-words">{c.content}</p>}
                      </li>
                    );
                  })}
                </ul>
                {!ro && (
                  <form onSubmit={run(async () => { await api.post(`/tasks/${taskId}/comments`, { content: comment }); setComment(''); })} className="mt-2 space-y-2">
                    <textarea className={input} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Écrire un commentaire" required maxLength={10000} aria-label="Nouveau commentaire" />
                    <button className={btnGhost}>Commenter</button>
                  </form>
                )}
              </>
            )}
          </section>
        </div>

        <aside className="space-y-3">
          {task.labelIds.length > 0 && (
            <div className="flex flex-wrap gap-1">{task.labelIds.map((id) => <LabelChip key={id} label={task.boardLabels.find((l) => l.id === id)} />)}</div>
          )}
          {!ro && (
            <div className="flex flex-col items-stretch gap-1" aria-label="Actions sur la carte">
              {!archived && <button type="button" className={btnGhost} onClick={archive}><Archive size={14} /> Archiver</button>}
              <button type="button" className={btnGhost} onClick={duplicate}><Copy size={14} /> Dupliquer</button>
              {!archived && <button type="button" className={btnGhost} onClick={() => setTransfer(true)}><ArrowRightLeft size={14} /> Déplacer vers un tableau…</button>}
            </div>
          )}
          {(() => {
            const url = `${window.location.origin}/b/${task.boardId}?task=${taskId}`;
            const due = task.dueDate ? ` (échéance ${new Date(task.dueDate).toLocaleDateString('fr-FR')})` : '';
            const copy = async (kind, text) => { if (await copyText(text)) { setCopied(kind); setTimeout(() => setCopied(null), 2000); } };
            return (
              <div className="flex flex-col gap-1">
                <button type="button" className={btnGhost} onClick={() => copy('link', url)}><Link2 size={14} /> {copied === 'link' ? 'Lien copié' : 'Copier le lien'}</button>
                <button type="button" className={btnGhost} onClick={() => copy('md', `[${task.title.replace(/[[\]]/g, '')}](${url})${due}`)}><ClipboardCopy size={14} /> {copied === 'md' ? 'Copié' : 'Copier en Markdown'}</button>
                <span className="sr-only" aria-live="polite">{copied ? 'Copié dans le presse-papiers' : ''}</span>
              </div>
            );
          })()}
          <h3 className="text-sm font-semibold dark:text-gray-200 flex items-center gap-1"><Paperclip size={14} /> Pièces jointes</h3>
          <ul className="space-y-1">
            {task.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm dark:text-gray-200">
                <a className="truncate hover:underline flex items-center gap-1" href={`/api/attachments/${a.id}/download`}><Download size={12} /> {a.filename}</a>
                <span className="text-xs text-gray-500 shrink-0">{fmtSize(a.size)}</span>
                {!ro && <button className="ml-auto text-gray-500 hover:text-red-600" onClick={run(() => api.del(`/attachments/${a.id}`))} aria-label="Supprimer"><Trash2 size={12} /></button>}
              </li>
            ))}
          </ul>
          {!ro && <input id="kz-file" type="file" onChange={upload} className="text-xs dark:text-gray-300" aria-label="Joindre un fichier" />}
          <TaskWikiLinks taskId={taskId} workspaceId={workspaceId} />
          <p className="text-xs text-gray-500">Créée par {task.createdBy?.displayName ?? '—'} le {new Date(task.createdAt).toLocaleDateString('fr-FR')}</p>
        </aside>
      </div>
      {transfer && <TransferModal task={{ ...task, id: taskId }} boards={boards} onClose={() => setTransfer(false)} onDone={() => { setTransfer(false); onChanged(); onClose(); }} />}
    </Modal>
  );
}
