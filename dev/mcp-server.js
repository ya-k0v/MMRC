import fs from 'node:fs';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { ROOT } from '../src/config/constants.js';

const log = (msg) => process.stderr.write(`[MCP] ${msg}\n`);

let db = null;
let fastGlob = null;

async function ensureGlob() {
  if (!fastGlob) fastGlob = await import('fast-glob');
  return fastGlob.default || fastGlob;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_db_schema',
    description: 'Get full database schema: tables, columns, types, foreign keys, indexes',
    inputSchema: {
      type: 'object',
      properties: {
        includeData: { type: 'boolean', description: 'Include row counts per table (slower)', default: false }
      }
    }
  },
  {
    name: 'get_routes',
    description: 'List all API routes with methods, paths, and middleware summary'
  },
  {
    name: 'get_modules',
    description: 'List all modules with enabled status, roles, and descriptions'
  },
  {
    name: 'get_project_structure',
    description: 'Project file tree with import dependency analysis per file',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'number', description: 'Directory depth limit (default: 3)', default: 3 },
        includeImports: { type: 'boolean', description: 'Show import statements per file (default: false)', default: false }
      }
    }
  },
  {
    name: 'get_logs',
    description: 'Read service logs with optional level/module filter',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'Log level: combined|error|warn|info|debug', enum: ['combined', 'error', 'warn', 'info', 'debug'], default: 'combined' },
        module: { type: 'string', description: 'Filter by module name (auth, device, file, socket, security, api, stream, system, db, video, convert, hero, http, resolver, etc.)', default: '' },
        lines: { type: 'number', description: 'Number of lines (max 2000)', default: 100 }
      }
    }
  }
];

// ── Tool implementations ────────────────────────────────────────────────────

async function getDbSchema(args) {
  if (!db) return { content: [{ type: 'text', text: 'Database not available (MCP server running outside main process; connect via separate DB tool if needed)' }] };

  const tables = await db.query(
    db.dialect === 'postgres'
      ? "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
      : "SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  const schema = [];

  for (const { table_name } of tables) {
    const cols = await db.columns(table_name);
    let foreignKeys = [];
    let indexes = [];

    try {
      if (db.dialect === 'sqlite') {
        const pragma = await db.query(`PRAGMA foreign_key_list("${table_name}")`);
        foreignKeys = pragma.map(fk => ({
          column: fk.from,
          references: `${fk.table}(${fk.to})`,
          onDelete: fk.on_delete,
          onUpdate: fk.on_update
        }));
        const idxList = await db.query(`PRAGMA index_list("${table_name}")`);
        for (const idx of idxList) {
          const idxInfo = await db.query(`PRAGMA index_info("${idx.name}")`);
          indexes.push({ name: idx.name, unique: !!idx.unique, columns: idxInfo.map(i => i.name) });
        }
      } else {
        const fks = await db.query(`
          SELECT kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
          FROM information_schema.key_column_usage kcu
          JOIN information_schema.constraint_column_usage ccu ON kcu.constraint_name = ccu.constraint_name
          WHERE kcu.table_name = $1 AND kcu.constraint_catalog = CURRENT_CATALOG
        `, [table_name]);
        foreignKeys = fks.map(fk => ({ column: fk.column_name, references: `${fk.foreign_table_name}(${fk.foreign_column_name})` }));
      }
    } catch { /* ignore introspection errors */ }

    let rowCount = null;
    if (args?.includeData) {
      try {
        const row = await db.get(`SELECT COUNT(*) AS cnt FROM "${table_name}"`);
        rowCount = row?.cnt ?? null;
      } catch { /* ignore */ }
    }

    schema.push({
      table: table_name,
      columns: cols.map(c => ({
        name: c.name,
        type: c.type,
        nullable: !c.notNull,
        default: c.defaultValue ?? null
      })),
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
      indexes: indexes.length > 0 ? indexes : undefined,
      rowCount
    });
  }

  return { content: [{ type: 'text', text: JSON.stringify({ dialect: db.dialect, tables: schema }, null, 2) }] };
}

async function getRoutes() {
  const routesDir = path.join(ROOT, 'src', 'routes');
  const files = await readdir(routesDir);
  const routeFiles = files.filter(f => f.endsWith('.js'));

  const routes = [];
  for (const file of routeFiles.sort()) {
    const content = await readFile(path.join(routesDir, file), 'utf-8');
    const methods = content.match(/(?:router|app)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]/g) || [];
    const parsed = methods.map(m => {
      const match = m.match(/\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]/);
      if (!match) return null;
      const [_, method, route] = match;
      const lineNum = content.substring(0, content.indexOf(m)).split('\n').length;
      return { method: method.toUpperCase(), path: route, line: lineNum };
    }).filter(Boolean);

    const auths = [];
    if (content.includes('requireAdmin')) auths.push('admin');
    if (content.includes('requireAuth')) auths.push('auth');
    if (content.includes('requireSpeaker')) auths.push('speaker');
    if (content.includes('requireHeroAdmin')) auths.push('hero_admin');
    if (content.includes('requireManager')) auths.push('manager');

    if (parsed.length > 0) {
      routes.push({ file, mountPoint: inferMountPoint(file), routes: parsed, auth: auths.length > 0 ? auths : undefined });
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(routes, null, 2) }] };
}

