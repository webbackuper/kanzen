import React, { useState, useEffect } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';

export function CalendarView({ token }) {
  const [tasks, setTasks] = useState([]);
  const [currentDate, setCurrentDate] = useState(new Date());

  useEffect(() => {
    // Récupération des tâches (on réutilise le endpoint board pour simplifier)
    fetch('/api/board/default', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        // Aplatir les colonnes pour avoir une liste de tâches
        const allTasks = data.columns?.flatMap(col => col.tasks) || [];
        setTasks(allTasks.filter(t => t.dueDate)); // Garder celles avec une date
      });
  }, [token]);

  // Génération de la grille du mois
  const days = eachDayOfInterval({
    start: startOfMonth(currentDate),
    end: endOfMonth(currentDate)
  });

  return (
    <div className="p-6 h-full flex flex-col max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white capitalize">
          {format(currentDate, 'MMMM yyyy', { locale: fr })}
        </h2>
      </div>

      <div className="grid grid-cols-7 gap-4 flex-1 overflow-y-auto">
        {/* En-têtes Jours */}
        {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map(d => (
          <div key={d} className="font-semibold text-center text-gray-500 dark:text-gray-400 py-2">{d}</div>
        ))}

        {/* Jours */}
        {days.map(day => {
          const dayTasks = tasks.filter(t => isSameDay(parseISO(t.dueDate), day));
          return (
            <div key={day.toString()} className="min-h-[120px] bg-white dark:bg-slate-800 rounded-xl border border-gray-100 dark:border-slate-700 p-3 hover:shadow-md transition-shadow">
              <div className="text-right text-sm text-gray-400 mb-2 font-mono">
                {format(day, 'd')}
              </div>
              
              <div className="flex flex-col gap-2">
                {dayTasks.map(task => (
                  <div key={task.id} className={`text-xs p-2 rounded border-l-4 truncate ${
                    task.color === 'red' ? 'border-red-500 bg-red-50 dark:bg-red-900/30' :
                    task.color === 'green' ? 'border-green-500 bg-green-50 dark:bg-green-900/30' :
                    'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30'
                  }`}>
                    {task.content}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}