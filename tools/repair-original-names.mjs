#!/usr/bin/env node
/**
 * Разовая починка имён файлов в files_metadata.
 *
 * Имена приходили из multipart в latin1, поэтому в original_name попадало
 * мусорное «Ð°Ð·Ð°Ð±Ð¾ÐºÐ¸». Запись теперь нормализуется в
 * src/database/files-metadata.js, но уже сохранённые строки нужно починить
 * отдельно — иначе они останутся в UI до конца жизни записи.
 *
 * По умолчанию ничего не меняет: только показывает, что будет исправлено.
 * Запись включается флагом --apply.
 *
 * Использование:
 *   node tools/repair-original-names.mjs            # сухой прогон
 *   node tools/repair-original-names.mjs --apply    # применить
 */

import fs from 'node:fs';
import path from 'node:path';
import { fixEncoding } from '../src/utils/encoding.js';

const APPLY = process.argv.includes('--apply');

const DATA_DIR = process.env.MMRC_DATA_DIR || '/app/data';
const DB_PATH = path.join(DATA_DIR, 'db', 'main.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`БД не найдена: ${DB_PATH}`);
  console.error('Укажите путь через MMRC_DATA_DIR, например:');
  console.error('  MMRC_DATA_DIR=/var/lib/mmrc/data node tools/repair-original-names.mjs');
  process.exit(1);
}

let Database;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch {
  console.error('Не удалось загрузить better-sqlite3. Запустите скрипт в окружении,');
  console.error('где установлены зависимости проекта (в контейнере — /app).');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const rows = db
  .prepare('SELECT id, device_id, safe_name, original_name FROM files_metadata')
  .all();

// Мусором считаем строку, которую fixEncoding реально меняет. Отбор по
// одному fixEncoding безопаснее, чем эвристика «есть Ð/Ñ»: он не тронет
// ни корректную кириллицу, ни ASCII, ни имена с латинской диакритикой.
const broken = [];
for (const row of rows) {
  const fixed = fixEncoding(row.original_name);
  if (typeof fixed === 'string' && fixed !== row.original_name) {
    broken.push({ ...row, fixed });
  }
}

console.log(`БД:            ${DB_PATH}`);
console.log(`Всего записей: ${rows.length}`);
console.log(`К починке:     ${broken.length}`);
console.log(`Режим:         ${APPLY ? 'ЗАПИСАТЬ' : 'сухой прогон (ничего не меняется)'}`);
console.log('');

if (!broken.length) {
  console.log('Испорченных имён не найдено — нечего чинить.');
  db.close();
  process.exit(0);
}

const LIMIT = 25;
for (const row of broken.slice(0, LIMIT)) {
  console.log(`  [${row.device_id}/${row.safe_name}]`);
  console.log(`    было:  ${row.original_name}`);
  console.log(`    станет: ${row.fixed}`);
}
if (broken.length > LIMIT) {
  console.log(`  ... и ещё ${broken.length - LIMIT}`);
}
console.log('');

// Страховка от потери данных: откладываем дамп записи до изменения.
const BACKUP_PATH = `${DB_PATH}.bak-original-names`;
let backupWritten = false;
const writeBackup = () => {
  if (backupWritten || !APPLY) return;
  fs.copyFileSync(DB_PATH, BACKUP_PATH);
  backupWritten = true;
  console.log(`Резервная копия: ${BACKUP_PATH}`);
};

if (!APPLY) {
  console.log('Это был сухой прогон. Для применения повторите с --apply.');
  db.close();
  process.exit(0);
}

writeBackup();

const update = db.prepare(
  'UPDATE files_metadata SET original_name = ? WHERE id = ?'
);

const apply = db.transaction((items) => {
  for (const row of items) {
    update.run(row.fixed, row.id);
  }
});

try {
  apply(broken);
} catch (error) {
  console.error(`Не удалось применить правки: ${error.message}`);
  console.error(`Данные не изменены, резервная копия: ${BACKUP_PATH}`);
  db.close();
  process.exit(1);
}

console.log(`Исправлено записей: ${broken.length}`);
db.close();