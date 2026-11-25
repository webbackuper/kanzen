import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { fr } from 'date-fns/locale';
import { api } from '../api';
import { ErrorBox, useApi, btnGhost } from '../ui';

const BORDER = { red: 'border-red-500', green: 'border-green-500', yellow: 'border-yellow-500', orange: 'border-orange-500', purple: 'border-purple-500', blue: 'border-blue-500', gray: 'border-gray-400' };

export function CalendarView() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  // Grille du lundi précédant le 1er au dimanche suivant le dernier jour
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const key = format(month, 'yyyy-MM');
  const { data, error } = useApi(() => api.get(`/calendar?from=${format(from, 'yyyy-MM-dd')}&to=${format(to, 'yyyy-MM-dd')}`), [key]);
  const tasks = data?.tasks ?? [];

  return (
    <div className="p-6 h-full flex flex-col max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white capitalize">{format(month, 'MMMM yyyy', { locale: fr })}</h1>
        <div className="flex gap-1">
          <button className={btnGhost} onClick={() => setMonth(addMonths(month, -1))} aria-label="Mois précédent"><ChevronLeft size={16} /></button>
          <button className={btnGhost} onClick={() => setMonth(startOfMonth(new Date()))}>Aujourd&apos;hui</button>
          <button className={btnGhost} onClick={() => setMonth(addMonths(month, 1))} aria-label="Mois suivant"><ChevronRight size={16} /></button>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="grid grid-cols-7 gap-2 flex-1 overflow-y-auto">
        {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => <div key={d} className="font-semibold text-center text-gray-500 dark:text-gray-400 py-1 text-sm">{d}</div>)}
        {eachDayOfInterval({ start: from, end: to }).map((day) => {
          const dayTasks = tasks.filter((t) => isSameDay(parseISO(t.dueDate), day));
          return (
            <div key={day.toISOString()} className={`min-h-[100px] rounded-lg border p-2 ${isSameMonth(day, month) ? 'bg-white dark:bg-slate-800' : 'bg-gray-50 dark:bg-slate-900 opacity-60'} ${isToday(day) ? 'border-indigo-500' : 'border-gray-100 dark:border-slate-700'}`}>
              <div className="text-right text-xs text-gray-400 mb-1 font-mono">{format(day, 'd')}</div>
              <div className="flex flex-col gap-1">
                {dayTasks.map((t) => (
                  <Link key={t.id} to={`/b/${t.column.board.id}`} title={`${t.column.board.title} · ${t.column.title}`}
                    className={`text-xs p-1.5 rounded border-l-4 truncate bg-indigo-50 dark:bg-indigo-900/30 dark:text-gray-200 ${BORDER[t.color] ?? 'border-indigo-500'}`}>
                    {t.title}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
