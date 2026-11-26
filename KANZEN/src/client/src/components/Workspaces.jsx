import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2, Users, LayoutGrid, BookOpen } from 'lucide-react';
import { api } from '../api';
import { ErrorBox, Loading, Modal, useApi, btnPrimary, btnGhost, btnDanger, input, card, ROLE_LABEL } from '../ui';

export function Workspaces() {
  const { data, error, reload } = useApi(() => api.get('/workspaces'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const navigate = useNavigate();

  const create = async (e) => {
    e.preventDefault();
    try {
      const { workspace } = await api.post('/workspaces', { name });
      navigate(`/w/${workspace.id}`);
    } catch (x) { setErr(x); }
  };

  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Espaces de travail</h1>
        <button className={btnPrimary} onClick={() => setCreating(true)}><Plus size={16} /> Nouvel espace</button>
      </div>
      {data.workspaces.length === 0 && <p className="text-gray-500">Aucun espace. Créez-en un, ou demandez à un propriétaire de vous ajouter.</p>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.workspaces.map((w) => (
          <div key={w.id} className={`${card} relative p-5 hover:shadow-md transition-shadow`}>
            {/* Lien « étiré » sur toute la carte ; le lien Wiki passe au-dessus (pas de liens imbriqués) */}
            <h2 className="font-semibold text-gray-900 dark:text-white">
              <Link to={`/w/${w.id}`} className="after:absolute after:inset-0 after:rounded-xl focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-indigo-500">{w.name}</Link>
            </h2>
            <p className="text-sm text-gray-500 mt-1 flex gap-4">
              <span className="flex items-center gap-1"><LayoutGrid size={14} /> {w.boards} tableau(x)</span>
              <span className="flex items-center gap-1"><Users size={14} /> {w.members}</span>
            </p>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-indigo-600 dark:text-indigo-400">{ROLE_LABEL[w.myRole]}</p>
              <Link to={`/w/${w.id}/wiki`} aria-label={`Wiki de l'espace ${w.name}`}
                className="relative z-10 flex items-center gap-1 px-2 py-1 -my-1 rounded-md text-xs font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/40">
                <BookOpen size={14} /> Wiki
              </Link>
            </div>
          </div>
        ))}
      </div>
      {creating && (
        <Modal title="Nouvel espace" onClose={() => { setCreating(false); reload(); }}>
          <form onSubmit={create} className="space-y-3">
            <ErrorBox error={err} />
            <input autoFocus className={input} placeholder="Nom de l'espace" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
            <button className={btnPrimary}>Créer</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function MemberAdd({ wsId, onAdded }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [role, setRole] = useState('EDITOR');
  const [err, setErr] = useState(null);
  const [adDown, setAdDown] = useState(false);
  const seq = useRef(0);
  const search = async (v) => {
    setQ(v);
    if (v.length < 2) return setResults([]);
    const n = ++seq.current; // seule la dernière frappe compte (réponses de l'AD plus lentes)
    try {
      const r = await api.get(`/users/lookup?q=${encodeURIComponent(v)}`);
      if (n === seq.current) { setResults(r.users); setAdDown(!!r.directoryError); }
    } catch (x) { setErr(x); }
  };
  const add = async (u) => {
    try {
      // Agent AD jamais connecté : création de son compte à partir de l'annuaire, puis ajout
      const id = u.id ?? (await api.post('/users/provision', { externalId: u.externalId })).user.id;
      await api.put(`/workspaces/${wsId}/members/${id}`, { role }); setQ(''); setResults([]); onAdded();
    } catch (x) { setErr(x); }
  };
  return (
    <div className="space-y-2">
      <ErrorBox error={err} />
      <div className="flex gap-2">
        <input className={input} placeholder="Rechercher un utilisateur (nom ou identifiant)" value={q} onChange={(e) => search(e.target.value)} />
        <select className={`${input} w-40`} value={role} onChange={(e) => setRole(e.target.value)}>
          {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {results.length > 0 && (
        <ul className="border border-gray-200 dark:border-slate-700 rounded-md divide-y divide-gray-100 dark:divide-slate-800">
          {results.map((u) => (
            <li key={u.id ?? `ad-${u.externalId}`}><button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-gray-200" onClick={() => add(u)}>{u.displayName} <span className="text-gray-500 dark:text-gray-400">({u.username})</span>{!u.id && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">annuaire AD</span>}</button></li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-500">{adDown
        ? 'Annuaire AD injoignable : seuls les comptes déjà connus sont proposés.'
        : 'Les agents du groupe d\'accès AD sont proposés dès 3 caractères, même s\'ils ne se sont jamais connectés.'}</p>
    </div>
  );
}

export function WorkspacePage({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = useApi(() => api.get(`/workspaces/${id}`), [id]);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState(null);
  const [showMembers, setShowMembers] = useState(false);

  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const ws = data.workspace;
  const canEdit = ws.myRole !== 'VIEWER';
  const isOwner = ws.myRole === 'OWNER';

  const createBoard = async (e) => {
    e.preventDefault();
    try { const { board } = await api.post(`/workspaces/${id}/boards`, { title, template: 'kanban' }); navigate(`/b/${board.id}`); } catch (x) { setErr(x); }
  };
  const act = (fn) => async (...a) => { try { setErr(null); await fn(...a); reload(); } catch (x) { setErr(x); } };
  const setRole = act((uid, role) => api.put(`/workspaces/${id}/members/${uid}`, { role }));
  const remove = act((uid) => api.del(`/workspaces/${id}/members/${uid}`));
  const deleteWs = async () => {
    if (!window.confirm(`Supprimer définitivement l'espace « ${ws.name} » et tout son contenu ?`)) return;
    try { await api.del(`/workspaces/${id}`); navigate('/'); } catch (x) { setErr(x); }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <Link to="/" className="text-sm text-gray-500 hover:underline">← Espaces</Link>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{ws.name}</h1>
        </div>
        <div className="flex gap-2">
          <Link to={`/w/${id}/wiki`} className={btnPrimary}><BookOpen size={16} /> Wiki</Link>
          <button className={btnGhost} onClick={() => setShowMembers(true)}><Users size={16} /> Membres ({ws.members.length})</button>
          {isOwner && <button className={btnDanger} onClick={deleteWs}><Trash2 size={16} /> Supprimer</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {ws.boards.map((b) => (
          <Link key={b.id} to={`/b/${b.id}`} className={`${card} p-5 hover:shadow-md transition-shadow`}>
            <h2 className="font-semibold text-gray-900 dark:text-white">{b.title}</h2>
            <p className="text-xs text-gray-500 mt-1">Créé le {new Date(b.createdAt).toLocaleDateString('fr-FR')}</p>
          </Link>
        ))}
        {canEdit && (
          <form onSubmit={createBoard} className={`${card} p-5 border-dashed space-y-2`}>
            <input className={input} placeholder="Nouveau tableau" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
            <button className={btnPrimary}><Plus size={16} /> Créer</button>
          </form>
        )}
      </div>
      {showMembers && (
        <Modal title="Membres de l'espace" wide onClose={() => setShowMembers(false)}>
          <ErrorBox error={err} />
          <ul className="divide-y divide-gray-100 dark:divide-slate-800 mb-4">
            {ws.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 gap-2">
                <span className="text-sm dark:text-gray-200">{m.displayName} <span className="text-gray-500 dark:text-gray-400">({m.username})</span></span>
                <span className="flex items-center gap-2">
                  {isOwner ? (
                    <select className={`${input} w-36`} value={m.role} onChange={(e) => setRole(m.id, e.target.value)}>
                      {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  ) : <span className="text-xs text-gray-500">{ROLE_LABEL[m.role]}</span>}
                  {(isOwner || m.id === user.id) && <button className={btnDanger} onClick={() => remove(m.id)} aria-label="Retirer"><Trash2 size={14} /></button>}
                </span>
              </li>
            ))}
          </ul>
          {isOwner && <MemberAdd wsId={id} onAdded={reload} />}
        </Modal>
      )}
    </div>
  );
}

/** Entrée « Wiki » de la barre principale : un wiki par espace ; redirection directe s'il n'y en a qu'un. */
export function WikiIndex() {
  const { data, error } = useApi(() => api.get('/workspaces'), []);
  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  if (data.workspaces.length === 1) return <Navigate to={`/w/${data.workspaces[0].id}/wiki`} replace />;
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">Wiki</h1>
      <p className="text-sm text-gray-500 mb-6">Chaque espace de travail a son propre wiki, avec les mêmes droits que ses tableaux.</p>
      {data.workspaces.length === 0 && <p className="text-gray-500">Aucun espace. Créez-en un depuis « Espaces », ou demandez à un propriétaire de vous ajouter.</p>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.workspaces.map((w) => (
          <Link key={w.id} to={`/w/${w.id}/wiki`} className={`${card} p-5 hover:shadow-md transition-shadow flex items-start gap-3`}>
            <BookOpen size={20} className="text-indigo-500 mt-0.5 shrink-0" />
            <span>
              <span className="block font-semibold text-gray-900 dark:text-white">{w.name}</span>
              <span className="block text-xs text-indigo-600 dark:text-indigo-400 mt-1">{ROLE_LABEL[w.myRole]}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
