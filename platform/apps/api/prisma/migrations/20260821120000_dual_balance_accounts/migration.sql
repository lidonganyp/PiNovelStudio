-- 双余额账户：充值余额（balance，真实）+ 赠送余额（bonus_balance，虚拟）
-- 用户决策：存量余额全部归为赠送余额（均为测试期 psql 直充额度，无真实支付流水）。
-- 扣款归因：novel_generation_call 记录每笔费用从两个账户各扣多少，
--           平台收入页据此区分真实消耗与虚拟消耗。

-- AlterTable
ALTER TABLE "users" ADD COLUMN "bonus_balance" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "novel_generation_call"
    ADD COLUMN "charge_from_real" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "charge_from_bonus" BIGINT NOT NULL DEFAULT 0;

-- 存量数据迁移：余额全部转入赠送余额，充值余额清零
UPDATE "users" SET "bonus_balance" = "balance", "balance" = 0;

-- 存量调用（当前为 0 行，防御性回填）：全部归因到虚拟消耗
UPDATE "novel_generation_call" SET "charge_from_bonus" = "actual_charge";
