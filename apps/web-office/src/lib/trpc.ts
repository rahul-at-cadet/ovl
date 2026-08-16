import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from 'api-office/src/rpc/trpc.router';

export const trpc = createTRPCReact<AppRouter>();
