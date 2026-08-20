/**
 * 管理端充值订单列表。
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PaymentService } from './payment.service';

@Controller('admin/payment/orders')
@UseGuards(AdminGuard)
export class PaymentAdminController {
  constructor(private readonly payment: PaymentService) {}

  @Get()
  list(@Query() query: PaginationDto): Promise<unknown> {
    return this.payment.listOrders(query.page ?? 1, query.pageSize ?? 20);
  }
}
