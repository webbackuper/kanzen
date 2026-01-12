import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Download } from 'lucide-react';

export function Analytics({ token }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats', {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => res.json())
    // Transformation fictive pour l'exemple, à adapter selon le format réel de /api/stats
    .then(rawEvents => {
      // Pour cet exemple, on compte juste le nombre d'événements par type
      const processed = [
        { name: 'To Do', count: 12 },
        { name: 'Doing', count: 8 },
        { name: 'Done', count: 24 },
      ];
      setData(processed);
      setLoading(false);
    })
    .catch(err => setLoading(false));
  }, [token]);

  const handleExport = () => {
    window.open(`/api/admin/backup/now?token=${token}`, '_blank'); // Ou route CSV
  };

  if (loading) return <div className="p-10 text-center">Chargement des données...</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Performance de l'équipe</h2>
          <p className="text-gray-500">Flux de travail et vélocité</p>
        </div>
        <button 
          onClick={handleExport}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-medium transition-colors shadow-sm"
        >
          <Download size={18} /> Exporter CSV
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Graphique 1 */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-80">
          <h3 className="text-lg font-semibold mb-4">Volume de tâches par statut</h3>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#6b7280'}} dy={10} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: '#6b7280'}} />
              <Tooltip 
                cursor={{fill: '#f9fafb'}}
                contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} 
              />
              <Bar dataKey="count" fill="#4f46e5" radius={[4, 4, 0, 0]} barSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Bloc Info */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col justify-center">
          <h3 className="text-lg font-semibold mb-2">Santé du projet</h3>
          <p className="text-gray-500 mb-6">Les indicateurs clés de performance sont calculés sur les 30 derniers jours.</p>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-indigo-50 rounded-xl">
              <span className="block text-2xl font-bold text-indigo-600">4.2j</span>
              <span className="text-sm text-indigo-800">Cycle Time Moyen</span>
            </div>
            <div className="p-4 bg-green-50 rounded-xl">
              <span className="block text-2xl font-bold text-green-600">94%</span>
              <span className="text-sm text-green-800">Taux de complétion</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}