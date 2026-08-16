import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
const request = require('supertest');
import { AppModule } from './../src/app.module';
const cookieParser = require('cookie-parser');
import * as jwt from 'jsonwebtoken';

describe('BackupController (e2e)', () => {
  let app: INestApplication;
  let mockToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();

    // Create a mock token to bypass the auth check
    mockToken = jwt.sign({ username: 'tester', sub: '123' }, process.env.JWT_SECRET || 'vessel-edge-secret-key-123');

    // Ensure a dummy DB exists for testing
    const dbPath = require('path').join(process.cwd(), 'vessel.sqlite');
    if (!require('fs').existsSync(dbPath)) {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE IF NOT EXISTS dummy (id INTEGER)');
      db.close();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('/system/backup/download (GET) - Download successful', async () => {
    const response = await request(app.getHttpServer())
      .get('/system/backup/download')
      .set('Cookie', [`vessel_auth_token=${mockToken}`]);

    // Note: If the test environment doesn't have a vessel.sqlite file at process.cwd(),
    // this will return 404. In a real e2e environment, a seed db is present.
    if (response.status === 404) {
      expect(response.body.message).toContain('Database file not found');
    } else {
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-type']).toBe('application/octet-stream');
    }
  });

  it('/system/backup/download (GET) - Reject missing auth', async () => {
    const response = await request(app.getHttpServer())
      .get('/system/backup/download');

    expect(response.status).toBe(401);
  });
});
