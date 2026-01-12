import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TaskCard } from './TaskCard';

export function Column({ column, tasks, token }) {
  const { setNodeRef } = useDroppable({
    id: column.id,
  });

  return (
    <div ref={setNodeRef} className="flex flex-col w-80 shrink-0">
      {/* En-tête de la colonne */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="font-semibold text-gray-700 dark:text-gray-300 uppercase text-xs tracking-wider">
          {column.title}
        </h3>
        <span className="bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-full text-xs font-bold">
          {tasks.length}
        </span>
      </div>
      
      {/* Zone de contenu (Drop zone) */}
      <div className="flex-1 bg-gray-100/50 dark:bg-slate-800/50 rounded-xl p-3 border-2 border-dashed border-gray-200 dark:border-slate-700 overflow-y-auto min-h-[150px]">
        <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard 
              key={task.id} 
              task={task} 
              token={token} // Transmission du token ici
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}