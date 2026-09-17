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