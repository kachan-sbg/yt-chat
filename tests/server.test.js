// Jest hoists jest.mock() calls before any imports/requires.
// googleapis and config are mocked so server.js can be required without
// real credentials or network access.

jest.mock('googleapis', () => {
  const mockOAuth2 = {
    credentials: {},
    setCredentials: jest.fn(),
    generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock'),
    getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'tok', refresh_token: 'rtok' } }),
    on: jest.fn(),
  };
  return {
    google: {
      youtube: jest.fn().mockReturnValue({
        liveBroadcasts: {
          list: jest.fn().mockResolvedValue({ data: { items: [] } }),
        },
        liveChatMessages: {
          list: jest.fn().mockResolvedValue({
            data: { items: [], nextPageToken: null, pollingIntervalMillis: 10_000 },
          }),
        },
      }),
      auth: { OAuth2: jest.fn().mockReturnValue(mockOAuth2) },
    },
  };
});

jest.mock('../config', () => ({
  CLIENT_ID: 'test-client-id',
  CLIENT_SECRET: 'test-secret',
  PORT: 0,
  POLL_INTERVAL_MS: 10_000,
  SCHEDULED_POLL_INTERVAL_MS: 60_000,
  DAILY_QUOTA_LIMIT: 10_000,
  AUTO_CONNECT_RETRY_MS: 30_000,
  MAX_MESSAGES_ON_SCREEN: 80,
  HISTORY_SIZE: 50,
  TOKEN_FILE: 'tokens.test.json',
  SCOPES: ['https://www.googleapis.com/auth/youtube.readonly'],
  REDIRECT_URI: 'http://localhost:3456/auth/callback',
}));

const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const SETTINGS_PATH = path.join(__dirname, '..', 'settings.json');

beforeEach(() => {
  try { fs.unlinkSync(SETTINGS_PATH); } catch {}
});

afterAll(() => {
  try { fs.unlinkSync(SETTINGS_PATH); } catch {}
});

const { app } = require('../server');

// ── /api/status ───────────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  test('returns 200 with correct shape', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authorized: expect.any(Boolean),
      connected:  false,
      searching:  false,
      polling:    false,
      videoId:    null,
      clients:    0,
      quota: {
        used:      expect.any(Number),
        limit:     10_000,
        remaining: expect.any(Number),
        stats:     expect.any(Object),
      },
    });
  });

  test('quota: used + remaining === limit', async () => {
    const { body: { quota } } = await request(app).get('/api/status');
    expect(quota.used + quota.remaining).toBe(quota.limit);
  });
});

// ── /api/auth/status ──────────────────────────────────────────────────────────

describe('GET /api/auth/status', () => {
  test('returns authorized: false when no tokens loaded', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
  });
});

// ── Auth-protected endpoints ──────────────────────────────────────────────────

