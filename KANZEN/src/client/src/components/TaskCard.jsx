import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageSquare, Paperclip, CalendarClock, CheckSquare } from 'lucide-react';
import { format, isPast } from 'date-fns';
import { fr } from 'date-fns/locale';

export const COLORS = {
  white: 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700',
  blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
  green: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
  red: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
  yellow: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
  orange: 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800',
  purple: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',
  gray: 'bg-gray-100 dark:bg-slate-700/40 border-gray-300 dark:border-slate-600',
};

export const initials = (name) => (name.match(/\p{L}+/gu) ?? ['?']).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

/** Pastilles des assignés, superposées (4 visibles au plus). */
export function Avatars({ users, max = 4 }) {
  if (!users.length) return null;
  const shown = users.slice(0, max);
  return (
    <span className="flex -space-x-1.5" title={users.map((u) => u.displayName).join(', ')}>
      {shown.map((u) => (
        <span key={u.id} className="w-6 h-6 rounded-full ring-2 ring-white dark:ring-slate-800 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-200 flex items-center justify-center text-[10px] font-bold">
          {initials(u.displayName)}
        </span>
      ))}
      {users.length > max && (
        <span className="w-6 h-6 rounded-full ring-2 ring-white dark:ring-slate-800 bg-gray-200 dark:bg-slate-600 text-gray-700 dark:text-gray-200 flex items-center justify-center text-[10px] font-bold">+{users.length - max}</span>
      )}
    </span>
  );
}

export function TaskCard({ task, onOpen, disabled, done: inDoneColumn = false }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id, data: { type: 'task', columnId: task.columnId }, disabled,
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const subtasks = task.subtasks ?? [];
  const done = subtasks.filter((s) => s.completed).length;
  const progress = subtasks.length ? Math.round((done / subtasks.length) * 100) : 0;
  // Pas de badge « en retard » dans la dernière colonne (terminé) : même règle que les statistiques du serveur
  const late = !inDoneColumn && task.dueDate && isPast(new Date(task.dueDate));

  return (
    <div
      ref={setNodeRef} style={style} {...attributes} {...listeners}
      onClick={() => onOpen(task.id)}
      // Entrée ouvre la carte ; Espace la déplace (capteur clavier de dnd-kit, cf. KanbanBoard)
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(task.id); } }}
      aria-label={`${task.title}${task.dueDate ? `, échéance ${format(new Date(task.dueDate), 'd MMMM', { locale: fr })}${late ? ', en retard' : ''}` : ''}${task.assignees?.length ? `, assignée à ${task.assignees.map((u) => u.displayName).join(', ')}` : ''}`}
      className={`p-3 mb-2 rounded-lg border shadow-sm hover:shadow-md transition-shadow ${disabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${COLORS[task.color] ?? COLORS.white}`}
    >
      <div className="flex justify-between items-start gap-2 mb-1">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug break-words">{task.title}</p>
        {task.dueDate && (
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${late ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-gray-300'}`}>
            <CalendarClock size={10} /> {format(new Date(task.dueDate), 'dd MMM', { locale: fr })}
          </span>
        )}
      </div>
      {subtasks.length > 0 && (
        <div className="my-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span className="flex items-center gap-1"><CheckSquare size={10} /> {done}/{subtasks.length}</span><span>{progress}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5"><div className="bg-indigo-500 h-1.5 rounded-full" style={{ width: `${progress}%` }} /></div>
        </div>
      )}
      <div className="flex items-center justify-between mt-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex gap-3">
          {task._count?.attachments > 0 && <span className="flex items-center gap-1"><Paperclip size={12} /> {task._count.attachments}</span>}
          {task._count?.comments > 0 && <span className="flex items-center gap-1"><MessageSquare size={12} /> {task._count.comments}</span>}
        </span>
        <Avatars users={task.assignees ?? []} />
      </div>
    </div>
  );
}
