-- CreateTable
CREATE TABLE "model_providers" (
    "id" SERIAL NOT NULL,
    "provider_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_base_url" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_rates" (
    "id" SERIAL NOT NULL,
    "model_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "provider_id" INTEGER NOT NULL,
    "input_price_per_million" BIGINT NOT NULL,
    "output_price_per_million" BIGINT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_balance_hold" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "settled_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "progress_stage" TEXT,
    "progress_detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMP(3),

    CONSTRAINT "novel_balance_hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_generation_call" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "hold_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "internal_stage" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL,
    "tokens_out" INTEGER NOT NULL,
    "rate_snapshot" JSONB NOT NULL,
    "actual_charge" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_generation_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_billing_adjustment" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "admin_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_billing_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_provider_key_key" ON "model_providers"("provider_key");

-- CreateIndex
CREATE INDEX "model_rates_model_key_effective_from_idx" ON "model_rates"("model_key", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "novel_balance_hold_job_id_key" ON "novel_balance_hold"("job_id");

-- CreateIndex
CREATE INDEX "novel_balance_hold_user_id_status_idx" ON "novel_balance_hold"("user_id", "status");

-- CreateIndex
CREATE INDEX "novel_generation_call_user_id_created_at_idx" ON "novel_generation_call"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "novel_generation_call_job_id_call_id_key" ON "novel_generation_call"("job_id", "call_id");

-- CreateIndex
CREATE INDEX "novel_billing_adjustment_user_id_created_at_idx" ON "novel_billing_adjustment"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "model_rates" ADD CONSTRAINT "model_rates_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_balance_hold" ADD CONSTRAINT "novel_balance_hold_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_generation_call" ADD CONSTRAINT "novel_generation_call_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "novel_balance_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_billing_adjustment" ADD CONSTRAINT "novel_billing_adjustment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_billing_adjustment" ADD CONSTRAINT "novel_billing_adjustment_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
