import { useEffect, useState } from 'react';
import { Trash2, Paperclip, Download } from 'lucide-react';
import { api } from '../api';
import { COLORS, initials } from './TaskCard';
import { ErrorBox, Loading, Modal, input, btnPrimary, btnGhost, btnDanger } from '../ui';

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.ceil(n / 1024)} ko`);

export function TaskDetail({ taskId, workspaceId, onClose, onChanged }) {
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [members, setMembers] = useState([]);
  const [sub, setSub] = useState('');
  const [comment, setComment] = useState('');

  // resetForm : uniquement au chargement et après enregistrement. Ajouter un commentaire ou une sous-tâche
  // ne doit pas écraser une modification en cours du formulaire (titre, assignés…).
  const load = ({ resetForm = false } = {}) => api.get(`/tasks/${taskId}`).then(({ task: t }) => {
    setTask(t);
    if (resetForm) setForm({ title: t.title, description: t.description, color: t.color, dueDate: t.dueDate?.slice(0, 10) ?? '', assigneeIds: t.assignees.map((u) => u.id) });
  }, setError);
  useEffect(() => { load({ resetForm: true }); }, [taskId]); // load dépend uniquement de taskId

  useEffect(() => {
    api.get(`/workspaces/${workspaceId}`).then((r) => setMembers(r.workspace.members)).catch(() => {});
  }, [workspaceId]);

  const run = (fn, opts) => async (e) => { e?.preventDefault?.(); try { setError(null); await fn(); await load(opts); onChanged(); } catch (x) { setError(x); } };
  if (!task || !form) return <Modal title="Tâche" onClose={onClose}>{error ? <ErrorBox error={error} /> : <Loading />}</Modal>;
  const ro = task.myRole === 'VIEWER';

  const save = run(() => api.patch(`/tasks/${taskId}`, {
    title: form.title, description: form.description, color: form.color,
    dueDate: form.dueDate ? new Date(`${form.dueDate}T12:00:00Z`).toISOString() : null,
    assigneeIds: form.assigneeIds,
  }), { resetForm: true });
  const del = async () => {
    if (!window.confirm('Supprimer cette tâche ?')) return;
    try { await api.del(`/tasks/${taskId}`); onChanged(); onClose(); } catch (x) { setError(x); }
  };
  const upload = run(async () => {
    const el = document.getElementById('kz-file');
    if (el.files[0]) await api.upload(`/tasks/${taskId}/attachments`, el.files[0]);
    el.value = '';
  });
  const set = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); };

  return (
    <Modal title={ro ? task.title : 'Modifier la tâche'} onClose={onClose} wide>
      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-4">
          <ErrorBox error={error} />
          <form onSubmit={save} className="space-y-3">
            <input className={input} value={form.title} onChange={set('title')} disabled={ro} required maxLength={300} aria-label="Titre" />
            <textarea className={`${input} min-h-[120px]`} value={form.description} onChange={set('description')} disabled={ro} placeholder="Description" maxLength={20000} />
            <div>
              <p className="text-xs text-gray-500 mb-1">Assignés {form.assigneeIds.length > 0 && `(${form.assigneeIds.length})`}</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Assignés">
                {members.map((m) => {
                  const on = form.assigneeIds.includes(m.id);
                  return (
                    <button key={m.id} type="button" disabled={ro} aria-pressed={on}
                      onClick={() => setForm((f) => ({ ...f, assigneeIds: f.assigneeIds.includes(m.id) ? f.assigneeIds.filter((x) => x !== m.id) : [...f.assigneeIds, m.id] }))}
                      className={`inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-60 ${on
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 hover:border-indigo-400'}`}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${on ? 'bg-white/25' : 'bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200'}`}>{initials(m.displayName)}</span>
                      {m.displayName}
                    </button>
                  );
                })}
                {members.length === 0 && <span className="text-xs text-gray-400">Aucun membre</span>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-500">Échéance<input type="date" className={input} value={form.dueDate} onChange={set('dueDate')} disabled={ro} /></label>
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
                  <input type="checkbox" checked={s.completed} disabled={ro} onChange={run(() => api.patch(`/subtasks/${s.id}`, { completed: !s.completed }))} />
                  <span className={s.completed ? 'line-through text-gray-400' : ''}>{s.content}</span>
                  {!ro && <button className="ml-auto text-gray-400 hover:text-red-600" onClick={run(() => api.del(`/subtasks/${s.id}`))} aria-label="Supprimer"><Trash2 size={12} /></button>}
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
            <h3 className="text-sm font-semibold mb-2 dark:text-gray-200">Commentaires</h3>
            <ul className="space-y-2">
              {task.comments.map((c) => (
                <li key={c.id} className="text-sm bg-gray-50 dark:bg-slate-800 rounded-md p-2 dark:text-gray-200">
                  <div className="text-xs text-gray-500 mb-1 flex justify-between">
                    <span>{c.author?.displayName ?? 'Utilisateur supprimé'} · {new Date(c.createdAt).toLocaleString('fr-FR')}</span>
                    <button className="hover:text-red-600" onClick={run(() => api.del(`/comments/${c.id}`))} aria-label="Supprimer"><Trash2 size={12} /></button>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{c.content}</p>
                </li>
              ))}
            </ul>
            {!ro && (
              <form onSubmit={run(async () => { await api.post(`/tasks/${taskId}/comments`, { content: comment }); setComment(''); })} className="mt-2 space-y-2">
                <textarea className={input} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Écrire un commentaire" required maxLength={10000} />
                <button className={btnGhost}>Commenter</button>
              </form>
            )}
          </section>
        </div>

        <aside className="space-y-3">
          <h3 className="text-sm font-semibold dark:text-gray-200 flex items-center gap-1"><Paperclip size={14} /> Pièces jointes</h3>
          <ul className="space-y-1">
            {task.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm dark:text-gray-200">
                <a className="truncate hover:underline flex items-center gap-1" href={`/api/attachments/${a.id}/download`}><Download size={12} /> {a.filename}</a>
                <span className="text-xs text-gray-400 shrink-0">{fmtSize(a.size)}</span>
                {!ro && <button className="ml-auto text-gray-400 hover:text-red-600" onClick={run(() => api.del(`/attachments/${a.id}`))} aria-label="Supprimer"><Trash2 size={12} /></button>}
              </li>
            ))}
          </ul>
          {!ro && <input id="kz-file" type="file" onChange={upload} className="text-xs dark:text-gray-300" />}
          <p className="text-xs text-gray-500">Créée par {task.createdBy?.displayName ?? '—'} le {new Date(task.createdAt).toLocaleDateString('fr-FR')}</p>
        </aside>
      </div>
    </Modal>
  );
}
