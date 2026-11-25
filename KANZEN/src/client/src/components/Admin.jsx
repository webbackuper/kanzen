import { useState } from 'react';
import { Plus, Lock, Unlock, KeyRound, LogOut } from 'lucide-react';
import { api } from '../api';
import { ErrorBox, Loading, Modal, useApi, btnPrimary, btnGhost, input, card } from '../ui';

const fmt = (d) => (d ? new Date(d).toLocaleString('fr-FR') : '—');

export function AdminUsers({ user: me }) {
  const { data, error, reload } = useApi(() => api.get('/users'), []);
  const overview = useApi(() => api.get('/admin/overview'), []);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '', role: 'USER' });

  const act = (fn) => async () => { try { setErr(null); await fn(); reload(); } catch (x) { setErr(x); } };
  const create = async (e) => {
    e.preventDefault();
    try {
      const body = { ...form }; if (!body.email) delete body.email;
      await api.post('/users', body);
      setCreating(false); setForm({ username: '', displayName: '', email: '', password: '', role: 'USER' }); reload();
    } catch (x) { setErr(x); }
  };
  const resetPwd = (u) => act(async () => {
    const p = window.prompt(`Mot de passe temporaire pour ${u.username} (changement imposé à la connexion)`);
    if (p) await api.post(`/users/${u.id}/reset-password`, { password: p });
  });

  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const o = overview.data;
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Comptes</h1>
        <button className={btnPrimary} onClick={() => setCreating(true)}><Plus size={16} /> Compte local</button>
      </div>
      {o && <p className="text-sm text-gray-500">{o.users.LOCAL ?? 0} compte(s) local(aux) · {o.users.LDAP ?? 0} compte(s) AD · {o.activeSessions} session(s) active(s) · {o.workspaces} espace(s) · {o.tasks} tâche(s)</p>}
      <ErrorBox error={err} />
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500 border-b dark:border-slate-800">
            <tr><th className="p-3">Identifiant</th><th>Nom</th><th>Source</th><th>Rôle</th><th>Dernière connexion</th><th>État</th><th className="text-right p-3">Actions</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800 dark:text-gray-200">
            {data.users.map((u) => {
              const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
              return (
                <tr key={u.id}>
                  <td className="p-3 font-mono">{u.username}</td>
                  <td>{u.displayName}</td>
                  <td>{u.authSource === 'LDAP' ? 'AD' : 'Local'}</td>
                  <td>
                    {u.authSource === 'LOCAL' && u.id !== me.id ? (
                      <select className={`${input} w-28 py-1`} value={u.role} onChange={(e) => act(() => api.patch(`/users/${u.id}`, { role: e.target.value }))()}>
                        <option value="USER">Utilisateur</option><option value="ADMIN">Admin</option>
                      </select>
                    ) : (u.role === 'ADMIN' ? 'Admin' : 'Utilisateur')}
                  </td>
                  <td className="text-xs">{fmt(u.lastLoginAt)}</td>
                  <td className="text-xs">{u.disabled ? <span className="text-red-600">Désactivé</span> : locked ? <span className="text-amber-600">Verrouillé</span> : 'Actif'}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      {locked && <button className={btnGhost} title="Déverrouiller" onClick={act(() => api.patch(`/users/${u.id}`, { unlock: true }))}><Unlock size={14} /></button>}
                      {u.authSource === 'LOCAL' && <button className={btnGhost} title="Réinitialiser le mot de passe" onClick={resetPwd(u)}><KeyRound size={14} /></button>}
                      <button className={btnGhost} title="Fermer ses sessions" onClick={act(() => api.del(`/users/${u.id}/sessions`))}><LogOut size={14} /></button>
                      {u.id !== me.id && (
                        <button className={btnGhost} title={u.disabled ? 'Réactiver' : 'Désactiver'} onClick={act(() => api.patch(`/users/${u.id}`, { disabled: !u.disabled }))}>
                          {u.disabled ? <Unlock size={14} /> : <Lock size={14} />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">Les comptes AD sont créés à leur première connexion. Leur rôle découle des groupes AD ; leur accès se retire dans l&apos;annuaire.</p>
      {creating && (
        <Modal title="Nouveau compte local" onClose={() => setCreating(false)}>
          <form onSubmit={create} className="space-y-3">
            <ErrorBox error={err} />
            <input className={input} placeholder="Identifiant (minuscules)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} pattern="[a-z0-9][a-z0-9._\-]{1,63}" required />
            <input className={input} placeholder="Nom affiché" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
            <input className={input} type="email" placeholder="E-mail (optionnel)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input className={input} type="password" autoComplete="new-password" placeholder="Mot de passe temporaire" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="USER">Utilisateur</option><option value="ADMIN">Administrateur</option>
            </select>
            <p className="text-xs text-gray-500">L&apos;utilisateur devra changer ce mot de passe à sa première connexion.</p>
            <button className={btnPrimary}>Créer</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function AdminAudit() {
  const [action, setAction] = useState('');
  const { data, error } = useApi(() => api.get(`/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`), [action]);
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex justify-between items-center gap-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Journal d&apos;audit</h1>
        <select className={`${input} w-56`} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Toutes les actions</option>
          <option value="auth.">Authentification</option>
          <option value="user.">Comptes</option>
          <option value="workspace.">Espaces</option>
          <option value="board.">Tableaux</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b dark:border-slate-800"><tr><th className="p-2">Date</th><th>Acteur</th><th>Action</th><th>Cible</th><th>Résultat</th><th>IP</th><th>Détails</th></tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800 dark:text-gray-200 font-mono">
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="p-2 whitespace-nowrap">{fmt(e.timestamp)}</td><td>{e.actorName ?? '—'}</td><td>{e.action}</td><td className="max-w-[12rem] truncate">{e.target}</td>
                  <td className={e.outcome === 'failure' ? 'text-red-600' : 'text-green-700 dark:text-green-400'}>{e.outcome}</td><td>{e.ip}</td>
                  <td className="max-w-[16rem] truncate">{e.details ? JSON.stringify(e.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
