-- Internal HMAC signatures are valid for a bounded clock window.  Persist a
-- one-time nonce so a captured valid request cannot be replayed within that
-- window, across API processes, or after a restart.
CREATE TABLE "internal_request_nonces" (
    "id" SERIAL NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_request_nonces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_request_nonces_nonce_key"
    ON "internal_request_nonces"("nonce");
CREATE INDEX "internal_request_nonces_expires_at_idx"
    ON "internal_request_nonces"("expires_at");