function inferMountPoint(file) {
  const map = {
    'auth.js': '/api/auth',
    'devices.js': '/api/devices',
    'files.js': '/api/devices',
    'folders.js': '/api/devices',
    'video-info.js': '/api/devices',
    'conversion.js': '/api/devices',
    'placeholder.js': '/api/devices',
    'volume.js': '/api/devices',
    'deduplication.js': '/api/devices',
    'admin.js': '/api/admin',
    'modules.js': '/api/admin/modules',
    'system-info.js': '/api/system',
    'notifications.js': '/api/notifications',
    'file-resolver.js': '/api/files'
  };
  return map[file] || '/api';
}

async function getModules() {
  const { getAvailableModules, getEnabledModules } = await import('./modules/index.js');
  const all = getAvailableModules();
  const enabled = await getEnabledModules();

  // also read modules table directly if db is available
  let dbModules = [];
  if (db) {
    try {
      dbModules = await db.query('SELECT id, enabled FROM modules ORDER BY id');
    } catch { /* table might not exist */ }
  }

  const result = all.map(m => {
    const dbMod = dbModules.find(d => d.id === m.id);
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: dbMod ? !!dbMod.enabled : enabled.includes(m.id),
      roles: m.roles || [],
      roleLabels: m.roleLabels || {}
    };
  });

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function getProjectStructure(args) {
  const maxDepth = Math.min(args?.depth ?? 3, 5);
  const showImports = args?.includeImports ?? false;

  const fg = await ensureGlob();

  // src directory tree
  const srcFiles = await fg(['src/**/*.js', 'src/**/*.sql', 'src/**/*.json', 'src/**/*.css', 'src/**/*.html'], {
    cwd: ROOT,
    ignore: ['**/node_modules/**']
  });

  const tree = buildTree(srcFiles.map(f => path.normalize(f)), maxDepth);

  // Get imports for each file
  const fileImports = {};
  if (showImports) {
    for (const file of srcFiles) {
      if (!file.endsWith('.js')) continue;
      try {
        const content = await readFile(path.join(ROOT, file), 'utf-8');
        const imports = [];
        const importRe = /import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRe.exec(content)) !== null) {
          imports.push(match[1]);
        }
        if (imports.length > 0) fileImports[file] = imports;
      } catch { /* ignore */ }
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ tree, fileImports: showImports ? fileImports : undefined }, null, 2)
    }]
  };
}

function buildTree(files, maxDepth) {
  const root = { _type: 'dir', children: {} };

  for (const file of files) {
    const parts = file.split('/');
    let current = root;
    for (let i = 0; i < Math.min(parts.length, maxDepth); i++) {
      const part = parts[i];
      if (i === parts.length - 1 && i < maxDepth) {
        // file
        if (!current.children[part]) {
          current.children[part] = { _type: 'file' };
        }
      } else {
        if (!current.children[part]) {
          current.children[part] = { _type: 'dir', children: {} };
        }
        current = current.children[part];
        if (current._type === 'file') break;
      }
    }
  }

  return serializeTree(root, 'src', maxDepth);
}

