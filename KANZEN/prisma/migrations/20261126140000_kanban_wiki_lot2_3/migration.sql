-- Lots 2 et 3 Kanban : estimation, champs personnalisés, dépendances entre cartes.

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'CHECKBOX');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "estimate" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "BoardField" (
    "id" UUID NOT NULL,
    "boardId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "BoardField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskFieldValue" (
    "taskId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "TaskFieldValue_pkey" PRIMARY KEY ("taskId","fieldId")
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateIndex
CREATE INDEX "BoardField_boardId_idx" ON "BoardField"("boardId");

-- CreateIndex
CREATE INDEX "TaskFieldValue_fieldId_idx" ON "TaskFieldValue"("fieldId");

-- CreateIndex
CREATE INDEX "TaskDependency_blockedId_idx" ON "TaskDependency"("blockedId");

-- AddForeignKey
ALTER TABLE "BoardField" ADD CONSTRAINT "BoardField_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFieldValue" ADD CONSTRAINT "TaskFieldValue_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFieldValue" ADD CONSTRAINT "TaskFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "BoardField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

