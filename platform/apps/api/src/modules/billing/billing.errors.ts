/**
 * 计费领域 HTTP 异常：402 余额不足 / 超预占。
 */
import { HttpException, HttpStatus } from '@nestjs/common';

/** 可用余额不足，无法创建预占。 */
export class InsufficientBalanceException extends HttpException {
  constructor(message = '可用余额不足') {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        message,
        reason: 'insufficient_balance',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/** 单次结算将超过 hold.amount。 */
export class HoldExhaustedException extends HttpException {
  constructor(message = '超出预占上限') {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        message,
        reason: 'reserved_budget_exhausted',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