function serializeTree(node, name, maxDepth, depth = 0) {
  if (depth >= maxDepth && node._type === 'dir') {
    const fileCount = countFiles(node);
    return { name, type: 'dir', fileCount };
  }
  if (node._type === 'file') return { name, type: 'file' };

  const children = Object.entries(node.children)
    .filter(([_, v]) => v)
    .sort(([a], [b]) => {
      const aIsDir = node.children[a]._type === 'dir';
      const bIsDir = node.children[b]._type === 'dir';
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    })
    .map(([childName, childNode]) => serializeTree(childNode, childName, maxDepth, depth + 1));

  return { name, type: 'dir', children };
}

function countFiles(node) {
  if (node._type === 'file') return 1;
  return Object.values(node.children || {}).reduce((sum, child) => sum + countFiles(child), 0);
}

async function getLogs(args) {
  const { getLogsDir } = await import('./config/settings-manager.js');
  const logsDir = getLogsDir();
  const level = args?.level || 'combined';
  const moduleFilter = args?.module || '';
  const maxLines = Math.min(args?.lines || 200, 2000);

  const logFile = path.join(logsDir, `${level}-${new Date().toISOString().slice(0, 10)}.log`);

  if (!fs.existsSync(logFile)) {
    return { content: [{ type: 'text', text: `No ${level} log file found for today` }] };
  }

  const content = await readFile(logFile, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  let filtered = lines;
  if (moduleFilter) {
    const modLower = moduleFilter.toLowerCase();
    filtered = lines.filter(line => {
      try {
        const parsed = JSON.parse(line);
        return parsed.module === modLower;
      } catch {
        // non-JSON line, check bracket prefix
        const match = line.match(/^\[(\w+)\]/);
        if (match) return match[1].toLowerCase() === modLower;
        return false;
      }
    });
  }

  const tail = filtered.slice(-maxLines);

  return { content: [{ type: 'text', text: tail.join('\n') || '(empty)' }] };
}

// ── MCP Protocol over stdio ────────────────────────────────────────────────

function sendMessage(msg) {
  const str = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(str, 'utf-8')}\r\n\r\n`;
  process.stdout.write(header + str);
}

let buffer = '';

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const id = msg.id;
  const method = msg.method;

  if (method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = msg.params?.name;
    const args = msg.params?.arguments || {};
    const tool = TOOLS.find(t => t.name === toolName);

    if (!tool) {
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      });
      return;
    }

    const handlers = { get_db_schema: getDbSchema, get_routes: getRoutes, get_modules: getModules, get_project_structure: getProjectStructure, get_logs: getLogs };

    handlers[toolName](args).then(result => {
      sendMessage({ jsonrpc: '2.0', id, result });
    }).catch(err => {
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message }
      });
    });
    return;
  }

  if (method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mmrc-mcp', version: '3.3.0' }
      }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
}

function onStdinData(chunk) {
  buffer += chunk.toString();
  const parts = buffer.split('\r\n\r\n');
  while (parts.length > 1) {
    const header = parts.shift();
    const content = parts.shift();
    buffer = parts.join('\r\n\r\n');

    const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch || !content) continue;

    const expectedLen = parseInt(lenMatch[1], 10);
    if (content.length < expectedLen) {
      buffer = header + '\r\n\r\n' + content;
      break;
    }

    const json = content.substring(0, expectedLen);
    const remaining = content.substring(expectedLen);
    if (remaining) buffer = remaining;

    handleLine(json);
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const { initDatabase } = await import('./database/database.js');
    await initDatabase();
    db = await import('./database/database.js').then(m => m.getDatabase());
  } catch (err) {
    log(`Database not available: ${err.message}`);
  }

  log('MMRC MCP server ready (stdio transport)');
  process.stdin.on('data', onStdinData);
  process.stdin.on('end', () => process.exit(0));
}

init().catch(err => {
  log(`Init error: ${err.message}`);
  process.stdin.on('data', onStdinData);
  process.stdin.on('end', () => process.exit(0));
});
