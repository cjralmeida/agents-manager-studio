/*
  Warnings:

  - You are about to drop the `render_connections` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "render_connections" DROP CONSTRAINT "render_connections_workspace_id_fkey";

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "render_account_id" UUID;

-- DropTable
DROP TABLE "render_connections";

-- CreateTable
CREATE TABLE "render_accounts" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "api_key_hint" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "render_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_settings_render_account_id_idx" ON "workspace_settings"("render_account_id");

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_render_account_id_fkey" FOREIGN KEY ("render_account_id") REFERENCES "render_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
