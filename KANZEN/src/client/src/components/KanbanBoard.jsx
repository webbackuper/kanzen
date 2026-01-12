import React, { useState, useEffect } from 'react';
import { DndContext, closestCorners, useSensor, useSensors, PointerSensor, KeyboardSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Column } from './Column';
import { io } from "socket.io-client";

// Singleton Socket connection
const socket = io('/', { autoConnect: false });

export function KanbanBoard({ token }) {
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchBoard = async () => {
    try {
      const res = await fetch('/api/board/default', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401) { localStorage.clear(); window.location.reload(); return; }
      const data = await res.json();
      setColumns(data.columns || []);
      setLoading(false);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (token) {
      fetchBoard();
      // Connexion Websocket
      socket.connect();
      socket.on("BOARD_UPDATED", () => {
        console.log("⚡ Mise à jour temps réel reçue !");
        fetchBoard(); // Rechargement silencieux des données
      });
    }
    return () => {
      socket.off("BOARD_UPDATED");
      socket.disconnect();
    };
  }, [token]);

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id;
    const fromColumnId = active.data.current?.columnId;
    const targetColumnId = over.id;

    if (fromColumnId === targetColumnId) return;

    // Optimiste : On pourrait update le state ici pour fluidité visuelle
    
    try {
      await fetch('/api/tasks/move', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ taskId, targetColumnId, fromColumnId })
      });
      // Le socket déclenchera le refresh, pas besoin de fetchBoard() manuel ici
    } catch (err) {
      console.error("Erreur sync", err);
    }
  };

  if (loading) return <div className="p-10 text-center dark:text-gray-300">Chargement...</div>;

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden p-6">
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="flex h-full gap-6 items-start">
          {columns.map((col) => (
            <Column key={col.id} column={col} tasks={col.tasks || []} token={token} />
          ))}
        </div>
      </DndContext>
    </div>
  );
}