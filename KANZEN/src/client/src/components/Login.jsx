import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, input, btnPrimary } from '../ui';

export function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState(null);

  useEffect(() => { api.get('/auth/config').then(setSources).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { user } = await api.post('/auth/login', { username, password });
      onLogin(user);
    } catch (err) {
      setError(err);
      setPassword('');
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <div className="max-w-sm w-full bg-white dark:bg-slate-900 p-8 rounded-xl shadow-lg border border-gray-100 dark:border-slate-800">
        <div className="text-center mb-6">
          <div className="w-12 h-12 mx-auto mb-3 bg-indigo-600 rounded-xl flex items-center justify-center text-white text-xl font-bold">Z</div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">KanZen</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            {sources?.ldap ? 'Connectez-vous avec votre compte Windows' : 'Connectez-vous à votre espace'}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <ErrorBox error={error} />
          <div>
            <label htmlFor="u" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Identifiant</label>
            <input id="u" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} className={input} placeholder={sources?.ldap ? 'jdupont' : ''} required />
          </div>
          <div>
            <label htmlFor="p" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mot de passe</label>
            <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
          </div>
          <button type="submit" disabled={busy} className={`${btnPrimary} w-full justify-center py-2`}>{busy ? 'Connexion…' : 'Se connecter'}</button>
        </form>
      </div>
    </div>
  );
}

export function ChangePassword({ forced, onDone }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    if (form.newPassword !== form.confirm) return setError(new Error('La confirmation ne correspond pas'));
    try {
      await api.post('/auth/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setOk(true); setForm({ currentPassword: '', newPassword: '', confirm: '' });
      onDone?.();
    } catch (err) { setError(err); }
  };
  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      {forced && <p className="text-sm text-amber-700 dark:text-amber-300">Vous devez définir un nouveau mot de passe avant de continuer.</p>}
      <ErrorBox error={error} />
      {ok && <p className="text-sm text-green-700 dark:text-green-300">Mot de passe modifié.</p>}
      <input type="password" autoComplete="current-password" placeholder="Mot de passe actuel" value={form.currentPassword} onChange={set('currentPassword')} className={input} required />
      <input type="password" autoComplete="new-password" placeholder="Nouveau mot de passe" value={form.newPassword} onChange={set('newPassword')} className={input} required />
      <input type="password" autoComplete="new-password" placeholder="Confirmation" value={form.confirm} onChange={set('confirm')} className={input} required />
      <p className="text-xs text-gray-500">12 caractères minimum, avec au moins 3 types parmi minuscules, majuscules, chiffres et caractères spéciaux.</p>
      <button className={btnPrimary}>Changer le mot de passe</button>
    </form>
  );
}
