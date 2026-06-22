import { z } from 'zod';
import { createModuleLogger } from '../utils/logger.js';
const logger = createModuleLogger('validate');

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }));
      logger.warn('[Validate] Validation failed', {
        path: req.path,
        errors: errors.map(e => `${e.field}: ${e.message}`)
      });
      return res.status(400).json({ error: 'Validation failed', errors });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errors = result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }));
      return res.status(400).json({ error: 'Validation failed', errors });
    }
    req.query = result.data;
    next();
  };
}

export const schemas = {
  setupFirstAdmin: z.object({
    username: z.string().trim().min(3, 'Username must be at least 3 characters').max(50),
    full_name: z.string().trim().min(1).max(100),
    password: z.string().min(12, 'Password must be at least 12 characters')
  }),

  login: z.object({
    username: z.string().trim().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required')
  }),

  userCreate: z.object({
    username: z.string().trim().min(3).max(50),
    full_name: z.string().trim().min(1).max(100),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    role: z.enum(['admin', 'speaker', 'manager', 'hero_admin'])
  }),

  dbImport: z.object({
    confirmPassword: z.string().min(1, 'Password confirmation is required')
  }),

  dbImportQuery: z.object({
    dryRun: z.enum(['true', 'false']).optional(),
    dry_run: z.enum(['true', 'false']).optional()
  }).optional(),

  changeRole: z.object({
    role: z.enum(['admin', 'manager', 'speaker', 'hero_admin'])
  }),

  resetPassword: z.object({
    new_password: z.string().min(8, 'Password must be at least 8 characters')
  }),

  toggleUser: z.object({
    is_active: z.union([z.boolean(), z.number()])
  }),

  contentRoot: z.object({
    path: z.string().trim().min(1, 'Path is required')
  }),

  walCheckpoint: z.object({
    force: z.boolean().optional()
  }).optional(),

  cleanupMissing: z.object({
    deviceId: z.string().optional()
  }).optional(),

  cleanupOrphaned: z.object({
    dryRun: z.boolean().optional(),
    excludeExtensions: z.array(z.string()).optional()
  }).optional()
};
