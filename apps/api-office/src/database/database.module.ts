import { Module, Global } from '@nestjs/common';
import { createDbConnection } from '@ovl/database';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error('DATABASE_URL environment variable is not defined');
        }
        return createDbConnection(connectionString);
      },
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DatabaseModule {}
