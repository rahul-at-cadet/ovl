import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
const request = require('supertest');
import { AppModule } from './../src/app.module';
import * as path from 'path';
import * as fs from 'fs';
const cookieParser = require('cookie-parser');
import * as jwt from 'jsonwebtoken';

describe('AttachmentsController (e2e)', () => {
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('/reports/:reportId/attachments (POST) - Upload successful', async () => {
    // Create a dummy file for testing
    const testFilePath = path.join(__dirname, 'test-file.txt');
    fs.writeFileSync(testFilePath, 'Hello, this is a test attachment.');

    const response = await request(app.getHttpServer())
      .post('/reports/test-report-id/attachments')
      .set('Cookie', [`vessel_auth_token=${mockToken}`])
      .attach('file', testFilePath);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.filename).toBe('test-file.txt');
    
    // Clean up
    fs.unlinkSync(testFilePath);
  });

  it('/reports/:reportId/attachments (POST) - Reject missing file', async () => {
    const response = await request(app.getHttpServer())
      .post('/reports/test-report-id/attachments')
      .set('Cookie', [`vessel_auth_token=${mockToken}`]);

    expect(response.status).toBe(400); // Bad Request
  });
});
