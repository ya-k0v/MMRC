#!/bin/bash
set -e

# ── Конфигурация ──────────────────────────────────────────────────────
INSTALL_DIR="$HOME/videocontrol-mpv"
REPO_URL="https://raw.githubusercontent.com/ya-k0v/MMRC/v340/clients/mpv"

# ── Парсинг аргументов ─────────────────────────────────────────────────
SERVER_URL=""
DEVICE_ID=""
INSTALL_SYSTEMD=true
SKIP_MPV=false
FULLSCREEN=false

usage() {
    cat <<EOF
Использование: $0 --server URL --device ID [OPTIONS]

Обязательные:
  --server URL    http://192.168.1.100
  --device ID     mpv-001

Опции:
  --fullscreen    Полноэкранный режим по умолчанию
  --no-systemd    Не устанавливать systemd service
  --skip-mpv      Не устанавливать MPV
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --server) SERVER_URL="$2"; shift 2 ;;
        --device) DEVICE_ID="$2"; shift 2 ;;
        --fullscreen) FULLSCREEN=true; shift ;;
        --no-systemd) INSTALL_SYSTEMD=false; shift ;;
        --skip-mpv) SKIP_MPV=true; shift ;;
        --help|-h) usage ;;
        *) echo "Неизвестно: $1"; usage ;;
    esac
done

if [ -z "$SERVER_URL" ] || [ -z "$DEVICE_ID" ]; then
    echo "❌ --server и --device обязательны"
    usage
fi

# ── Определение платформы ──────────────────────────────────────────────
ARCH=$(uname -m)
PLATFORM="x86_linux"

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "❌ Не удалось определить ОС"
    exit 1
fi

# Raspberry Pi detection (by /proc/cpuinfo)
if grep -qi "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
    PLATFORM="raspberry_pi"
elif [[ "$ARCH" == aarch64* || "$ARCH" == armv7* || "$ARCH" == arm* ]]; then
    PLATFORM="arm_linux"
fi

echo "=========================================="
echo "VideoControl MPV Client — Install"
echo "=========================================="
echo " OS:      $OS ($ARCH)"
echo " Platform: $PLATFORM"
echo " Server:   $SERVER_URL"
echo " Device:   $DEVICE_ID"
echo ""

# ── Установка MPV ──────────────────────────────────────────────────────
if [ "$SKIP_MPV" = false ]; then
    echo "📦 Установка MPV..."

    install_deb() {
        sudo apt-get update -qq
        sudo apt-get install -y mpv python3 python3-pip curl pciutils
        # VA-API (Intel/AMD)
        sudo apt-get install -y vainfo libva-drm2 mesa-va-drivers 2>/dev/null || true
        # VDPAU (NVIDIA)
        if lspci 2>/dev/null | grep -qi nvidia; then
            sudo apt-get install -y vdpauinfo libvdpau1 2>/dev/null || true
        fi
    }

    install_rpm() {
        sudo yum install -y epel-release
        sudo yum install -y mpv python3 python3-pip curl pciutils
    }

    install_arch() {
        sudo pacman -S --noconfirm mpv python python-pip curl pciutils
    }

    case "$OS" in
        ubuntu|debian|raspbian) install_deb ;;
        centos|rhel) install_rpm ;;
        arch|manjaro) install_arch ;;
        *) echo "⚠️ Неизвестная ОС: $OS — установите MPV вручную" ;;
    esac

    echo "✅ MPV: $(mpv --version | head -1)"
else
    echo "⏭️ MPV пропущен"
fi

# ── Python зависимости ─────────────────────────────────────────────────
echo "📦 Python зависимости..."
pip3 install --user --quiet python-socketio[client]==5.14.0 requests==2.32.4
echo "✅ Python зависимости"

# ── Создание директории ────────────────────────────────────────────────
echo "📁 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# ── Скачивание файлов ──────────────────────────────────────────────────
echo "📥 Файлы клиента..."
if [ -f "$(dirname "$0")/mpv_client.py" ]; then
    cp "$(dirname "$0")/mpv_client.py" "$INSTALL_DIR/"
    cp "$(dirname "$0")/requirements.txt" "$INSTALL_DIR/" 2>/dev/null || true
    [ -f "$(dirname "$0")/videocontrol-mpv@.service" ] && \
        cp "$(dirname "$0")/videocontrol-mpv@.service" "$INSTALL_DIR/"
