import { Injectable, OnModuleInit } from '@nestjs/common';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from 'api-office/src/rpc/trpc.router';

@Injectable()
export class TrpcService implements OnModuleInit {
  public client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;

  onModuleInit() {
    this.client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          // In production, this would be the actual Office API URL
          url: process.env.OFFICE_API_URL || 'http://localhost:3000/trpc',
        }),
      ],
    });
  }
}
