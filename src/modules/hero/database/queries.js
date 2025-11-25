import { heroDb } from './hero-db.js';

export const heroQueries = {
  getAll() {
    const heroes = heroDb.prepare('SELECT * FROM heroes ORDER BY full_name').all();
    // Добавляем медиа для каждого героя и нормализуем
    return heroes.map(hero => {
      const mediaRows = heroDb
        .prepare('SELECT * FROM hero_media WHERE hero_id = ? ORDER BY order_index')
        .all(hero.id);
      
      if (mediaRows.length > 0) {
        hero.media = mediaRows.map(row => {
          const type = row.type || (row.media_type === 'image' ? 'photo' : row.media_type || 'photo');
          const media_base64 = row.media_base64 || row.url || '';
          const caption = row.caption || row.title || row.description || null;
          
          return {
            id: row.id,
            hero_id: row.hero_id,
            type: type,
            media_base64: media_base64,
            caption: caption,
            order_index: row.order_index || 0,
            created_at: row.created_at
          };
        });
      } else {
        hero.media = [];
      }
      
      return hero;
    });
  },

  getById(id) {
    const hero = heroDb.prepare('SELECT * FROM heroes WHERE id = ?').get(id);
    if (hero) {
      const mediaRows = heroDb
        .prepare('SELECT * FROM hero_media WHERE hero_id = ? ORDER BY order_index')
        .all(id);
      
      // Нормализуем данные медиа, используя новые колонки или преобразуя старые
      hero.media = mediaRows.map(row => {
        // Используем новую колонку type, если она есть, иначе преобразуем из media_type
        const type = row.type || (row.media_type === 'image' ? 'photo' : row.media_type || 'photo');
        
        // Используем новую колонку media_base64, если она есть, иначе из url
        const media_base64 = row.media_base64 || row.url || '';
        
        // Используем новую колонку caption, если она есть, иначе из title или description
        const caption = row.caption || row.title || row.description || null;
        
        return {
          id: row.id,
          hero_id: row.hero_id,
          type: type,
          media_base64: media_base64,
          caption: caption,
          order_index: row.order_index || 0,
          created_at: row.created_at
        };
      });
    }
    return hero;
  },

  search(query) {
    // Регистронезависимый поиск с кириллицей
    // В SQLite LOWER() не работает с кириллицей, поэтому используем альтернативный подход
    // Получаем все записи и фильтруем в JavaScript (это нормально для небольшого количества записей)
    const allHeroes = heroDb.prepare('SELECT * FROM heroes ORDER BY full_name').all();
    
    // Приводим запрос к нижнему регистру для регистронезависимого сравнения
    const queryLower = query.toLowerCase();
    
    // Фильтруем в JavaScript с учетом регистра
    const filtered = allHeroes
      .filter(hero => {
        const nameLower = (hero.full_name || '').toLowerCase();
        return nameLower.includes(queryLower);
      })
      .slice(0, 10); // Ограничиваем до 10 результатов
    
    // Загружаем медиа для каждого найденного героя
    return filtered.map(hero => {
      const mediaRows = heroDb
        .prepare('SELECT * FROM hero_media WHERE hero_id = ? ORDER BY order_index')
        .all(hero.id);
      
      // Нормализуем данные медиа
      hero.media = mediaRows.map(row => {
        const type = row.type || (row.media_type === 'image' ? 'photo' : row.media_type || 'photo');
        const media_base64 = row.media_base64 || row.url || '';
        const caption = row.caption || row.title || row.description || null;
        
        return {
          id: row.id,
          hero_id: row.hero_id,
          type: type,
          media_base64: media_base64,
          caption: caption,
          order_index: row.order_index || 0,
          created_at: row.created_at
        };
      });
      
      return hero;
    });
  },

  create(data) {
    const stmt = heroDb.prepare(`
      INSERT INTO heroes (full_name, birth_year, death_year, rank, photo_base64, biography)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      data.full_name,
      data.birth_year || null,
      data.death_year || null,
      data.rank || null,
      data.photo_base64 || null,
      data.biography || null
    );

    return result.lastInsertRowid;
  },

  update(id, data) {
    return heroDb
      .prepare(
        `
        UPDATE heroes
        SET full_name = ?, birth_year = ?, death_year = ?, rank = ?, photo_base64 = ?, biography = ?
        WHERE id = ?
      `
      )
      .run(
        data.full_name,
        data.birth_year || null,
        data.death_year || null,
        data.rank || null,
        // Если photo_base64 явно передан (включая null для удаления), используем его, иначе оставляем текущее значение
        data.photo_base64 !== undefined ? (data.photo_base64 || null) : null,
        data.biography || null,
        id
      );
  },

  delete(id) {
    return heroDb.prepare('DELETE FROM heroes WHERE id = ?').run(id);
  },

  addMedia(heroId, media) {
    // Проверяем, что обязательные поля присутствуют
    if (!media.type || !media.media_base64) {
      throw new Error('Type and media_base64 are required');
    }
    
    // Проверяем, какие колонки существуют в таблице
    const tableInfo = heroDb.prepare('PRAGMA table_info(hero_media)').all();
    const columns = tableInfo.map(col => col.name);
    const hasOldMediaType = columns.includes('media_type');
    const hasOldUrl = columns.includes('url');
    
    // Преобразуем тип из новой схемы (photo/video) в старую (image/video)
    const oldMediaType = media.type === 'photo' ? 'image' : media.type;
    
    // Строим запрос с учетом существующих колонок
    let insertColumns = ['hero_id', 'type', 'media_base64', 'caption', 'order_index'];
    let insertValues = [heroId, media.type, media.media_base64, media.caption || null, media.order_index || 0];
    
    // Если есть старая колонка media_type, добавляем её для совместимости
    if (hasOldMediaType) {
      insertColumns.push('media_type');
      insertValues.push(oldMediaType);
    }
    
    // Если есть старая колонка url, тоже заполняем её
    if (hasOldUrl) {
      insertColumns.push('url');
      insertValues.push(media.media_base64); // Используем media_base64 как url
    }
    
    const placeholders = insertColumns.map(() => '?').join(', ');
    const stmt = heroDb.prepare(`
      INSERT INTO hero_media (${insertColumns.join(', ')})
      VALUES (${placeholders})
    `);

    const result = stmt.run(...insertValues);
    return result.lastInsertRowid;
  },

  deleteMedia(mediaId) {
    return heroDb.prepare('DELETE FROM hero_media WHERE id = ?').run(mediaId);
  },

  deleteMediaByHero(heroId) {
    return heroDb.prepare('DELETE FROM hero_media WHERE hero_id = ?').run(heroId);
  }
};

