-- CreateEnum
CREATE TYPE "TicketExportTarget" AS ENUM ('notion', 'google_sheets');

-- AlterTable
ALTER TABLE "ticket_groups" ADD COLUMN "exportConfig" JSONB;

-- CreateTable
CREATE TABLE "ticket_export_jobs" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "target" "TicketExportTarget" NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_export_jobs_sentAt_idx" ON "ticket_export_jobs"("sentAt");

-- CreateIndex
CREATE INDEX "ticket_export_jobs_target_createdAt_idx" ON "ticket_export_jobs"("target", "createdAt");

-- CreateIndex
CREATE INDEX "ticket_export_jobs_groupId_target_createdAt_idx" ON "ticket_export_jobs"("groupId", "target", "createdAt");

-- AddForeignKey
ALTER TABLE "ticket_export_jobs" ADD CONSTRAINT "ticket_export_jobs_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_export_jobs" ADD CONSTRAINT "ticket_export_jobs_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ticket_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
