import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { KanbanBoard } from './components/KanbanBoard';
import { Analytics } from './components/Analytics';
import { CalendarView } from './components/CalendarView'; // NOUVEAU
import { Login } from './components/Login';
import { LayoutDashboard, BarChart3, Calendar, LogOut, Moon, Sun } from 'lucide-react';

function NavBar({ user, onLogout, toggleTheme, isDark }) {
  const location = useLocation();
  const linkClass = (path) => 
    `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${location.pathname === path 
      ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400' 
      : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'}`;

  return (
    <nav className="h-16 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between px-6 shrink-0 transition-colors">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold">Z</div>
        <h1 className="text-xl font-bold tracking-tight text-gray-800 dark:text-white">KanZen</h1>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex bg-gray-100 dark:bg-slate-800 p-1 rounded-lg">
          <Link to="/" className={linkClass('/')}>
            <LayoutDashboard size={16} /> Board
          </Link>
          <Link to="/calendar" className={linkClass('/calendar')}>
            <Calendar size={16} /> Agenda
          </Link>
          {user.role === 'ADMIN' && (
            <Link to="/analytics" className={linkClass('/analytics')}>
              <BarChart3 size={16} /> Analytics
            </Link>
          )}
        </div>

        <div className="flex items-center gap-4 pl-6 border-l dark:border-slate-700">
          <button onClick={toggleTheme} className="text-gray-400 hover:text-yellow-500 transition-colors">
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.name}</p>
            <p className="text-xs text-gray-500">{user.role}</p>
          </div>
          <button onClick={onLogout} className="text-gray-400 hover:text-red-600 transition-colors">
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </nav>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('KanZen_token');
    const storedUser = localStorage.getItem('KanZen_user');
    if (token && storedUser) setUser(JSON.parse(storedUser));
    
    // Check Dark Mode Pref
    if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      setIsDark(true);
      document.documentElement.classList.add('dark');
    }
  }, []);

  const toggleTheme = () => {
    if (isDark) {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
      setIsDark(false);
    } else {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
      setIsDark(true);
    }
  };

  const handleLogin = (userData, token) => {
    localStorage.setItem('KanZen_token', token);
    localStorage.setItem('KanZen_user', JSON.stringify(userData));
    setUser(userData);
  };

  const handleLogout = () => {
    localStorage.removeItem('KanZen_token');
    localStorage.removeItem('KanZen_user');
    setUser(null);
  };

  if (!user) return <Login onLogin={handleLogin} />;

  return (
    <BrowserRouter>
      <div className="flex flex-col h-screen overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors">
        <NavBar user={user} onLogout={handleLogout} toggleTheme={toggleTheme} isDark={isDark} />
        <main className="flex-1 overflow-hidden relative">
          <Routes>
            <Route path="/" element={<KanbanBoard token={localStorage.getItem('KanZen_token')} />} />
            <Route path="/calendar" element={<CalendarView token={localStorage.getItem('KanZen_token')} />} />
            <Route path="/analytics" element={<Analytics token={localStorage.getItem('KanZen_token')} />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}