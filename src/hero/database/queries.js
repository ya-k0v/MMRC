import { getHeroDb, setHeroDb } from './hero-db.js';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

let driverOverride = null;

export function setHeroDriver(db) {
  driverOverride = db;
}

async function getDb() {
  if (driverOverride) return driverOverride;
  return getHeroDb();
}

export const heroQueries = {
  async getAll() {
    const db = await getDb();
    const heroes = await db.query('SELECT * FROM heroes ORDER BY full_name');
    if (heroes.length === 0) return heroes;
    const ids = heroes.map(h => h.id);
    const placeholders = ids.map(() => '?').join(',');
    const allMedia = await db.query(`SELECT * FROM hero_media WHERE hero_id IN (${placeholders}) ORDER BY hero_id, order_index`, ids);
    const mediaByHero = groupMediaByHeroId(allMedia);
    for (const hero of heroes) {
      hero.media = (mediaByHero[hero.id] || []).map(normalizeMedia);
    }
    return heroes;
  },

  async getById(id) {
    const db = await getDb();
    const hero = await db.get('SELECT * FROM heroes WHERE id = ?', [id]);
    if (hero) {
      const mediaRows = await db.query('SELECT * FROM hero_media WHERE hero_id = ? ORDER BY order_index', [id]);
      hero.media = mediaRows.map(normalizeMedia);
    }
    return hero;
  },

  async search(query) {
    const normalizeString = (str) => {
      if (!str) return '';
      return String(str).trim().toLowerCase().replace(/ё/g, 'е');
    };

    const db = await getDb();
    const allHeroes = await db.query('SELECT * FROM heroes ORDER BY full_name');
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) return [];

    const filtered = allHeroes
      .filter(hero => normalizeString(hero.full_name || '').startsWith(normalizedQuery))
      .slice(0, 10);

    if (filtered.length > 0) {
      const ids = filtered.map(h => h.id);
      const placeholders = ids.map(() => '?').join(',');
      const allMedia = await db.query(`SELECT * FROM hero_media WHERE hero_id IN (${placeholders}) ORDER BY hero_id, order_index`, ids);
      const mediaByHero = groupMediaByHeroId(allMedia);
      for (const hero of filtered) {
        hero.media = (mediaByHero[hero.id] || []).map(normalizeMedia);
      }
    }
    return filtered;
  },

  async create(data) {
    if (!data || typeof data !== 'object') throw new Error('Data must be an object');
    if (!data.full_name || typeof data.full_name !== 'string') throw new Error('full_name is required and must be a string');
    const trimmedName = data.full_name.trim();
    if (trimmedName.length === 0) throw new Error('full_name cannot be empty');
    if (trimmedName.length > 200) throw new Error('full_name is too long (max 200 characters)');
    if (data.rank && data.rank.length > 100) throw new Error('rank is too long (max 100 characters)');
    if (data.biography && data.biography.length > 1024 * 1024) throw new Error('biography is too long (max 1MB)');

    const db = await getDb();
    const result = await db.run(
      'INSERT INTO heroes (full_name, birth_year, death_year, rank, photo_base64, biography) VALUES (?, ?, ?, ?, ?, ?)',
      [trimmedName, data.birth_year || null, data.death_year || null, data.rank || null, data.photo_base64 || null, data.biography || null]
    );
    return result.lastInsertRowid;
  },

  async update(id, data) {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid hero id: must be a positive integer');
    if (!data || typeof data !== 'object') throw new Error('Data must be an object');

    const db = await getDb();
    const current = await db.get('SELECT * FROM heroes WHERE id = ?', [id]);
    if (!current) throw new Error(`Hero with id ${id} not found`);

    let full_name = current.full_name;
    if (hasOwn(data, 'full_name')) {
      if (!data.full_name || typeof data.full_name !== 'string') throw new Error('full_name must be a non-empty string');
      const trimmed = data.full_name.trim();
      if (trimmed.length === 0) throw new Error('full_name cannot be empty');
      if (trimmed.length > 200) throw new Error('full_name is too long');
      full_name = trimmed;
    }

    const birth_year = hasOwn(data, 'birth_year') ? (data.birth_year ?? null) : current.birth_year;
    const death_year = hasOwn(data, 'death_year') ? (data.death_year ?? null) : current.death_year;
    const rank = hasOwn(data, 'rank') ? (data.rank ?? null) : current.rank;
    const photo_base64 = hasOwn(data, 'photo_base64') ? (data.photo_base64 ?? null) : current.photo_base64;
    const biography = hasOwn(data, 'biography') ? (data.biography ?? null) : current.biography;

    if (rank && rank.length > 100) throw new Error('rank is too long');
    if (biography && biography.length > 1024 * 1024) throw new Error('biography is too long');

    await db.run(
      'UPDATE heroes SET full_name = ?, birth_year = ?, death_year = ?, rank = ?, photo_base64 = ?, biography = ? WHERE id = ?',
      [full_name, birth_year, death_year, rank, photo_base64, biography, id]
    );
  },

  async delete(id) {
    const db = await getDb();
    await db.run('DELETE FROM heroes WHERE id = ?', [id]);
  },

  async addMedia(heroId, media) {
    if (!media.type || !media.media_base64) throw new Error('Type and media_base64 are required');
    const db = await getDb();
    const result = await db.run(
      'INSERT INTO hero_media (hero_id, type, media_base64, caption, order_index) VALUES (?, ?, ?, ?, ?)',
      [heroId, media.type, media.media_base64, media.caption || null, media.order_index || 0]
    );
    return result.lastInsertRowid;
  },

  async deleteMedia(mediaId) {
    const db = await getDb();
    await db.run('DELETE FROM hero_media WHERE id = ?', [mediaId]);
  },

  async deleteMediaByHero(heroId) {
    const db = await getDb();
    await db.run('DELETE FROM hero_media WHERE hero_id = ?', [heroId]);
  },

  async updateWithMedia(id, data, validateMediaItem) {
    const db = await getDb();
    await db.transaction(async (tx) => {
      const d = tx || db;
      await d.run(
        'UPDATE heroes SET full_name = ?, birth_year = ?, death_year = ?, rank = ?, photo_base64 = ?, biography = ? WHERE id = ?',
        [data.full_name, data.birth_year || null, data.death_year || null, data.rank || null, data.photo_base64 || null, data.biography || null, id]
      );
      if (Array.isArray(data.media)) {
        await d.run('DELETE FROM hero_media WHERE hero_id = ?', [id]);
        for (const item of data.media) {
          if (validateMediaItem) validateMediaItem(item);
          await d.run(
            'INSERT INTO hero_media (hero_id, type, media_base64, caption, order_index) VALUES (?, ?, ?, ?, ?)',
            [id, item.type || 'photo', item.media_base64, item.caption || '', item.order_index || 0]
          );
        }
      }
    });
  }
};

function groupMediaByHeroId(rows) {
  const map = Object.create(null);
  for (const row of rows) {
    const hid = row.hero_id;
    if (!map[hid]) map[hid] = [];
    map[hid].push(row);
  }
  return map;
}

function normalizeMedia(row) {
  const type = row.type || (row.media_type === 'image' ? 'photo' : row.media_type || 'photo');
  const media_base64 = row.media_base64 || row.url || '';
  const caption = row.caption || row.title || row.description || null;
  return {
    id: row.id,
    hero_id: row.hero_id,
    type,
    media_base64,
    caption,
    order_index: row.order_index || 0,
    created_at: row.created_at
  };
}
