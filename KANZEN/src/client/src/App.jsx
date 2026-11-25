import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Calendar, LogOut, Moon, Sun, Users, ScrollText, UserCog, Search, BookOpen } from 'lucide-react';
import { api, setUnauthorizedHandler } from './api';
import { Login, ChangePassword } from './components/Login';
import { Workspaces, WorkspacePage, WikiIndex } from './components/Workspaces';
import { KanbanBoard } from './components/KanbanBoard';
import { BoardStats } from './components/BoardStats';
import { CalendarView } from './components/CalendarView';
import { AdminUsers, AdminAudit } from './components/Admin';
// Wiki chargé à la demande (éditeur riche volumineux)
const wiki = () => import('./components/wiki/Wiki');
const WikiHome = lazy(() => wiki().then((m) => ({ default: m.WikiHome })));
const WikiPage = lazy(() => wiki().then((m) => ({ default: m.WikiPage })));
const WikiTrash = lazy(() => wiki().then((m) => ({ default: m.WikiTrash })));
const WikiSearch = lazy(() => wiki().then((m) => ({ default: m.WikiSearch })));
import { Loading, card } from './ui';

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <form role="search" className="hidden lg:block" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { navigate(`/search?q=${encodeURIComponent(q.trim())}`); setQ(''); } }}>
      <label className="relative block">
        <span className="sr-only">Rechercher dans le wiki</span>
        <Search size={14} className="absolute left-2.5 top-2 text-gray-400" />
        <input className="w-52 pl-8 pr-2 py-1 rounded-md text-sm bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          placeholder="Rechercher dans le wiki" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
      </label>
    </form>
  );
}

function NavBar({ user, onLogout, toggleTheme, isDark }) {
  // Le wiki d'un espace (/w/:id/wiki…), ses pages (/wiki/:id) et la recherche relèvent de l'onglet Wiki
  const inWiki = /^\/(wiki|search)(\/|$)|^\/w\/[^/]+\/wiki(\/|$)/.test(useLocation().pathname);
  const link = ({ isActive }) => `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${isActive
    ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400'
    : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'}`;
  return (
    <nav aria-label="Navigation principale" className="h-14 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between px-4 shrink-0">
      <NavLink to="/" className="flex items-center gap-2">
        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold">Z</div>
        <span className="text-lg font-bold text-gray-800 dark:text-white hidden sm:inline">KanZen</span>
      </NavLink>
      <div className="flex bg-gray-100 dark:bg-slate-800 p-1 rounded-lg gap-1">
        <NavLink to="/" end className={link} title="Espaces"><LayoutDashboard size={16} /> <span className="hidden md:inline">Espaces</span></NavLink>
        <NavLink to="/wiki" className={() => link({ isActive: inWiki })} title="Wiki"><BookOpen size={16} /> <span className="hidden md:inline">Wiki</span></NavLink>
        <NavLink to="/calendar" className={link} title="Agenda"><Calendar size={16} /> <span className="hidden md:inline">Agenda</span></NavLink>
        {user.role === 'ADMIN' && <>
          <NavLink to="/admin/users" className={link} title="Comptes"><Users size={16} /> <span className="hidden md:inline">Comptes</span></NavLink>
          <NavLink to="/admin/audit" className={link} title="Audit"><ScrollText size={16} /> <span className="hidden md:inline">Audit</span></NavLink>
        </>}
      </div>
      <div className="flex items-center gap-3">
        <GlobalSearch />
        <NavLink to="/search" className="lg:hidden text-gray-400" aria-label="Rechercher dans le wiki"><Search size={18} /></NavLink>
        <button onClick={toggleTheme} className="text-gray-400 hover:text-yellow-500" aria-label="Changer de thème">{isDark ? <Sun size={18} /> : <Moon size={18} />}</button>
        <NavLink to="/account" className="text-right hidden sm:block" title="Mon compte">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.displayName}</p>
          <p className="text-xs text-gray-500">{user.authSource === 'LDAP' ? 'Compte AD' : 'Compte local'}{user.role === 'ADMIN' ? ' · admin' : ''}</p>
        </NavLink>
        <NavLink to="/account" className="sm:hidden text-gray-400" aria-label="Mon compte"><UserCog size={18} /></NavLink>
        <button onClick={onLogout} className="text-gray-400 hover:text-red-600" aria-label="Se déconnecter"><LogOut size={18} /></button>
      </div>
    </nav>
  );
}

function Account({ user, onChanged }) {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className={`${card} p-6`}>
        <h2 className="text-xl font-semibold mb-1 text-gray-900 dark:text-white">Mon compte</h2>
        <p className="text-sm text-gray-500 mb-6">{user.username} · {user.authSource === 'LDAP' ? 'Active Directory' : 'compte local'}</p>
        {user.authSource === 'LOCAL'
          ? <ChangePassword onDone={onChanged} />
          : <p className="text-sm text-gray-600 dark:text-gray-300">Votre mot de passe est géré par l&apos;annuaire Active Directory (Ctrl+Alt+Suppr sous Windows).</p>}
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = chargement, null = déconnecté
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch { return false; }
  });

  const refresh = useCallback(() => api.get('/auth/me').then((r) => setUser(r.user), () => setUser(null)), []);
  useEffect(() => { setUnauthorizedHandler(() => setUser(null)); refresh(); }, [refresh]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch { /* stockage indisponible */ }
  }, [isDark]);

  const logout = async () => { await api.post('/auth/logout').catch(() => {}); setUser(null); };

  if (user === undefined) return <Loading />;
  if (!user) return <Login onLogin={setUser} />;
  if (user.mustChangePassword) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
        <div className={`${card} p-8`}>
          <h1 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Nouveau mot de passe</h1>
          <ChangePassword forced onDone={refresh} />
          <button onClick={logout} className="mt-4 text-sm text-gray-500 hover:underline">Se déconnecter</button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <div className="flex flex-col h-screen overflow-hidden bg-slate-50 dark:bg-slate-950">
        <NavBar user={user} onLogout={logout} toggleTheme={() => setIsDark(!isDark)} isDark={isDark} />
        <main className="flex-1 overflow-auto relative">
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Workspaces user={user} />} />
            <Route path="/w/:id" element={<WorkspacePage user={user} />} />
            <Route path="/b/:id" element={<KanbanBoard user={user} />} />
            <Route path="/b/:id/stats" element={<BoardStats />} />
            <Route path="/wiki" element={<WikiIndex />} />
            <Route path="/w/:id/wiki" element={<WikiHome />} />
            <Route path="/w/:id/wiki/trash" element={<WikiTrash />} />
            <Route path="/wiki/:id" element={<WikiPage user={user} />} />
            <Route path="/search" element={<WikiSearch />} />
            <Route path="/calendar" element={<CalendarView />} />
            <Route path="/account" element={<Account user={user} onChanged={refresh} />} />
            {user.role === 'ADMIN' && <Route path="/admin/users" element={<AdminUsers user={user} />} />}
            {user.role === 'ADMIN' && <Route path="/admin/audit" element={<AdminAudit />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </BrowserRouter>
  );
}
