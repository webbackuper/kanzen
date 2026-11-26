-- Wiki v2 : accès restreint par page, favoris, pages consultées, liens wiki <-> tâches, page d'accueil.
-- Tout est additif : aucune donnée existante n'est modifiée.

-- AlterTable
ALTER TABLE "WikiPage" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "wikiHomePageId" UUID;

-- CreateTable
CREATE TABLE "WikiPageMember" (
    "pageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiPageMember_pkey" PRIMARY KEY ("pageId","userId")
);

-- CreateTable
CREATE TABLE "WikiFavorite" (
    "userId" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiFavorite_pkey" PRIMARY KEY ("userId","pageId")
);

-- CreateTable
CREATE TABLE "WikiView" (
    "userId" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiView_pkey" PRIMARY KEY ("userId","pageId")
);

-- CreateTable
CREATE TABLE "WikiTaskLink" (
    "pageId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WikiTaskLink_pkey" PRIMARY KEY ("pageId","taskId")
);

-- CreateIndex
CREATE INDEX "WikiPageMember_userId_idx" ON "WikiPageMember"("userId");

-- CreateIndex
CREATE INDEX "WikiFavorite_pageId_idx" ON "WikiFavorite"("pageId");

-- CreateIndex
CREATE INDEX "WikiView_userId_viewedAt_idx" ON "WikiView"("userId", "viewedAt");

-- CreateIndex
CREATE INDEX "WikiView_pageId_idx" ON "WikiView"("pageId");

-- CreateIndex
CREATE INDEX "WikiTaskLink_taskId_idx" ON "WikiTaskLink"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_wikiHomePageId_key" ON "Workspace"("wikiHomePageId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_wikiHomePageId_fkey" FOREIGN KEY ("wikiHomePageId") REFERENCES "WikiPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiPageMember" ADD CONSTRAINT "WikiPageMember_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiPageMember" ADD CONSTRAINT "WikiPageMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiFavorite" ADD CONSTRAINT "WikiFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiFavorite" ADD CONSTRAINT "WikiFavorite_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiView" ADD CONSTRAINT "WikiView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiView" ADD CONSTRAINT "WikiView_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiTaskLink" ADD CONSTRAINT "WikiTaskLink_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiTaskLink" ADD CONSTRAINT "WikiTaskLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiTaskLink" ADD CONSTRAINT "WikiTaskLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

