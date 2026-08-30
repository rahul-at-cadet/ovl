import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { TrpcService } from './rpc/trpc.service';

/**
 * This spec previously asserted `getHello()` returned the string
 * "Hello World!" — the untouched Nest scaffold. The controller had since been
 * rewritten to inject TrpcService and return a shore ping, so the test failed
 * on dependency resolution and, had it resolved, would have asserted the wrong
 * shape anyway. It now covers what the route actually does.
 */
describe('AppController', () => {
  let appController: AppController;
  const pingResponse = { message: 'Pong received from Office API', timestamp: '2026-01-01T00:00:00Z' };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: TrpcService,
          useValue: { client: { ping: { query: async () => pingResponse } } },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('identifies itself and passes the office ping through', async () => {
      const result = await appController.getHello();

      expect(result.message).toBe('Hello from Vessel API!');
      expect(result.officePingResponse).toEqual(pingResponse);
    });
  });
});
