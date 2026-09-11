-- AlterTable
ALTER TABLE "ticket_groups" ADD COLUMN "formConfig" JSONB;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "customFieldValues" JSONB;
