import { Injectable } from '@nestjs/common';
import { initTRPC } from '@trpc/server';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

const t = initTRPC.create();

const PingSchema = Type.Object({ vesselId: Type.String() });
const PingCompiler = TypeCompiler.Compile(PingSchema);

const PushEventsSchema = Type.Array(
  Type.Object({
    id: Type.String(),
    eventType: Type.String(),
    payload: Type.String(),
    createdAt: Type.String(),
    processedAt: Type.Union([Type.String(), Type.Null()]),
  })
);
const PushEventsCompiler = TypeCompiler.Compile(PushEventsSchema);

const PullConfigInputSchema = Type.Object({
  lastSyncAt: Type.Optional(Type.String()),
});
const PullConfigInputCompiler = TypeCompiler.Compile(PullConfigInputSchema);

export const publicProcedure = t.procedure;
export const router = t.router;

@Injectable()
export class TrpcRouter {
  appRouter = router({
    ping: publicProcedure
      .input((val: unknown) => {
        if (!PingCompiler.Check(val)) throw new Error('Invalid input');
        return val as Static<typeof PingSchema>;
      })
      .query(({ input }) => {
        return {
          message: `Pong received from Office API for vessel ${input.vesselId}`,
          timestamp: new Date().toISOString(),
        };
      }),

    sync: router({
      pushEvents: publicProcedure
        .input((val: unknown) => {
          if (!PushEventsCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PushEventsSchema>;
        })
        .mutation(({ input }) => {
          // Here the Office API would process and save the events to Postgres
          console.log(`Office received ${input.length} events from vessel`);
          
          return {
            success: true,
            processedCount: input.length,
          };
        }),

      pullConfig: publicProcedure
        .input((val: unknown) => {
          if (!PullConfigInputCompiler.Check(val)) throw new Error('Invalid input');
          return val as Static<typeof PullConfigInputSchema>;
        })
        .query(({ input }) => {
          console.log(`Vessel requested config updates since: ${input.lastSyncAt || 'beginning of time'}`);
          
          // Here the Office API would query Postgres for any configs updated after `lastSyncAt`
          // For now, return a mock payload
          return {
            configs: [
              {
                key: 'FEATURE_FLAGS',
                value: JSON.stringify({ enableNewDashboard: true }),
                updatedAt: new Date().toISOString(),
              },
              {
                key: 'GLOBAL_SETTINGS',
                value: JSON.stringify({ maxSpeedKnots: 24 }),
                updatedAt: new Date().toISOString(),
              }
            ],
            syncedAt: new Date().toISOString(),
          };
        }),
    }),
  });
}

export type AppRouter = TrpcRouter['appRouter'];
