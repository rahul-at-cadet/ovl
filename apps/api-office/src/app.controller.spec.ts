import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthGuard } from './auth/auth.guard';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    })
      // The controller's `me` route is behind AuthGuard, which injects
      // SupertokensService. Nest resolves guards while compiling the module,
      // so without this the whole module fails to build and even the
      // unauthenticated root route can't be tested. Overriding keeps this
      // spec about the controller rather than about session verification.
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('me', () => {
    it('never returns the password hash', () => {
      const user = {
        id: 'u-1',
        username: 'someone@example.com',
        passwordHash: 'argon2-hash-that-must-not-leak',
        roles: ['viewer'],
      } as any;

      const result = appController.getMe(user) as Record<string, unknown>;

      expect(result).not.toHaveProperty('passwordHash');
      expect(result.username).toBe('someone@example.com');
    });
  });
});
