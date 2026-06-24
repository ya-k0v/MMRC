#!/bin/bash
# VideoControl MPV — Quick Install (auto-detect platform, optimal config)
set -e

INSTALL_DIR="$HOME/videocontrol-mpv"
REPO_URL="https://raw.githubusercontent.com/ya-k0v/MMRC/v340/clients/mpv"
SERVER_URL=""
DEVICE_ID=""
INSTALL_SYSTEMD=true
SKIP_MPV=false
FULLSCREEN=false

usage() { cat <<'EOF'
Usage: curl -fsSL https://raw.githubusercontent.com/ya-k0v/MMRC/v340/clients/mpv/quick-install.sh | bash -s -- --server URL --device ID [--fullscreen]

Options:
  --server URL   http://192.168.1.100
  --device ID    mpv-001
  --fullscreen   Fullscreen by default
  --no-systemd   Skip systemd service
  --skip-mpv     Skip MPV install
EOF
exit 0; }

while [[ $# -gt 0 ]]; do
    case $1 in
        --server) SERVER_URL="$2"; shift 2 ;;
        --device) DEVICE_ID="$2"; shift 2 ;;
        --fullscreen) FULLSCREEN=true; shift ;;
        --no-systemd) INSTALL_SYSTEMD=false; shift ;;
        --skip-mpv) SKIP_MPV=true; shift ;;
        *) usage ;;
    esac
done

[ -z "$SERVER_URL" ] || [ -z "$DEVICE_ID" ] && usage

# ── Platform detection ──────────────────────────────────────────────────
ARCH=$(uname -m)
[ -f /etc/os-release ] && . /etc/os-release
PLATFORM="x86_linux"

if grep -qi "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
    PLATFORM="raspberry_pi"
elif [[ "$ARCH" == aarch64* || "$ARCH" == armv7* || "$ARCH" == arm* ]]; then
    PLATFORM="arm_linux"
fi

echo "=== VideoControl MPV Install ==="
echo " OS:  $ID ($ARCH)  Platform: $PLATFORM"
echo ""

# ── Install MPV ─────────────────────────────────────────────────────────
if [ "$SKIP_MPV" = false ]; then
    echo "== Install MPV =="
    case "$ID" in
        ubuntu|debian|raspbian)
            sudo apt-get update -qq
            sudo apt-get install -y mpv python3 python3-pip curl pciutils
            sudo apt-get install -y vainfo libva-drm2 mesa-va-drivers 2>/dev/null || true
            lspci 2>/dev/null | grep -qi nvidia && \
                sudo apt-get install -y vdpauinfo libvdpau1 2>/dev/null || true
            ;;
        centos|rhel)
            sudo yum install -y epel-release mpv python3 python3-pip curl pciutils
            ;;
        arch|manjaro)
            sudo pacman -S --noconfirm mpv python python-pip curl pciutils
            ;;
        *) echo "⚠ Unknown OS: $ID — install mpv manually" ;;
    esac
    echo "✅ $(mpv --version | head -1)"
fi

# ── Python ──────────────────────────────────────────────────────────────
pip3 install --user --quiet python-socketio[client]==5.14.0 requests==2.32.4

# ── Client files ────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
if [ -f "$(dirname "$0")/mpv_client.py" ]; then
    cp "$(dirname "$0")/mpv_client.py" "$INSTALL_DIR/"
    cp "$(dirname "$0")/requirements.txt" "$INSTALL_DIR/" 2>/dev/null || true
else
    curl -fsSL "$REPO_URL/mpv_client.py" -o "$INSTALL_DIR/mpv_client.py"
    curl -fsSL "$REPO_URL/requirements.txt" -o "$INSTALL_DIR/requirements.txt" || true
fi
chmod +x "$INSTALL_DIR/mpv_client.py"

# ── Generate mpv.conf ──────────────────────────────────────────────────
echo "== Generating mpv.conf =="
mkdir -p ~/.config/mpv

case "$PLATFORM" in
    raspberry_pi)
        cat > ~/.config/mpv/mpv.conf << 'CONF'
hwdec=v4l2m2m-copy
vo=gpu
gpu-context=drm
hwdec-codecs=h264,hevc,vp8,vp9
cache=yes
cache-secs=30
demuxer-max-bytes=150M
network-timeout=60
no-osc
no-osd-bar
idle=yes
force-window=yes
keep-open=yes
cursor-autohide=always
CONF
        groups "$USER" | grep -qv video && sudo usermod -aG video "$USER" 2>/dev/null || true
        ;;
    arm_linux)
        cat > ~/.config/mpv/mpv.conf << 'CONF'
hwdec=auto
cache=yes
cache-secs=10
network-timeout=60
no-osc
no-osd-bar
idle=yes
force-window=yes
keep-open=yes
cursor-autohide=always
CONF
        ;;
    *)
        if mpv --version 2>/dev/null | grep -qE "mpv [0-9]+\.[3-9][0-9]"; then
            cat > ~/.config/mpv/mpv.conf << 'CONF'
hwdec=auto
vo=gpu-next
cache=yes
cache-secs=10
demuxer-max-bytes=200M
network-timeout=60
no-osc
no-osd-bar
idle=yes
force-window=yes
keep-open=yes
cursor-autohide=always
CONF
        else
            cat > ~/.config/mpv/mpv.conf << 'CONF'
hwdec=auto
vo=x11
cache=yes
cache-secs=10
demuxer-max-bytes=200M
network-timeout=60
no-osc
no-osd-bar
idle=yes
force-window=yes
keep-open=yes
cursor-autohide=always
CONF
        fi
        ;;
esac
echo "✅ mpv.conf -> ~/.config/mpv/mpv.conf"

# ── systemd ─────────────────────────────────────────────────────────────
if [ "$INSTALL_SYSTEMD" = true ]; then
    echo "== systemd service =="
    FS=""; [ "$FULLSCREEN" = true ] && FS="--fullscreen"
    sudo tee /etc/systemd/system/videocontrol-mpv@.service > /dev/null << EOF
[Unit]
Description=VideoControl MPV for %i
After=network-online.target
[Service]
Type=simple
User=$USER
Environment="DISPLAY=:0"
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/python3 $INSTALL_DIR/mpv_client.py --server $SERVER_URL --device %i --display :0 $FS
Restart=always
RestartSec=5
StandardOutput=journal
SyslogIdentifier=videocontrol-mpv-%i
NoNewPrivileges=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now "videocontrol-mpv@${DEVICE_ID}.service"
    echo "✅ service started"
fi

echo ""
echo "=== Done ==="
echo "Files: $INSTALL_DIR"
echo "Logs: journalctl -u videocontrol-mpv@${DEVICE_ID} -f"
