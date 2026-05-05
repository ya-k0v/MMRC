.PHONY: help build up down logs restart clean backup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build all Docker images
	docker compose build

build-no-cache: ## Build without cache
	docker compose build --no-cache

up: ## Start all services
	docker compose up -d

up-nginx: ## Start with Nginx
	docker compose --profile nginx up -d

up-all: ## Start all services including Nginx
	docker compose --profile nginx up -d

down: ## Stop all services
	docker compose down

logs: ## Show logs
	docker compose logs -f

logs-server: ## Show server logs
	docker compose logs -f mmrc



restart: ## Restart all services
	docker compose restart

restart-server: ## Restart server
	docker compose restart mmrc

ps: ## Show running services
	docker compose ps

backup: ## Create backup
	docker compose --profile backup run --rm mmrc-backup

restore: ## Restore from backup (usage: make restore BACKUP=main-2024-01-01_1200.db)
	docker cp docker/backups/$(BACKUP) mmrc-config:/app/config/main.db
	docker compose restart mmrc

shell-server: ## Open shell in server container
	docker compose exec mmrc /bin/sh



health: ## Check health
	curl -f http://localhost:3000/health || echo "Server not healthy"

clean: ## Remove all containers, volumes, and images
	docker compose down -v --rmi all
	docker system prune -f

clean-data: ## Remove only data volumes (WARNING: deletes all content!)
	docker compose down -v

init: ## Initialize .env file
	cp docker/.env.example .env
	@echo "JWT_SECRET=$$(openssl rand -hex 64)" >> .env
	@echo ".env created. Edit it before running 'make up'"

setup-hooks: ## Setup git hooks
	npm run setup-hooks

migrate: ## Run database migrations
	docker compose exec mmrc npm run migrate-db
