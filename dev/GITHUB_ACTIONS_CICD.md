# GitHub Actions CI/CD

Полная production-схема CI, CD, security-checks и автообновления зависимостей для проекта MMRC.

## Что уже сделано

- CI pipeline с quality gate, smoke, audit и артефактом
- CD pipeline со staging/production и ручным запуском
- Security pipeline (CodeQL)
- PR dependency review (блокирует опасные обновления зависимостей)
- Dependabot для npm и GitHub Actions

## CI pipeline

Workflow: [.github/workflows/app-test.yml](../.github/workflows/app-test.yml)

### Что запускается

- Триггеры:
  - push в main/master/develop/v*
  - pull_request
  - workflow_dispatch
  - workflow_call (для вызова из CD)
- Основной gate:
  - job quality_gate: npm ci + npm run test:ci
- Дополнительные jobs (только для обычного запуска, не для workflow_call):
  - smoke_node22: быстрый smoke на Node 22
  - dependency_audit: npm audit (отчет как артефакт)
  - release_artifact: tar.gz исходников для релизов

### Граф jobs

```mermaid
flowchart TD
    A[Trigger: push/pull_request/workflow_dispatch] --> B[quality_gate]
    B --> C[smoke_node22]
    B --> D[dependency_audit]
    B --> E[release_artifact]
```

## CD pipeline

Workflow: [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)

### Что запускается

- Триггеры:
  - workflow_dispatch (ручной запуск)
- Порядок:
  - quality_gate: переиспользует CI workflow
  - resolve_target: вычисляет environment/ref/флаги
  - deploy: SSH deploy на сервер + scripts/post-pull-sync.sh

### Правило выбора environment

- workflow_dispatch -> environment берется из input

### Граф jobs

```mermaid
flowchart TD
  A[Trigger: workflow_dispatch] --> B[quality_gate]
    B --> C[resolve_target]
    C --> D[deploy]
```

## Режим без выделенного сервера (pull-based)

Если у вас нет одного фиксированного сервера, это нормально.

- CI и security workflows продолжают работать на каждый push/PR.
- CD deploy workflow не запускается автоматически.
- Каждый владелец своей инсталляции обновляет систему через git pull в своей инфраструктуре.

Рекомендованный порядок для владельца инсталляции:

1. git pull
2. bash ./scripts/post-pull-sync.sh

Такой процесс в больших командах тоже используется, когда есть много независимых стендов и нет единой точки деплоя.

## Security и maintenance pipeline

Workflows:

- [.github/workflows/security-codeql.yml](../.github/workflows/security-codeql.yml)
- [.github/workflows/dependency-review.yml](../.github/workflows/dependency-review.yml)
- [.github/dependabot.yml](../.github/dependabot.yml)

### Что запускается

- CodeQL:
  - push/pull_request в main/master/develop
  - weekly schedule
- Dependency Review:
  - каждый pull_request в main/master/develop
  - блокирует PR, если есть high+ уязвимости в измененных зависимостях
- Dependabot:
  - еженедельные PR на npm (minor/patch группируются)
  - еженедельные PR на обновление GitHub Actions

### Граф security jobs

```mermaid
flowchart TD
    A[Pull request] --> B[Dependency Review]
    C[Push/PR/Schedule] --> D[CodeQL Analyze]
    E[Weekly schedule] --> F[Dependabot PRs]
```

## Секреты для CD

Секреты должны быть созданы в GitHub Environment (staging/production):

- DEPLOY_HOST
- DEPLOY_PORT (опционально, default 22)
- DEPLOY_USER
- DEPLOY_SSH_PRIVATE_KEY
- DEPLOY_KNOWN_HOSTS (опционально)
- DEPLOY_PATH
- DEPLOY_SERVICE (опционально, default videocontrol.service)

### Что именно указывать

1. DEPLOY_HOST
  - IP или DNS имя сервера, куда идет деплой.
  - Пример: 203.0.113.20 или vc-prod.example.com
2. DEPLOY_USER
  - Linux-пользователь для SSH (обычно отдельный deploy user).
  - Пример: deploy
3. DEPLOY_SSH_PRIVATE_KEY
  - Полный текст приватного ключа OpenSSH (многострочный), включая строки BEGIN/END.
  - Пример начала:
    -----BEGIN OPENSSH PRIVATE KEY-----
4. DEPLOY_PATH
  - Абсолютный путь до папки проекта на сервере, где уже есть .git.
  - Пример: /opt/videocontrol
5. DEPLOY_PORT (опционально)
  - SSH порт, если отличается от 22.
  - Пример: 22
6. DEPLOY_KNOWN_HOSTS (рекомендуется)
  - Точный вывод ssh-keyscan для вашего хоста.
  - Пример команды для получения:
    ssh-keyscan -p 22 vc-prod.example.com
7. DEPLOY_SERVICE (опционально)
  - Имя systemd-сервиса для рестарта после деплоя.
  - Пример: videocontrol.service

### Быстрая подготовка SSH-ключа для GitHub Actions

1. Сгенерировать ключ на вашей админ-машине:
  ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/videocontrol_actions
2. Добавить публичный ключ на сервер в authorized_keys пользователя DEPLOY_USER.
3. Содержимое ~/.ssh/videocontrol_actions скопировать в DEPLOY_SSH_PRIVATE_KEY.
4. Проверить вход:
  ssh -i ~/.ssh/videocontrol_actions DEPLOY_USER@DEPLOY_HOST

## Что делает deploy job на сервере

1. Подключается по SSH.
2. Переходит в DEPLOY_PATH.
3. git fetch --all --tags --prune.
4. Checkout нужного ref (ветка/тег/SHA).
5. Запускает scripts/post-pull-sync.sh с флагами:
   - SKIP_MIGRATION
   - SKIP_SERVICE_RESTART
6. Делает health-check на http://127.0.0.1:3000/health (best-effort).

## Рекомендации по безопасности

- Включить protection rules для Environment production (required reviewers).
- Использовать DEPLOY_KNOWN_HOSTS вместо динамического ssh-keyscan.
- Ограничить права deploy-ключа только нужным сервером и пользователем.

## Что требуется от вас (чеклист)

### Если нет выделенного сервера (ваш текущий сценарий)

1. В Branch protection для main/master включить:
  - Require pull request before merging
  - Require status checks to pass
2. Добавить обязательные status checks:
  - CI / Quality gate / Node 20
  - Dependency Review / Block high-risk dependency changes
  - Security (CodeQL) / Analyze code

### Если позже появится выделенный сервер для автодеплоя

1. В GitHub создать Environments: staging и production.
2. В каждый Environment добавить секреты:
  - DEPLOY_HOST
  - DEPLOY_USER
  - DEPLOY_SSH_PRIVATE_KEY
  - DEPLOY_PATH
  - DEPLOY_PORT (опционально)
  - DEPLOY_KNOWN_HOSTS (рекомендуется)
  - DEPLOY_SERVICE (опционально)
3. Для production Environment включить Required reviewers.

## Что я еще добавил на этом шаге

- Автоматический security-скан кода (CodeQL).
- Автопроверку изменений зависимостей в PR (Dependency Review).
- Автообновление зависимостей и Actions через Dependabot по расписанию.