# Hero Module

Модуль героев полностью изолирован в отдельной структуре:

## Структура модуля

### Клиентский код (Frontend)
- `public/hero/index.html` - публичная панель героев
- `public/hero/admin.html` - админ-панель героев
- `public/hero/js/hero.js` - клиентский код для публичной панели
- `public/hero/js/hero-admin.js` - клиентский код для админ-панели
- `public/hero/js/hero-utils.js` - общие утилиты для обеих панелей
- `public/css/hero.css` - стили для панелей героев

### Серверный код (Backend)
- `src/hero/index.js` - главный экспорт модуля
- `src/hero/routes/hero-router.js` - API роуты для героев
- `src/hero/database/hero-db.js` - инициализация базы данных
- `src/hero/database/queries.js` - запросы к базе данных
- `src/hero/database/schema.sql` - схема базы данных

### База данных
- `config/hero/heroes.db` - SQLite база данных героев (создается автоматически)

## Доступ

- **Публичная панель**: `http://IP/hero/index.html` или `http://IP/hero`
- **Админ-панель**: `http://IP/hero/admin.html`

## API Endpoints

Все API endpoints доступны через `/api/hero/*`:
- `GET /api/hero/` - получить всех героев
- `GET /api/hero/search?q=query` - поиск героев
- `GET /api/hero/:id` - получить героя по ID
- `POST /api/hero/` - создать нового героя (требует hero_admin)
- `PUT /api/hero/:id` - обновить героя (требует hero_admin)
- `DELETE /api/hero/:id` - удалить героя (требует hero_admin)
- `GET /api/hero/export-database` - экспорт базы данных (требует hero_admin)

## Особенности

- Поиск по началу строки, регистронезависимый
- Нормализация 'е' и 'ё' при поиске
- Книжное оформление биографий (красная строка, выравнивание по ширине)
- Поддержка фото и видео материалов для каждого героя