describe('Auth-protected endpoints return 401 without credentials', () => {
  test('GET /api/connect', async () => {
    const res = await request(app).get('/api/connect');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  test('GET /api/messages', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(401);
  });

  test('GET /api/history', async () => {
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(401);
  });
});

// ── /api/disconnect ───────────────────────────────────────────────────────────

describe('GET /api/disconnect', () => {
  test('returns { ok: true }', async () => {
    const res = await request(app).get('/api/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('status shows idle state after disconnect', async () => {
    await request(app).get('/api/disconnect');
    const { body } = await request(app).get('/api/status');
    expect(body.connected).toBe(false);
    expect(body.searching).toBe(false);
    expect(body.polling).toBe(false);
    expect(body.videoId).toBeNull();
  });
});

// ── /auth/start ───────────────────────────────────────────────────────────────

describe('GET /auth/start', () => {
  test('redirects to Google OAuth', async () => {
    const res = await request(app).get('/auth/start').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });
});

// ── /api/settings ─────────────────────────────────────────────────────────────

describe('Settings API', () => {
  test('GET returns hardcoded defaults when no file exists', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opacity: 0.08, blur: 3, fontSize: 'normal' });
  });

  test('POST → GET round-trip preserves values', async () => {
    const payload = { opacity: 0.5, blur: 10, fontSize: 'large' };
    await request(app).post('/api/settings').send(payload).expect(200);
    const { body } = await request(app).get('/api/settings');
    expect(body).toMatchObject(payload);
  });

  test('POST merges into existing settings (partial update)', async () => {
    await request(app).post('/api/settings').send({ opacity: 0.5, blur: 8, fontSize: 'large' });
    await request(app).post('/api/settings').send({ opacity: 0.2 });

    const { body } = await request(app).get('/api/settings');
    expect(body.opacity).toBe(0.2);
    expect(body.blur).toBe(8);         // must survive partial update
    expect(body.fontSize).toBe('large'); // must survive partial update
  });

  test('profiles are isolated — writing obs does not affect streamer', async () => {
    await request(app).post('/api/settings?profile=obs').send({ opacity: 0.1, blur: 2 });
    await request(app).post('/api/settings?profile=streamer').send({ opacity: 0.9, blur: 0 });

    const obs      = await request(app).get('/api/settings?profile=obs');
    const streamer = await request(app).get('/api/settings?profile=streamer');

    expect(obs.body.opacity).toBe(0.1);
    expect(streamer.body.opacity).toBe(0.9);
  });

  test('unknown profile returns defaults', async () => {
    const res = await request(app).get('/api/settings?profile=nonexistent');
    expect(res.body).toEqual({ opacity: 0.08, blur: 3, fontSize: 'normal' });
  });

  test('migrates old flat-format settings.json to default profile', async () => {
    // Old format: a plain object without profile keys
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ opacity: 0.25, blur: 5, fontSize: 'small' }));

    const res = await request(app).get('/api/settings');
    expect(res.body.opacity).toBe(0.25);
    expect(res.body.blur).toBe(5);
    expect(res.body.fontSize).toBe('small');
  });

  test('migrated old format does not bleed into named profiles', async () => {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ opacity: 0.25, blur: 5, fontSize: 'small' }));

    // Named profile should still get defaults, not the migrated values
    const res = await request(app).get('/api/settings?profile=obs');
    expect(res.body).toEqual({ opacity: 0.08, blur: 3, fontSize: 'normal' });
  });
});

// ── Stream live detection ─────────────────────────────────────────────────────

describe('Stream live detection', () => {
  let mockYoutube, mockOAuth2;

  beforeAll(() => {
    const { google } = jest.requireMock('googleapis');
    mockYoutube = google.youtube();
    mockOAuth2  = new google.auth.OAuth2();
  });

  beforeEach(async () => {
    await request(app).get('/api/disconnect');
    mockOAuth2.credentials = { access_token: 'fake-token' };
  });

  afterEach(async () => {
    await request(app).get('/api/disconnect');
    mockOAuth2.credentials = {};
    // Restore default: no items found
    mockYoutube.liveBroadcasts.list.mockResolvedValue({ data: { items: [] } });
  });

  test('/api/status includes streamLive: false initially', async () => {
    const { body } = await request(app).get('/api/status');
    expect(body.streamLive).toBe(false);
  });

  test('connecting to an active broadcast sets streamLive: true', async () => {
    mockYoutube.liveBroadcasts.list.mockResolvedValueOnce({
      data: { items: [{ id: 'vid1', snippet: { liveChatId: 'chat1' } }] },
    });

    const res = await request(app).get('/api/connect');
    expect(res.status).toBe(200);

    const { body } = await request(app).get('/api/status');
    expect(body.streamLive).toBe(true);
    expect(body.connected).toBe(true);
  });

  test('connecting to an upcoming (scheduled) broadcast sets streamLive: false', async () => {
    // First call (active query) returns empty, second (upcoming query) returns item
    mockYoutube.liveBroadcasts.list
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [{ id: 'vid2', snippet: { liveChatId: 'chat2' } }] } });

    const res = await request(app).get('/api/connect');
    expect(res.status).toBe(200);

    const { body } = await request(app).get('/api/status');
    expect(body.streamLive).toBe(false);
    expect(body.connected).toBe(true);
  });

  test('disconnect resets streamLive to false', async () => {
    mockYoutube.liveBroadcasts.list.mockResolvedValueOnce({
      data: { items: [{ id: 'vid1', snippet: { liveChatId: 'chat1' } }] },
    });
    await request(app).get('/api/connect');

    await request(app).get('/api/disconnect');
    const { body } = await request(app).get('/api/status');
    expect(body.streamLive).toBe(false);
    expect(body.connected).toBe(false);
  });
});