else
    curl -fsSL "$REPO_URL/mpv_client.py" -o "$INSTALL_DIR/mpv_client.py"
    curl -fsSL "$REPO_URL/requirements.txt" -o "$INSTALL_DIR/requirements.txt" || true
    curl -fsSL "$REPO_URL/videocontrol-mpv@.service" -o "$INSTALL_DIR/videocontrol-mpv@.service" || true
fi
chmod +x "$INSTALL_DIR/mpv_client.py"

# ── Генерация mpv.conf ─────────────────────────────────────────────────
echo "⚙️ Генерация mpv.conf..."
mkdir -p ~/.config/mpv

case "$PLATFORM" in
    raspberry_pi)
        cat > ~/.config/mpv/mpv.conf << 'MPVCONF'
hwdec=v4l2m2m-copy
vo=gpu
gpu-context=drm
opengl-es=yes
hwdec-codecs=h264,hevc,vp8,vp9
cache=yes
cache-secs=30
demuxer-max-bytes=150M
demuxer-readahead-secs=30
network-timeout=60
vd-lavc-threads=4
framedrop=vo
no-osc
no-osd-bar
cursor-autohide=always
keep-open=yes
idle=yes
force-window=yes
MPVCONF
        # Для работы gpu-context=drm на Pi нужны права
        if groups "$USER" | grep -qv video; then
            sudo usermod -aG video "$USER" 2>/dev/null || true
            echo "⚠️ Добавлен в группу video — перелогиньтесь"
        fi
        ;;

    arm_linux)
        cat > ~/.config/mpv/mpv.conf << 'MPVCONF'
hwdec=auto
cache=yes
cache-secs=10
network-timeout=60
no-osc
no-osd-bar
cursor-autohide=always
keep-open=yes
idle=yes
force-window=yes
MPVCONF
        ;;

    *)
        if mpv --version 2>/dev/null | grep -qE "mpv [0-9]+\.[3-9][0-9]"; then
            # MPV 0.33+ — gpu-next
            cat > ~/.config/mpv/mpv.conf << 'MPVCONF'
hwdec=auto
vo=gpu-next
gpu-context=auto
cache=yes
cache-secs=10
demuxer-max-bytes=200M
demuxer-readahead-secs=20
network-timeout=60
no-osc
no-osd-bar
cursor-autohide=always
keep-open=yes
idle=yes
force-window=yes
MPVCONF
        else
            cat > ~/.config/mpv/mpv.conf << 'MPVCONF'
hwdec=auto
vo=x11
cache=yes
cache-secs=10
demuxer-max-bytes=200M
network-timeout=60
no-osc
no-osd-bar
cursor-autohide=always
keep-open=yes
idle=yes
force-window=yes
MPVCONF
        fi
        ;;
esac
echo "✅ mpv.conf сгенерирован"

# ── Systemd service ────────────────────────────────────────────────────
if [ "$INSTALL_SYSTEMD" = true ]; then
    echo "⚙️ systemd service..."

    FULLSCREEN_FLAG=""
    [ "$FULLSCREEN" = true ] && FULLSCREEN_FLAG="--fullscreen"

    sudo tee /etc/systemd/system/videocontrol-mpv@.service > /dev/null << EOF
[Unit]
Description=VideoControl MPV Client for %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Group=$USER
Environment="DISPLAY=:0"
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/python3 $INSTALL_DIR/mpv_client.py --server $SERVER_URL --device %i --display :0 $FULLSCREEN_FLAG
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=videocontrol-mpv-%i
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "videocontrol-mpv@${DEVICE_ID}.service"
    sudo systemctl restart "videocontrol-mpv@${DEVICE_ID}.service"
    echo "✅ service запущен"
fi

# ── Готово ─────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "✅ Готово!"
echo "=========================================="
echo ""
echo "📁 $INSTALL_DIR"
echo ""

if [ "$INSTALL_SYSTEMD" = true ]; then
    echo " systemctl status videocontrol-mpv@${DEVICE_ID}"
    echo " journalctl -u videocontrol-mpv@${DEVICE_ID} -f"
else
    echo " python3 $INSTALL_DIR/mpv_client.py --server $SERVER_URL --device $DEVICE_ID"
fi
echo ""
