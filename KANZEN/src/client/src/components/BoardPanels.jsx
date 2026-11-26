// Fenêtres du tableau : gestion des étiquettes, cartes archivées.
import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { ErrorBox, Loading, Modal, btnGhost, btnPrimary, input, useApi } from '../ui';
import { FIELD_TYPES, LABEL_COLORS, LABEL_COLOR_NAMES, LabelChip, PRIORITY } from './boardMeta';

function ColorPicker({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Couleur">
      {Object.keys(LABEL_COLORS).map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} title={LABEL_COLOR_NAMES[c]} aria-label={LABEL_COLOR_NAMES[c]}
          onClick={() => onChange(c)}
          className={`w-6 h-6 rounded ${LABEL_COLORS[c]} ${value === c ? 'ring-2 ring-offset-1 ring-indigo-600 dark:ring-offset-slate-900' : ''}`} />
      ))}
    </div>
  );
}

/** Étiquettes du tableau : création, renommage, couleur, suppression. */
export function LabelsModal({ board, canEdit, onClose, onChanged }) {
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('blue');
  const [editing, setEditing] = useState(null); // { id, name, color }
  const run = (fn) => async (e) => { e?.preventDefault?.(); try { setError(null); await fn(); onChanged(); } catch (x) { setError(x); } };

  const add = run(async () => { await api.post(`/boards/${board.id}/labels`, { name, color }); setName(''); });
  const save = run(async () => { await api.patch(`/labels/${editing.id}`, { name: editing.name, color: editing.color }); setEditing(null); });
  const remove = (l) => run(async () => {
    if (!window.confirm(`Supprimer l'étiquette « ${l.name} » ? Elle sera retirée de toutes les cartes.`)) return;
    await api.del(`/labels/${l.id}`);
  });

  return (
    <Modal title="Étiquettes du tableau" onClose={onClose}>
      <ErrorBox error={error} />
      <ul className="space-y-2 mb-4">
        {board.labels.length === 0 && <li className="text-sm text-gray-500">Aucune étiquette. Exemples : Sécurité, Réseau, Incident, Changement.</li>}
        {board.labels.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            {editing?.id === l.id ? (
              <form onSubmit={save} className="flex-1 space-y-2">
                <input className={input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={40} required aria-label="Nom de l'étiquette" autoFocus />
                <ColorPicker value={editing.color} onChange={(c) => setEditing({ ...editing, color: c })} />
                <div className="flex gap-2"><button className={btnPrimary}>Enregistrer</button><button type="button" className={btnGhost} onClick={() => setEditing(null)}>Annuler</button></div>
              </form>
            ) : (
              <>
                <span className="flex-1 min-w-0"><LabelChip label={l} /></span>
                {canEdit && <button type="button" className={btnGhost} onClick={() => setEditing({ id: l.id, name: l.name, color: l.color })}>Modifier</button>}
                {canEdit && <button type="button" className="text-gray-500 hover:text-red-600 p-1" onClick={remove(l)} aria-label={`Supprimer l'étiquette ${l.name}`}><Trash2 size={14} /></button>}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form onSubmit={add} className="space-y-2 border-t border-gray-200 dark:border-slate-700 pt-4">
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nouvelle étiquette" maxLength={40} required aria-label="Nom de la nouvelle étiquette" />
          <ColorPicker value={color} onChange={setColor} />
          <button className={btnPrimary}>Ajouter</button>
        </form>
      )}
    </Modal>
  );
}

/** Cartes archivées du tableau : consultation et restauration. */
export function ArchivedModal({ boardId, canEdit, onClose, onOpen, onChanged }) {
  const { data, error, reload } = useApi(() => api.get(`/boards/${boardId}/archived`), [boardId]);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const restore = async (t) => {
    try { await api.post(`/tasks/${t.id}/restore`); reload(); onChanged(); } catch (x) { setErr(x); }
  };
  const tasks = (data?.tasks ?? []).filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Cartes archivées" wide onClose={onClose}>
      <ErrorBox error={error ?? err} />
      {!data ? (!error && <Loading />) : (
        <>
          <input className={`${input} mb-3`} placeholder="Filtrer…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filtrer les cartes archivées" />
          {tasks.length === 0 ? <p className="text-sm text-gray-500">Aucune carte archivée.</p> : (
            <ul className="divide-y divide-gray-100 dark:divide-slate-800">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2">
                  <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onOpen(t.id)}>
                    <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{t.title}</span>
                    <span className="block text-xs text-gray-500">
                      {t.column.title} · archivée le {new Date(t.archivedAt).toLocaleDateString('fr-FR')}
                      {t.priority !== 'NONE' && ` · priorité ${PRIORITY[t.priority].label.toLowerCase()}`}
                    </span>
                  </button>
                  {canEdit && <button type="button" className={btnGhost} onClick={() => restore(t)}><RotateCcw size={14} /> Restaurer</button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

const splitOptions = (s) => [...new Set(s.split(/[,;\n]/).map((o) => o.trim()).filter(Boolean))];
const TYPE_LABEL = Object.fromEntries(FIELD_TYPES.map((t) => [t.value, t.label]));

/** Champs personnalisés du tableau (texte, nombre, date, liste de choix, case à cocher). */
export function FieldsModal({ board, canEdit, onClose, onChanged }) {
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState({ name: '', type: 'TEXT', options: '' });
  const [editing, setEditing] = useState(null); // { id, name, type, options }
  const run = (fn) => async (e) => { e?.preventDefault?.(); try { setError(null); await fn(); onChanged(); } catch (x) { setError(x); } };

  const add = run(async () => {
    await api.post(`/boards/${board.id}/fields`, { name: draft.name, type: draft.type, ...(draft.type === 'SELECT' ? { options: splitOptions(draft.options) } : {}) });
    setDraft({ name: '', type: draft.type, options: '' });
  });
  const save = run(async () => {
    await api.patch(`/fields/${editing.id}`, { name: editing.name, ...(editing.type === 'SELECT' ? { options: splitOptions(editing.options) } : {}) });
    setEditing(null);
  });
  const remove = (f) => run(async () => {
    if (!window.confirm(`Supprimer le champ « ${f.name} » ? Ses valeurs seront effacées de toutes les cartes.`)) return;
    await api.del(`/fields/${f.id}`);
  });

  return (
    <Modal title="Champs personnalisés" onClose={onClose}>
      <ErrorBox error={error} />
      <ul className="space-y-2 mb-4">
        {board.fields.length === 0 && <li className="text-sm text-gray-500">Aucun champ. Exemples : Environnement (liste Prod, Recette), N° de ticket (texte), Validé CAB (case à cocher).</li>}
        {board.fields.map((f) => (
          <li key={f.id} className="flex items-center gap-2">
            {editing?.id === f.id ? (
              <form onSubmit={save} className="flex-1 space-y-2">
                <input className={input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={40} required aria-label="Nom du champ" autoFocus />
                {f.type === 'SELECT' && (
                  <input className={input} value={editing.options} onChange={(e) => setEditing({ ...editing, options: e.target.value })} required aria-label="Options (séparées par des virgules)" />
                )}
                {f.type === 'SELECT' && <p className="text-xs text-gray-500">Une option retirée est effacée des cartes qui l&apos;utilisaient.</p>}
                <div className="flex gap-2"><button className={btnPrimary}>Enregistrer</button><button type="button" className={btnGhost} onClick={() => setEditing(null)}>Annuler</button></div>
              </form>
            ) : (
              <>
                <span className="flex-1 min-w-0 text-sm text-gray-900 dark:text-gray-100">
                  <span className="font-medium">{f.name}</span> <span className="text-xs text-gray-500">· {TYPE_LABEL[f.type]}{f.type === 'SELECT' ? ` : ${f.options.join(', ')}` : ''}</span>
                </span>
                {canEdit && <button type="button" className={btnGhost} onClick={() => setEditing({ id: f.id, name: f.name, type: f.type, options: f.options.join(', ') })}>Modifier</button>}
                {canEdit && <button type="button" className="text-gray-500 hover:text-red-600 p-1" onClick={remove(f)} aria-label={`Supprimer le champ ${f.name}`}><Trash2 size={14} /></button>}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && board.fields.length < 20 && (
        <form onSubmit={add} className="space-y-2 border-t border-gray-200 dark:border-slate-700 pt-4">
          <div className="flex gap-2">
            <input className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Nouveau champ" maxLength={40} required aria-label="Nom du nouveau champ" />
            <select className={`${input} !w-44`} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} aria-label="Type du champ">
              {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {draft.type === 'SELECT' && (
            <input className={input} value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Prod, Recette, Développement" required aria-label="Options (séparées par des virgules)" />
          )}
          <button className={btnPrimary}>Ajouter le champ</button>
        </form>
      )}
    </Modal>
  );
}
