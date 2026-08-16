import { Injectable, OnModuleInit, Inject } from '@nestjs/common';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from 'api-office/src/rpc/trpc.router';
import { DATABASE_CONNECTION } from '../database/database.module';
import { eq } from 'drizzle-orm';
import * as schema from '@ovl/vessel-database';

@Injectable()
export class TrpcService implements OnModuleInit {
  public client!: ReturnType<typeof createTRPCProxyClient<AppRouter>>;

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: any, 
  ) {}

  onModuleInit() {
    this.client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: process.env.OFFICE_API_URL || 'http://localhost:3000/trpc',
          headers: async () => {
            const result = await this.db.select().from(schema.configStore).where(eq(schema.configStore.key, 'api_key'));
            const apiKey = result.length > 0 ? result[0].value : '';
            return {
              Authorization: `Bearer ${apiKey}`,
            };
          },
        }),
      ],
    });
  }
}
