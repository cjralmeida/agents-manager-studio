-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "pixellab_account_id" UUID;

-- CreateTable
CREATE TABLE "pixellab_accounts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pixellab_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pixellab_accounts_owner_id_idx" ON "pixellab_accounts"("owner_id");

-- CreateIndex
CREATE INDEX "workspace_settings_pixellab_account_id_idx" ON "workspace_settings"("pixellab_account_id");

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_pixellab_account_id_fkey" FOREIGN KEY ("pixellab_account_id") REFERENCES "pixellab_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pixellab_accounts" ADD CONSTRAINT "pixellab_accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

