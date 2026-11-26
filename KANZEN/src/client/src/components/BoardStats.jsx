import { Link, useParams } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LineChart, Line } from 'recharts';
import { api } from '../api';
import { ErrorBox, Loading, useApi, card } from '../ui';

function Tile({ label, value }) {
  return <div className={`${card} p-4`}><p className="text-xs text-gray-500">{label}</p><p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p></div>;
}

export function BoardStats() {
  const { id } = useParams();
  const { data, error } = useApi(() => api.get(`/boards/${id}/stats?days=30`), [id]);
  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const total = data.columns.reduce((s, c) => s + c.count, 0);
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <Link to={`/b/${id}`} className="text-sm text-gray-500 hover:underline">← Tableau</Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Statistiques (30 jours)</h1>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Tile label="Tâches" value={total} />
        <Tile label="Déplacements" value={data.moves} />
        <Tile label="En retard" value={data.overdue} />
      </div>
      <div className={`${card} p-4 h-72`}>
        <h2 className="text-sm font-semibold mb-2 dark:text-gray-200">Répartition par colonne</h2>
        <ResponsiveContainer width="100%" height="90%">
          <BarChart data={data.columns}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="title" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="count" name="Tâches" fill="#6366f1" radius={[4, 4, 0, 0]} /></BarChart>
        </ResponsiveContainer>
      </div>
      <div className={`${card} p-4 h-72`}>
        <h2 className="text-sm font-semibold mb-2 dark:text-gray-200">Tâches terminées par jour (dernière colonne)</h2>
        {data.completedPerDay.length === 0 ? <p className="text-sm text-gray-500">Aucune tâche terminée sur la période.</p> : (
          <ResponsiveContainer width="100%" height="90%">
            <LineChart data={data.completedPerDay}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" /><YAxis allowDecimals={false} /><Tooltip /><Line dataKey="count" name="Terminées" stroke="#10b981" strokeWidth={2} /></LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
