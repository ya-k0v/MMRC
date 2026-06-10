import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { generateAccessToken, generateRefreshToken } from '../../src/middleware/auth.js';

describe('generateAccessToken', () => {
  it('generates a valid JWT with correct payload', () => {
    const token = generateAccessToken(1, 'admin', 'admin');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    expect(decoded.userId).toBe(1);
    expect(decoded.username).toBe('admin');
    expect(decoded.role).toBe('admin');
    expect(decoded.type).toBe('access');
  });

  it('generates a token with an expiration', () => {
    const token = generateAccessToken(1, 'admin', 'admin');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
  });
});

describe('generateRefreshToken', () => {
  it('generates a valid refresh JWT', () => {
    const token = generateRefreshToken(1);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    expect(decoded.userId).toBe(1);
    expect(decoded.type).toBe('refresh');
  });
});

describe('requireAuth middleware', () => {
  let requireAuth;

  beforeAll(async () => {
    const mod = await import('../../src/middleware/auth.js');
    requireAuth = mod.requireAuth;
  });

  it('returns 401 if no Authorization header', () => {
    const req = { headers: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Токен не предоставлен' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 if header does not start with Bearer', () => {
    const req = { headers: { authorization: 'Basic xyz' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 if token is invalid', () => {
    const req = { headers: { authorization: 'Bearer invalid-token' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches decoded user and calls next for valid token', () => {
    const token = generateAccessToken(1, 'admin', 'admin');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe(1);
    expect(req.user.role).toBe('admin');
    expect(next).toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  let requireRole, requireAdmin;

  beforeAll(async () => {
    const mod = await import('../../src/middleware/auth.js');
    requireRole = mod.requireRole;
    requireAdmin = mod.requireAdmin;
  });

  it('returns an array of two middleware functions', () => {
    const middlewares = requireRole('admin');
    expect(Array.isArray(middlewares)).toBe(true);
    expect(middlewares).toHaveLength(2);
  });

  it('returns 401 if no user on request (checkRole)', () => {
    const [, checkRole] = requireRole('admin');
    const req = {};
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    checkRole(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 if user role is not allowed', () => {
    const [, checkRole] = requireRole('admin');
    const req = { user: { role: 'speaker' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    checkRole(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next if user role is allowed', () => {
    const [, checkRole] = requireRole('admin', 'speaker');
    const req = { user: { role: 'speaker' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    checkRole(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('requireAdmin is requireRole("admin")', () => {
    expect(requireAdmin).toHaveLength(2);
  });
});
