import { Module } from '@nestjs/common';
import { TrpcRouter } from './trpc.router';

@Module({
  providers: [TrpcRouter],
  exports: [TrpcRouter],
})
export class TrpcModule {}
