import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageSquare, Paperclip, CalendarClock, CheckSquare } from 'lucide-react';
import { format } from 'date-fns';

export function TaskCard({ task, token }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { columnId: task.columnId }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const colorMap = {
    white: 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700',
    blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
    red: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    yellow: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
  };

  // Calcul progression sous-tâches
  const subtasks = task.subtasks || [];
  const completedCount = subtasks.filter(s => s.completed).length;
  const progress = subtasks.length > 0 ? Math.round((completedCount / subtasks.length) * 100) : 0;

  // Gestion rapide d'une sous-tâche (ex: clic pour toggle)
  const handleToggleSubtask = async (e, subId) => {
    e.stopPropagation(); // Empêche le drag
    // Appel API optimiste
    await fetch(`/api/subtasks/${subId}/toggle`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
    });
    // Le socket mettra à jour l'UI globalement
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`group p-4 mb-3 rounded-lg border shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-all ${colorMap[task.color] || colorMap.white}`}
    >
      <div className="flex justify-between items-start mb-2">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug">{task.content}</p>
        {task.dueDate && (
          <span className="text-[10px] bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200 px-1.5 py-0.5 rounded flex items-center gap-1">
            <CalendarClock size={10} /> {format(new Date(task.dueDate), 'dd MMM')}
          </span>
        )}
      </div>

      {/* Barre de progression Subtasks */}
      {subtasks.length > 0 && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span className="flex items-center gap-1"><CheckSquare size={10}/> {completedCount}/{subtasks.length}</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
            <div className="bg-indigo-500 h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }}></div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50">
        <div className="flex items-center gap-3">
          {task.attachments?.length > 0 && (
            <div className="flex items-center text-xs text-gray-400 gap-1">
              <Paperclip size={12} /> <span>{task.attachments.length}</span>
            </div>
          )}
          <div className="flex items-center text-xs text-gray-400 gap-1">
            <MessageSquare size={12} /> <span>{task.comments?.length || 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}