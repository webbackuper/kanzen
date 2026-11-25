-- Index composites alignés sur les requêtes réelles (docs/06-plan-optimisation.md, T7).
-- Sur une base volumineuse, ces index peuvent être créés à l'avance avec CREATE INDEX CONCURRENTLY
-- (voir docs/03-packaging.md, « Migrations d'index sur une grosse base »).

-- Chargement d'un tableau : cartes d'une colonne triées par position (remplace l'index columnId seul)
CREATE INDEX IF NOT EXISTS "Task_columnId_position_idx" ON "Task"("columnId", "position");
DROP INDEX IF EXISTS "Task_columnId_idx";

-- Fil de commentaires d'une tâche, trié par date (remplace l'index taskId seul)
CREATE INDEX IF NOT EXISTS "Comment_taskId_createdAt_idx" ON "Comment"("taskId", "createdAt");
DROP INDEX IF EXISTS "Comment_taskId_idx";

-- Statistiques : arrivées dans une colonne sur une période
CREATE INDEX IF NOT EXISTS "TaskEvent_toColumnId_timestamp_idx" ON "TaskEvent"("toColumnId", "timestamp");
