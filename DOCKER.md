# Docker Diagnostics

## Status

```bash
docker ps -a
docker ps -a | grep mmrc
docker inspect --format='{{.Name}}: {{.State.Health.Status}}' $(docker ps -q)
```

## Logs

```bash
docker logs mmrc
docker logs --tail 100 mmrc
docker logs -f mmrc
docker logs mmrc-postgres
docker logs mmrc-redis
docker logs mmrc-minio
```

## Management

```bash
docker restart mmrc
docker stop $(docker ps -q | grep mmrc)
docker rm -f mmrc
docker system prune -a
```

## Compose

```bash
docker compose ps
docker compose up -d --force-recreate
docker compose build --no-cache
docker compose config
```

## Ресурсы и лимиты

- Каждый контейнер ограничен по памяти и числу процессов; логи ротируются автоматически (json-file, 50 МБ × 5 файлов).
- При обработке видео контейнер `mmrc` ограничен по ядрам: значение `MMRC_CPU_LIMIT` в `.env` (по умолчанию подбирается автоматически — ядра хоста минус 2, минимум 1). Изменить — поправить `.env` и `docker compose up -d`.

## Отключение docker.sock

Решение осознанное. Сокет нужен для двух функций:
- **самообновление из админки** — `docker pull` / `docker rm` / `docker compose`;
- **конвертация PPTX → PDF** — `MMRC_DOCKER=1`, а `soffice` в образ не входит.

Чтобы убрать:

```bash
# 1. Удалить монтирование сокета из compose-файлов
#    - /var/run/docker.sock:/var/run/docker.sock
# 2. Убрать INCLUDE_DOCKER_CLI из build.args (docker-compose.yml) — CLI не попадёт в образ
```

Аналитика (`docker stats`, логи HA-nginx) обёрнута в try/catch: без сокета она просто станет пустой, приложение не упадёт. Обновления после этого — только на хосте через `install.sh`.

Внутри контейнера включены защита от повышения привилегий (`no-new-privileges`) и минимальный набор прав.

## Troubleshooting

### Container won't start

```bash
docker logs mmrc
ss -tlnp | grep -E "80|443|5432|6379|9000"
df -h
```

### PostgreSQL connection failed

```bash
docker ps | grep postgres
docker exec -it mmrc-postgres psql -U mmrc -d mmrc
docker logs mmrc-postgres
```

### MinIO unavailable

```bash
docker logs mmrc-minio
docker exec mmrc-minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker exec mmrc-minio mc ls local/
```

### Port in use

```bash
ss -tlnp | grep :80
lsof -i :80
sudo fuser -k 80/tcp
```