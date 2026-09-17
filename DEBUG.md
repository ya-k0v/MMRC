# Debugging & Diagnostics

## Ports

| Service | Port | Check |
|---------|------|-------|
| HTTP | 80 | `curl http://localhost/health` |
| HTTPS | 443 | `curl -k https://localhost/health` |
| PostgreSQL | 5432 | `pg_isready -h localhost -p 5432` |
| Redis | 6379 | `redis-cli ping` |
| MinIO | 9000 | `curl http://localhost:9000/minio/health/live` |
| MinIO Console | 9001 | `curl http://localhost:9001` |

```bash
ss -tlnp | grep -E "80|443|5432|6379|9000|9001"
```

## Health Check

```bash
curl -s http://localhost/health | jq
curl -s http://localhost:80/health
```

## Logs

```bash
docker logs mmrc --tail 50
docker logs -f mmrc
docker logs mmrc-postgres --tail 20
docker logs mmrc-redis --tail 20

for c in mmrc mmrc-postgres mmrc-redis mmrc-minio; do
  echo "=== $c ==="
  docker logs --tail 5 $c 2>&1
done
```

## Database

```bash
docker exec mmrc sqlite3 /app/data/db/mmrc.db "SELECT COUNT(*) FROM devices;"
docker exec mmrc-postgres psql -U mmrc -d mmrc -c "SELECT COUNT(*) FROM devices;"
```

## Redis

```bash
docker exec mmrc-redis redis-cli ping
docker exec mmrc-redis redis-cli keys "*"
docker exec mmrc-redis redis-cli info stats
```

## Common Errors

### Port 80 in use

```bash
sudo lsof -i :80
sudo fuser -k 80/tcp
```

### Database connection failed

```bash
docker ps | grep postgres
docker logs mmrc-postgres
docker exec -it mmrc-postgres psql -U mmrc -d mmrc
```

### Out of memory

```bash
docker stats --no-stream
docker system prune -a
```

### Disk full

```bash
df -h
docker system prune -a --volumes
```

## Diagnostic Script

Save as `diagnose.sh`:

```bash
#!/bin/bash
echo "=== Docker Status ==="
docker ps -a | grep mmrc

echo -e "\n=== Ports ==="
ss -tlnp | grep -E "80|443|5432|6379|9000"

echo -e "\n=== Health ==="
curl -s http://localhost/health 2>/dev/null || echo "Not responding"

echo -e "\n=== Disk ==="
df -h / | tail -1

echo -e "\n=== Memory ==="
free -h | head -2
```