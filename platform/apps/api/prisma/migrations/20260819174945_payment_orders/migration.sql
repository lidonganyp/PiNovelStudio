-- CreateTable
CREATE TABLE "payment_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "external_trade_no" TEXT,
    "qr_content" TEXT NOT NULL DEFAULT '',
    "pay_url" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_order_no_key" ON "payment_orders"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_external_trade_no_key" ON "payment_orders"("external_trade_no");

-- CreateIndex
CREATE INDEX "payment_orders_user_id_created_at_idx" ON "payment_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_status_idx" ON "payment_orders"("status");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
