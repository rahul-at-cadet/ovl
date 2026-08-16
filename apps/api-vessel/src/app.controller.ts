import { Controller, Get } from '@nestjs/common';
import { TrpcService } from './rpc/trpc.service';

@Controller()
export class AppController {
  constructor(private readonly trpc: TrpcService) {}

  @Get()
  async getHello() {
    // Ping the Office API via tRPC
    const response = await this.trpc.client.ping.query({
      vesselId: 'vessel-123',
    });

    return {
      message: 'Hello from Vessel API!',
      officePingResponse: response,
    };
  }
}
