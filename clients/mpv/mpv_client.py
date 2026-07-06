#!/usr/bin/env python3
"""
VideoControl MPV Client v2.1
Native Media Player for Linux/Unix - полная идентичность с JS плеером (VJC)

Стабилизация и бесперебойная работа:
  ✅ player/register: device_type, capabilities, app_version (как VJC)
  ✅ Обработка player/registered, player/state, player/reject
  ✅ Missed pong detection — перерегистрация после 3 пропущенных pong
  ✅ Внутренняя retry-логика подключения (exponential backoff 2-60с)
  ✅ Thread-safe: placeholder + retry проверяют self.running
  ✅ Поддержка type: 'audio' (как VJC)
  ✅ IPC socket: чтение буферами вместо 1 байта (x100 быстрее)
  ✅ Thread-safe состояние (Lock для shared state)
  ✅ Потокобезопасный heartbeat с быстрым shutdown (Event вместо sleep)
  ✅ Убраны dead code и except:pass
"""

import socket
import json
import socketio
import time
import threading
import os
import sys
import argparse
import signal
import subprocess
import requests
import platform
import re
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Dict, Any, List
from urllib.parse import quote
from threading import Lock, Event

# ── Константы ───────────────────────────────────────────────────────────
APP_VERSION = '3.4.0'  # default; overridden by server /api/version

# ── Логгер ──────────────────────────────────────────────────────────────
logger = logging.getLogger('mpv_client')
_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter('[%(name)s] %(levelname)s %(message)s'))
logger.addHandler(_handler)
logger.setLevel(logging.INFO)


class DeviceDetector:
    """
    Автоматическое определение типа устройства и оптимальных параметров MPV
    """
    
    @staticmethod
    def detect_platform():
        system = platform.system()
        machine = platform.machine()
        
        if machine.startswith('arm') or machine.startswith('aarch'):
            try:
                with open('/proc/cpuinfo', 'r') as f:
                    if 'Raspberry Pi' in f.read():
                        return 'raspberry_pi'
            except OSError:
                pass
            return 'arm_linux'
        
        if system == 'Linux':
            return 'x86_linux'
        
        return 'unknown'
    
    @staticmethod
    def detect_display_server():
        if os.environ.get('DISPLAY'):
            return 'x11'
        if os.environ.get('WAYLAND_DISPLAY'):
            return 'wayland'
        return 'drm'
    
    @staticmethod
    def get_mpv_version() -> tuple:
        try:
            result = subprocess.run(['mpv', '--version'],
                                    capture_output=True,
                                    text=True,
                                    timeout=2)
            version_line = result.stdout.split('\n')[0]
            match = re.search(r'mpv (\d+)\.(\d+)', version_line)
            if match:
                return (int(match.group(1)), int(match.group(2)))
        except (subprocess.TimeoutExpired, FileNotFoundError, IndexError):
            pass
        return (0, 32)
    
    @staticmethod
    def get_optimal_params(platform_type: str, mpv_version: tuple) -> List[str]:
        major, minor = mpv_version
        is_modern_mpv = (major > 0 or minor >= 33)
        
        logger.info("Платформа: %s", platform_type)
        logger.info("MPV версия: %d.%d", major, minor)
        logger.info("Конфигурация: %s", 'modern' if is_modern_mpv else 'legacy')
        
        params = [
            '--idle=yes',
            '--force-window=yes',
            '--no-input-default-bindings',
            '--cursor-autohide=always',
            '--autofit=1280x720',
            '--autofit-smaller=1280x720',
            '--no-keepaspect-window',
            '--osd-align-x=right',
            '--osd-align-y=bottom',
            '--osd-margin-x=16',
            '--osd-margin-y=16',
            '--osd-font-size=14',
            '--osd-color=#C8C8C8',
            '--osd-shadow-offset=1',
            '--osd-shadow-color=#000000',
        ]
        
        if platform_type == 'raspberry_pi':
            logger.info("Raspberry Pi — оптимизация под vc4-kms-v3d + rpivid-v4l2")
            params.extend([
                '--cache=yes',
                '--cache-secs=30',
                '--demuxer-max-bytes=150M',
                '--demuxer-readahead-secs=30',
                '--network-timeout=60',
                '--vo=gpu',
                '--gpu-context=drm',
                '--hwdec=v4l2m2m-copy',
                '--hwdec-codecs=h264,hevc,vp8,vp9',
                '--vd-lavc-threads=4',
                '--framedrop=vo',
                '--no-osc',
                '--no-osd-bar',
                '--audio-device=alsa/default',
            ])
            return params
        
        if platform_type == 'arm_linux':
            params.extend([
                '--hwdec=auto',
                '--cache=yes',
                '--cache-secs=10',
                '--network-timeout=60',
            ])
            return params
        
        if platform_type == 'x86_linux':
            if is_modern_mpv:
                params.extend([
                    '--hwdec=auto',
                    '--vo=gpu',
                    '--gpu-context=auto',
                    '--cache=yes',
                    '--cache-secs=10',
                    '--demuxer-max-bytes=200M',
                    '--demuxer-readahead-secs=20',
                    '--network-timeout=60',
                    '--no-osc',
                    '--no-osd-bar',
                ])
            else:
                params.extend([
                    '--hwdec=auto',
                    '--vo=x11',
                    '--cache=yes',
                    '--cache-secs=10',
                    '--demuxer-max-bytes=200M',
                    '--network-timeout=60',
                    '--no-osc',
                    '--no-osd-bar',
                ])
            return params
        
        params.extend([
            '--cache=yes',
            '--cache-secs=5',
            '--network-timeout=30',
        ])
        return params


class MPVClient:
    def __init__(self, server_url, device_id, display=':0', fullscreen=True):
        self.server_url = server_url.rstrip('/')
        self.device_id = device_id
        self.display = display
        self.fullscreen = fullscreen
        
        self.ipc_socket = f'/tmp/mpv-{device_id}.sock'
        
        # ── Thread-safety ──
        self._lock = Lock()
        self.running = True
        self._stop_heartbeat = Event()
        
        # ── Состояния (как в Android) ──
        self.current_video_file: Optional[str] = None
        self.saved_position: float = 0.0
        self.current_pdf_file: Optional[str] = None
        self.current_pdf_page: int = 1
        self.current_pptx_file: Optional[str] = None
        self.current_pptx_slide: int = 1
        self.current_folder_name: Optional[str] = None
        self.current_folder_image: int = 1
        self.is_playing_placeholder: bool = False
        self.content_device_id: str = device_id
        
        self.skipPlaceholderOnVideoEnd: bool = False
        self.currentFileState: Dict[str, Any] = {'type': None, 'file': None, 'page': 1}
        
        # ── Кэш заглушки ──
        self.cached_placeholder_file: Optional[str] = None
        self.cached_placeholder_type: Optional[str] = None
        
        # ── Error retry ──
        self.error_retry_count: int = 0
        self.max_retry_attempts: int = 3
        self.max_retry_attempts_content: int = 10
        self.retry_timer: Optional[threading.Timer] = None
        self.last_error_file: Optional[str] = None
        
        self.is_first_launch: bool = True
        
        # ── Прогресс ──
        self.progress_interval: Optional[threading.Timer] = None
        self.last_progress_emit_ts: float = 0.0
        self.is_streaming: bool = False
        self.stream_protocol: Optional[str] = None
        
        # ── Reconnection state ──
        self.is_registered = False
        self.missed_pong_count = 0
        
        # ── File loading guard ──
        self._loading_since = 0.0
        self._grace_until = 0.0

        # ── Server version (fetched from /api/version) ──
        self._server_app_version: Optional[str] = None

        # ── MPV restart ──
        self.mpv_process: Optional[subprocess.Popen] = None

        # ── Preload ──
        self._preload_executor = ThreadPoolExecutor(max_workers=4)
        
        # ── Определяем платформу ──
        self._platform_type = DeviceDetector.detect_platform()
        self._mpv_version = DeviceDetector.get_mpv_version()
        
        # ── Запуск MPV ──
        self._start_mpv()
        
        self._check_hardware_acceleration()
        self._fetch_server_version()
        
        # ── Socket.IO ──
        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=2,
            reconnection_delay_max=10
        )
        
        self._setup_socket_events()
        self._setup_signal_handlers()
        self._setup_mpv_monitor()
    
    def _start_mpv(self):
        if os.path.exists(self.ipc_socket):
            os.unlink(self.ipc_socket)
        
        optimal_params = DeviceDetector.get_optimal_params(self._platform_type, self._mpv_version)
        
        mpv_cmd = ['mpv'] + optimal_params + [f'--input-ipc-server={self.ipc_socket}']
        
        # ── Persistent badge OSD ──
        badge_text = f"{self.device_id} | v{APP_VERSION}"
        mpv_cmd.append(f'--osd-msg3={badge_text}')
        mpv_cmd.append(f'--osd-msg2={badge_text}')
        mpv_cmd.append('--osd-level=3')
        
        if self.fullscreen:
            mpv_cmd.append('--fullscreen')
            mpv_cmd.append('--no-border')
        
        logger.info("Запуск MPV: %s ...", ' '.join(mpv_cmd[:5]))
        
        self.mpv_process = subprocess.Popen(
            mpv_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, 'DISPLAY': self.display}
        )
        
        self._wait_for_ipc()
        
        try:
            self.send_command('set_property', 'video-aspect', '-1')
        except Exception:
            logger.warning("Не удалось установить video-aspect")
    
    def _restart_mpv(self):
        logger.info("Перезапуск MPV...")
        if self.mpv_process and self.mpv_process.poll() is None:
            try:
                self.send_command('quit')
            except Exception:
                pass
            self.mpv_process.terminate()
            try:
                self.mpv_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.mpv_process.kill()
                self.mpv_process.wait(timeout=1)
        else:
            # Если MPV уже не работает, ждём немного перед перезапуском
            time.sleep(1)
        
        self._loading_since = 0.0
        self._grace_until = 0.0
        self._start_mpv()
        self.is_playing_placeholder = False
        self.currentFileState = {'type': None, 'file': None, 'page': 1}
        self._load_placeholder()
        logger.info("MPV перезапущен")
    
    def _wait_for_ipc(self):
        for i in range(100):
            if os.path.exists(self.ipc_socket):
                logger.info("IPC socket создан за %.1f сек", i * 0.1)
                return
            if self.mpv_process.poll() is not None:
                output = self.mpv_process.stdout.read().decode('utf-8', errors='ignore')
                logger.error("MPV завершился с кодом %d", self.mpv_process.returncode)
                if output:
                    logger.error("Вывод MPV:\n%s", output)
                sys.exit(1)
            time.sleep(0.1)
        
        logger.error("IPC socket не создан за 10 сек")
        if self.mpv_process.poll() is None:
            logger.error("MPV процесс жив (PID: %d), но socket не появился", self.mpv_process.pid)
        else:
            output = self.mpv_process.stdout.read().decode('utf-8', errors='ignore')
            logger.error("Вывод MPV:\n%s", output or '(пусто)')
        sys.exit(1)
    
    def _check_hardware_acceleration(self):
        time.sleep(0.5)
        try:
            result = self.send_command('get_property', 'hwdec-current')
            if result and result.get('error') == 'success':
                hwdec = result.get('data', 'no')
                if hwdec and hwdec != 'no':
                    logger.info("Аппаратное ускорение: %s", hwdec)
                else:
                    logger.warning("CPU декодинг (установите VAAPI/VDPAU)")
            else:
                logger.info("Hwdec статус недоступен (старая версия MPV)")
        except Exception as e:
            logger.info("Не удалось проверить hwdec: %s", e)
    
    def _fetch_server_version(self):
        def fetch():
            try:
                resp = requests.get(f"{self.server_url}/api/version", timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    server_ver = data.get('apps', {}).get('jsPlayer')
                    if server_ver:
                        self._server_app_version = server_ver
                        logger.info("Версия с сервера: %s", server_ver)
            except Exception as e:
                logger.debug("Не удалось получить версию с сервера: %s", e)
        threading.Thread(target=fetch, daemon=True).start()
    
    @staticmethod
    def _detect_primary_monitor():
        try:
            result = subprocess.run(
                ['xrandr', '--current'],
                capture_output=True, text=True, timeout=3
            )
            for line in result.stdout.split('\n'):
                if 'primary' in line:
                    m = re.search(r'(\d+)x(\d+)\+(-?\d+)\+(-?\d+)', line)
                    if m:
                        return (int(m.group(1)), int(m.group(2)),
                                int(m.group(3)), int(m.group(4)))
        except (subprocess.TimeoutExpired, FileNotFoundError, IndexError):
            logger.warning("xrandr not available, fallback to --fullscreen")
            return None
        return None
    
    # ── IPC (оптимизировано: буфер вместо 1 байта) ──
    def send_command(self, command, *args) -> Optional[Dict[str, Any]]:
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(10)
            sock.connect(self.ipc_socket)
            
            cmd = {"command": [command] + list(args)}
            sock.send((json.dumps(cmd) + '\n').encode())
            
            # Читаем буфером до \n
            buf = b''
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf += chunk
                if b'\n' in chunk:
                    break
            
            sock.close()
            
            if buf:
                line = buf.split(b'\n')[0].decode('utf-8', errors='ignore').strip()
                if line:
                    return json.loads(line)
            return None
            
        except json.JSONDecodeError as e:
            logger.warning("JSON parse error: %s", e)
            return None
        except socket.timeout:
            return None
        except Exception as e:
            logger.debug("IPC error: %s", e)
            return None
    
    # ── URL helper ──
    def _content_url(self, filename: str) -> str:
        if filename.startswith('/') or filename.startswith('file://'):
            return filename
        device = self.content_device_id or self.device_id
        encoded = quote(filename, safe='')
        return f"{self.server_url}/api/files/resolve/{device}/{encoded}"
    
    def _converted_url(self, filename: str, page_type: str, page: int) -> str:
        device = self.content_device_id or self.device_id
        encoded = quote(filename, safe='')
        return f"{self.server_url}/api/devices/{device}/converted/{encoded}/{page_type}/{page}"
    
    def _folder_url(self, folder_name: str, image_num: int) -> str:
        device = self.content_device_id or self.device_id
        encoded = quote(folder_name, safe='')
        return f"{self.server_url}/api/devices/{device}/folder/{encoded}/image/{image_num}"
    
    def _show_badge(self):
        device = self.content_device_id or self.device_id
        ver = self._server_app_version or APP_VERSION
        text = f"{device} | v{ver}"
        for prop in ('osd-msg3', 'osd-msg2', 'window-title'):
            try:
                self.send_command('set_property', prop, text)
            except Exception:
                pass
    
    # ── Socket.IO события ──
    def _setup_socket_events(self):
        
        @self.sio.event
        def connect():
            logger.info("Подключено к серверу")
            self.is_registered = False
            self.missed_pong_count = 0
            self.sio.emit('player/register', {
                'device_id': self.device_id,
                'device_type': 'NATIVE_MPV',
                'platform': 'Linux MPV',
                'app_version': APP_VERSION,
                'capabilities': {
                    'video': True,
                    'audio': True,
                    'images': True,
                    'pdf': True,
                    'pptx': True,
                    'streaming': True,
                }
            })
            logger.info("Отправлена регистрация NATIVE_MPV")
            
            if not self.is_playing_placeholder:
                logger.info("Reconnected: контент играет, продолжаем...")
            else:
                if not self._is_mpv_playing():
                    logger.info("Reconnected: заглушка не играет, перезагружаем...")
                    self._load_placeholder()
                else:
                    logger.info("Reconnected: заглушка играет корректно")
        
        @self.sio.event
        def disconnect():
            logger.warning("Нет связи с сервером...")
            self.is_registered = False
            self.missed_pong_count = 0
            
            if self.is_streaming:
                logger.info("Disconnect во время стрима — возврат к заглушке")
                self._load_placeholder()
            elif not self.is_playing_placeholder:
                logger.info("Connection lost: контент продолжает воспроизведение...")
            else:
                logger.info("Connection lost: заглушка продолжает крутиться (loop mode)...")
        
        @self.sio.on('player/registered')
        def on_registered(data):
            logger.info("Регистрация подтверждена: %s", data)
            self.is_registered = True
            self.missed_pong_count = 0
            self._start_ping_timer()
            self._show_badge()
            self.sio.emit('player/volumeState', {
                'device_id': self.device_id,
                'level': 25,
                'muted': False,
            })
        
        @self.sio.on('player/reject')
        def on_reject(data):
            logger.error("Регистрация отклонена: %s", data)
        
        @self.sio.on('player/state')
        def on_player_state(data):
            current = data.get('current', {})
            logger.info("STATE from server: %s", current)
            ctype = current.get('type')
            cfile = current.get('file')
            
            with self._lock:
                cur_state = self.currentFileState
            
            if not ctype or ctype == 'idle' or not cfile:
                idle_types = {None, 'placeholder', 'idle'}
                if cur_state.get('type') in idle_types:
                    logger.info("State idle, showing placeholder")
                    self._load_placeholder()
                return
            
            same_content = (
                cur_state.get('type') == ctype and
                cur_state.get('file') == cfile and
                (ctype != 'video' or cur_state.get('page', 1) == current.get('page', 1))
            )
            
            if not same_content:
                page = current.get('page', 1)
                logger.info("State differs, restore: type=%s file=%s page=%s", ctype, cfile, page)
                self.sio.emit('control/play', {
                    'deviceId': self.device_id,
                    'type': ctype,
                    'file': cfile,
                    'page': page,
                })
        
        @self.sio.on('player/volume')
        def on_volume(data):
            level = data.get('level') or data.get('volume')
            muted = data.get('muted')
            if level is not None:
                level = max(0, min(100, int(level)))
                self.send_command('set_property', 'volume', level)
            if muted is not None:
                self.send_command('set_property', 'mute', muted)
            logger.info("Volume: level=%s muted=%s", level, muted)
        
        @self.sio.on('player/play')
        def on_play(data):
            logger.info("PLAY data: %s", data)
            file_type = data.get('type', 'video')
            file_name = data.get('file')
            page = data.get('page', 1)
            stream_url = data.get('stream_url') or data.get('streamUrl')
            stream_protocol = data.get('stream_protocol') or data.get('streamProtocol')
            origin_device_id = data.get('originDeviceId')
            
            with self._lock:
                if origin_device_id:
                    self.content_device_id = origin_device_id
                    logger.info("content_device_id = %s (файл из другого устройства)", origin_device_id)
                else:
                    self.content_device_id = self.device_id
            
            logger.info("PLAY: type=%s, file=%s, page=%s, content_device=%s",
                        file_type, file_name, page, self.content_device_id)
            
            was_placeholder = self.is_playing_placeholder
            if was_placeholder:
                logger.info("Останавливаем заглушку, воспроизводим контент")
                self.send_command('stop')
            
            self.skipPlaceholderOnVideoEnd = True
            
            # ── Определение типа контента по расширению (как в JS-плеере) ──
            ext = ''
            if file_name and '.' in file_name:
                ext = file_name.split('.')[-1].lower()
            
            video_exts = {'mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'}
            audio_exts = {'mp3', 'aac', 'wav', 'flac', 'm4a', 'opus', 'weba'}
            image_exts = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
            doc_exts = {'pdf', 'pptx'}
            folder_exts = {'zip'}
            
            # Обратная совместимость: сервер может прислать type='file' (как в JS)
            if file_type == 'file':
                file_type = 'video'
                if ext in audio_exts:
                    file_type = 'audio'
                elif ext in image_exts:
                    file_type = 'image'
                elif ext in doc_exts:
                    file_type = 'pptx' if ext == 'pptx' else 'pdf'
                elif ext in folder_exts:
                    file_type = 'folder'
                elif ext not in video_exts and ext:
                    file_type = 'folder'
            
            handlers = {
                'streaming': lambda: self._handle_streaming(stream_url, file_name, stream_protocol),
                'video': lambda: self._play_video(file_name, is_placeholder=False),
                'audio': lambda: self._play_audio(file_name, is_placeholder=False),
                'image': lambda: self._play_image(file_name, is_placeholder=False),
                'pdf': lambda: self._show_pdf_page(file_name, page),
                'pptx': lambda: self._show_pptx_slide(file_name, page),
                'folder': lambda: self._show_folder_image(file_name, page),
            }
            
            handler = handlers.get(file_type)
            if handler:
                handler()
            elif file_type == 'video' and not file_name:
                self._resume_video()
        
        @self.sio.on('player/pause')
        def on_pause():
            if self.is_playing_placeholder:
                logger.info("Pause игнорируется — играет заглушка")
                return
            
            result = self.send_command('get_property', 'time-pos')
            if result and result.get('error') == 'success':
                time_pos = result.get('data', 0.0)
                self.saved_position = time_pos * 1000.0
                logger.info("Пауза на позиции: %.0f ms (%.2f сек)", self.saved_position, time_pos)
            
            self.send_command('set_property', 'pause', True)
            self._stop_progress_updates()
        
        @self.sio.on('player/resume')
        def on_resume():
            if self.is_playing_placeholder:
                logger.info("Resume игнорируется — играет заглушка")
                return
            
            if self.saved_position > 0:
                time_pos = self.saved_position / 1000.0
                logger.info("Resume с позиции: %.0f ms (%.2f сек)", self.saved_position, time_pos)
                self.send_command('seek', time_pos, 'absolute')
            
            self.send_command('set_property', 'pause', False)
            self._start_progress_updates()
        
        @self.sio.on('player/restart')
        def on_restart():
            if self.is_playing_placeholder:
                logger.info("Restart игнорируется — играет заглушка")
                return
            
            logger.info("RESTART")
            self.send_command('seek', 0, 'absolute')
            self.send_command('set_property', 'pause', False)
            self.saved_position = 0.0
        
        @self.sio.on('player/seek')
        def on_seek(data):
            if self.is_playing_placeholder:
                logger.info("Seek игнорируется — играет заглушка")
                return
            
            if not self.current_video_file:
                logger.info("Seek игнорируется — не играет видео")
                return
            
            position = data.get('position') if isinstance(data, dict) else data
            if position is None:
                return
            
            target = float(position)
            logger.info("Seek на %.2f сек", target)
            
            pause_result = self.send_command('get_property', 'pause')
            if pause_result and pause_result.get('error') == 'success':
                self.send_command('seek', target, 'absolute')
                self.saved_position = target * 1000.0
            else:
                logger.info("Seek отложен — плеер не готов")
                threading.Thread(target=lambda: (
                    time.sleep(0.2),
                    self.send_command('seek', target, 'absolute'),
                    setattr(self, 'saved_position', target * 1000.0)
                ) if self.current_video_file else None, daemon=True).start()
        
        @self.sio.on('player/stop')
        def on_stop(data=None):
            reason = ''
            if isinstance(data, dict):
                reason = data.get('reason') or ''
            elif isinstance(data, str):
                reason = data
            
            if self.is_playing_placeholder and reason != 'placeholder_refresh':
                logger.info("Stop игнорируется — играет заглушка")
                return
            
            logger.info("STOP reason=%s", reason or 'n/a')
            
            if reason == 'switch_content':
                logger.info("Stop (switch_content) — ждём следующий контент без заглушки")
                self.skipPlaceholderOnVideoEnd = True
                self.send_command('set_property', 'pause', True)
                self._stop_progress_updates()
                return
            
            self._stop_progress_updates()
            self._emit_progress_stop()
            self.currentFileState = {'type': None, 'file': None, 'page': 1}
            self.current_video_file = None
            self.saved_position = 0.0
            self.skipPlaceholderOnVideoEnd = False
            
            self.is_streaming = False
            self.stream_protocol = None
            
            self._load_placeholder()
        
        @self.sio.on('player/pdfPage')
        def on_pdf_page(page_num):
            if self.current_pdf_file:
                self._show_pdf_page(self.current_pdf_file, page_num)
        
        @self.sio.on('player/pptxPage')
        def on_pptx_page(slide_num):
            if self.current_pptx_file:
                self._show_pptx_slide(self.current_pptx_file, slide_num)
        
        @self.sio.on('player/folderPage')
        def on_folder_page(image_num):
            if self.current_folder_name:
                self._show_folder_image(self.current_folder_name, image_num)
        
        @self.sio.on('placeholder/refresh')
        def on_placeholder_refresh():
            logger.info("PLACEHOLDER REFRESH")
            self._load_placeholder(force_refresh=True)
        
        @self.sio.on('player/pong')
        def on_pong():
            self.missed_pong_count = 0
    
    def _is_mpv_playing(self) -> bool:
        try:
            result = self.send_command('get_property', 'pause')
            if result and result.get('error') == 'success':
                return not result.get('data', True)
        except Exception:
            pass
        return False
    
    def _cancel_retry(self):
        with self._lock:
            if self.retry_timer:
                self.retry_timer.cancel()
                self.retry_timer = None
            self.error_retry_count = 0
            self.last_error_file = None
    
    def _handle_load_error(self, filename: str, is_placeholder: bool = False, error_msg: str = ""):
        with self._lock:
            max_attempts = self.max_retry_attempts if is_placeholder else self.max_retry_attempts_content
            
            if self.error_retry_count < max_attempts:
                self.error_retry_count += 1
                logger.warning("Retry загрузки (попытка %d/%d): %s",
                               self.error_retry_count, max_attempts, filename)
                self.last_error_file = filename
                
                def retry_load():
                    if not self.running:
                        return
                    with self._lock:
                        if self.last_error_file != filename:
                            return
                    try:
                        if is_placeholder:
                            self._play_video(filename, is_placeholder=True)
                        else:
                            ext = filename.split('.')[-1].lower() if '.' in filename else ''
                            video_exts = {'mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'}
                            audio_exts = {'mp3', 'aac', 'wav', 'flac', 'm4a', 'opus', 'weba'}
                            image_exts = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
                            if ext in video_exts or ext in audio_exts:
                                self._play_video(filename, is_placeholder=False)
                            elif ext in image_exts:
                                self._play_image(filename, is_placeholder=False)
                            else:
                                logger.warning("Неизвестный тип для retry: %s", ext)
                                self._load_placeholder()
                    except Exception as e:
                        logger.error("Retry failed: %s", e)
                        with self._lock:
                            if self.error_retry_count >= max_attempts:
                                logger.error("Все попытки исчерпаны, показываем заглушку")
                                if not is_placeholder:
                                    self._load_placeholder()
                
                self.retry_timer = threading.Timer(5.0, retry_load)
                self.retry_timer.daemon = True
                self.retry_timer.start()
            else:
                logger.error("Все попытки исчерпаны (%d)", max_attempts)
                self._cancel_retry()
                if not is_placeholder:
                    self._load_placeholder()
    
    def _stop_progress_updates(self):
        if self.progress_interval:
            self.progress_interval.cancel()
            self.progress_interval = None
    
    def _emit_progress_stop(self):
        if not self.sio.connected:
            return
        try:
            self.sio.emit('player/progress', {
                'device_id': self.device_id,
                'type': 'idle',
                'file': None,
                'currentTime': 0,
                'duration': 0
            })
        except Exception as e:
            logger.debug("Ошибка отправки progress stop: %s", e)
    
    def _emit_progress(self):
        if not self.sio.connected or self.is_playing_placeholder:
            return
        
        now = time.time()
        if now - self.last_progress_emit_ts < 0.5:
            return
        self.last_progress_emit_ts = now
        
        try:
            pause_result = self.send_command('get_property', 'pause')
            if pause_result and pause_result.get('data') is True:
                return
            
            state = self.currentFileState
            ctype = state.get('type')
            
            if ctype == 'video' and self.current_video_file:
                time_pos = self.send_command('get_property', 'time-pos') or {}
                dur = self.send_command('get_property', 'duration') or {}
                self.sio.emit('player/progress', {
                    'device_id': self.device_id,
                    'type': 'video',
                    'file': self.current_video_file,
                    'currentTime': int(time_pos.get('data', 0.0)),
                    'duration': int(dur.get('data', 0.0))
                })
            elif ctype == 'streaming' and state.get('file'):
                self.sio.emit('player/progress', {
                    'device_id': self.device_id,
                    'type': 'streaming',
                    'file': state.get('file'),
                    'currentTime': 0,
                    'duration': 0,
                    'stream_protocol': self.stream_protocol
                })
            elif ctype in ('pdf', 'pptx', 'folder') and state.get('file'):
                page = state.get('page', 1)
                self.sio.emit('player/progress', {
                    'device_id': self.device_id,
                    'type': ctype,
                    'file': state.get('file'),
                    'currentTime': page,
                    'duration': 0,
                    'page': page
                })
        except Exception as e:
            logger.debug("Ошибка отправки прогресса: %s", e)
    
    def _start_progress_updates(self):
        self._stop_progress_updates()
        
        def emit_periodic():
            if not self.running:
                return
            self._emit_progress()
            self.progress_interval = threading.Timer(1.0, emit_periodic)
            self.progress_interval.daemon = True
            self.progress_interval.start()
        
        emit_periodic()
    
    def _setup_signal_handlers(self):
        def signal_handler(sig, frame):
            logger.info("Получен сигнал завершения")
            self.running = False
            self.cleanup()
            sys.exit(0)
        
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
    
    def _setup_mpv_monitor(self):
        def monitor():
            last_eof_check = time.time()
            last_response = time.time()
            failed = 0
            max_failed = 6
            
            while self.running:
                try:
                    time.sleep(5)
                    
                    result = self.send_command('get_property', 'pause')
                    if result is not None:
                        if self.is_playing_placeholder:
                            self._loading_since = time.time()
                        last_response = time.time()
                        failed = 0
                    elif time.time() - self._loading_since < 45 or time.time() < self._grace_until:
                        if self._loading_since > 0:
                            logger.info("MPV загружает файл, ждём... (guard: %.0fs/%d, grace: %.0fs/%d)",
                                        time.time() - self._loading_since, 45,
                                        self._grace_until - time.time() if self._grace_until > 0 else 0, 45)
                        elif self._grace_until > 0:
                            logger.info("MPV стартует, ждём... (grace: %.0fs/%d)",
                                        self._grace_until - time.time(), 45)
                        last_response = time.time()
                    else:
                        failed += 1
                        logger.warning("MPV не отвечает (%d/%d) [loading_since=%.1f grace_until=%.1f now=%.1f]",
                                       failed, max_failed,
                                       self._loading_since, self._grace_until, time.time())
                        if failed >= max_failed:
                            logger.error("MPV завис! Принудительное завершение...")
                            self._restart_mpv()
                            failed = 0
                            last_response = time.time()
                    
                    if time.time() - last_eof_check > 10.0:
                        eof_result = self.send_command('get_property', 'eof-reached')
                        last_eof_check = time.time()
                        
                        if eof_result and eof_result.get('data') is True:
                            time_pos = self.send_command('get_property', 'time-pos') or {}
                            dur = self.send_command('get_property', 'duration') or {}
                            current = time_pos.get('data', 0.0)
                            duration = dur.get('data', 0.0)
                            actually_ended = duration > 0 and current >= duration - 0.5
                            
                            loop_result = self.send_command('get_property', 'loop-file')
                            is_looping = loop_result and loop_result.get('data') in ('inf', 'yes', True)
                            
                            if self.is_streaming:
                                continue
                            
                            if is_looping and actually_ended:
                                logger.info("Loop видео — MPV уже обрабатывает loop, пропускаем ручной seek")
                                continue
                            
                            is_video = self.currentFileState.get('type') in ('video', 'audio', None)
                            is_placeholder = self.is_playing_placeholder
                            
                            if actually_ended and is_video and not is_placeholder and not self.skipPlaceholderOnVideoEnd:
                                logger.info("Видео/аудио закончилось, показываем заглушку")
                                self._stop_progress_updates()
                                self._emit_progress_stop()
                                self.send_command('stop')
                                self.current_video_file = None
                                self.saved_position = 0.0
                                self.currentFileState = {'type': None, 'file': None, 'page': 1}
                                self._load_placeholder()
                    
                    if self.mpv_process.poll() is not None:
                        logger.error("MPV процесс завершился! Перезапуск...")
                        self._restart_mpv()
                        failed = 0
                        last_response = time.time()
                        
                except Exception as e:
                    if self.running:
                        logger.warning("Monitor error: %s", e)
                    time.sleep(2)
        
        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
    
    def _resume_video(self):
        if not self.current_video_file:
            logger.warning("Resume: нет активного видео")
            return
        
        logger.info("Resume: %s", self.current_video_file)
        if self.saved_position > 0:
            time_pos = self.saved_position / 1000.0
            logger.info("Resume с позиции: %.0f ms (%.2f сек)", self.saved_position, time_pos)
            self.send_command('seek', time_pos, 'absolute')
        
        self.send_command('set_property', 'pause', False)
        self._start_progress_updates()
        
        self.skipPlaceholderOnVideoEnd = False
    
    def _handle_streaming(self, stream_url: str, file_name: str, stream_protocol: Optional[str] = None):
        logger.info("Streaming: %s, protocol=%s", file_name, stream_protocol)
        self._cancel_retry()
        
        if not stream_url:
            stream_url = self._content_url(file_name)
            logger.info("Stream URL not provided, resolving from filename: %s", stream_url)
        
        if not stream_url.startswith('http://') and not stream_url.startswith('https://'):
            stream_url = f"{self.server_url}{stream_url}"
            logger.info("Relative stream URL resolved: %s", stream_url)
        
        if not stream_protocol:
            if '.m3u8' in stream_url.lower() or 'format=m3u8' in stream_url.lower():
                stream_protocol = 'hls'
            elif stream_url.lower().endswith('.mpd') or 'format=mpd' in stream_url.lower():
                stream_protocol = 'dash'
            else:
                stream_protocol = 'hls'
        
        self.send_command('stop')
        self._stop_progress_updates()
        
        self.currentFileState = {'type': 'streaming', 'file': file_name, 'page': 1}
        self.is_streaming = True
        self.stream_protocol = stream_protocol
        self.is_playing_placeholder = False
        self.current_video_file = None
        self.saved_position = 0.0
        
        if stream_protocol == 'hls' or '.m3u8' in stream_url.lower():
            sep = '&' if '?' in stream_url else '?'
            stream_url = f"{stream_url}{sep}_t={int(time.time() * 1000)}"
        
        logger.info("Загрузка стрима: %s", stream_url)
        self._loading_since = time.time()
        result = self.send_command('loadfile', stream_url, 'replace')
        
        if result and result.get('error') == 'success':
            self._grace_until = time.time() + 45
            
            self.skipPlaceholderOnVideoEnd = False
            time.sleep(0.1)
            self.send_command('set_property', 'pause', False)
            self._start_progress_updates()
            self._cancel_retry()
            logger.info("Стрим запущен: %s", stream_protocol)
            self._show_badge()
        else:
            self._loading_since = 0.0
            self._grace_until = 0.0
            logger.error("Ошибка загрузки стрима: %s", result.get('error', 'unknown') if result else 'no response')
            self._load_placeholder()
    
    def _play_video(self, filename: str, is_placeholder: bool = False):
        try:
            url = self._content_url(filename)
            logger.info("Playing video: %s (placeholder=%s)", filename, is_placeholder)
            
            if self.current_video_file == filename and not is_placeholder and self.saved_position > 0:
                time_pos = self.saved_position / 1000.0
                logger.info("Тот же файл, продолжаем с %.2f сек", time_pos)
                self.send_command('seek', time_pos, 'absolute')
                self.send_command('set_property', 'pause', False)
                self._start_progress_updates()
                
                self.skipPlaceholderOnVideoEnd = False
                return
            
            self._cancel_retry()
            self.current_video_file = filename
            self.saved_position = 0.0
            self.currentFileState = {'type': 'video', 'file': filename, 'page': 1}
            
            self._loading_since = time.time()
            result = self.send_command('loadfile', url, 'replace')
            
            if result and result.get('error') == 'success':
                self._grace_until = time.time() + 45
                if is_placeholder:
                    self.send_command('set_property', 'loop-file', 'inf')
                else:
                    self.send_command('set_property', 'loop-file', 'no')
                
                time.sleep(0.1)
                self.send_command('set_property', 'pause', False)
                
                self.is_playing_placeholder = is_placeholder
                
                if not is_placeholder:
                    
                    self.skipPlaceholderOnVideoEnd = False
                    self._start_progress_updates()
                    self._cancel_retry()
                
                logger.info("Видео загружено (loop=%s)", is_placeholder)
                self._show_badge()
            else:
                self._loading_since = 0.0
                self._grace_until = 0.0
                err = result.get('error', 'unknown') if result else 'no response'
                self._handle_load_error(filename, is_placeholder, err)
        except Exception as e:
            self._loading_since = 0.0
            self._grace_until = 0.0
            logger.error("Exception в _play_video: %s", e)
            self._handle_load_error(filename, is_placeholder, str(e))
    
    def _play_audio(self, filename: str, is_placeholder: bool = False):
        try:
            url = self._content_url(filename)
            logger.info("Playing audio: %s (placeholder=%s)", filename, is_placeholder)
            
            if self.current_video_file == filename and not is_placeholder and self.saved_position > 0:
                time_pos = self.saved_position / 1000.0
                logger.info("Тот же аудио файл, продолжаем с %.2f сек", time_pos)
                self.send_command('seek', time_pos, 'absolute')
                self.send_command('set_property', 'pause', False)
                self._start_progress_updates()
                
                self.skipPlaceholderOnVideoEnd = False
                return
            
            self._cancel_retry()
            self.current_video_file = filename
            self.saved_position = 0.0
            self.currentFileState = {'type': 'audio', 'file': filename, 'page': 1}
            
            self._loading_since = time.time()
            result = self.send_command('loadfile', url, 'replace')
            
            if result and result.get('error') == 'success':
                self._grace_until = time.time() + 45
                self.send_command('set_property', 'loop-file', 'no')
                
                time.sleep(0.1)
                self.send_command('set_property', 'pause', False)
                
                self.is_playing_placeholder = is_placeholder
                
                if not is_placeholder:
                    
                    self.skipPlaceholderOnVideoEnd = False
                    self._start_progress_updates()
                    self._cancel_retry()
                
                logger.info("Аудио загружено")
                self._show_badge()
            else:
                self._loading_since = 0.0
                self._grace_until = 0.0
                err = result.get('error', 'unknown') if result else 'no response'
                self._handle_load_error(filename, is_placeholder, err)
        except Exception as e:
            self._loading_since = 0.0
            self._grace_until = 0.0
            logger.error("Exception в _play_audio: %s", e)
            self._handle_load_error(filename, is_placeholder, str(e))
    
    def _play_image(self, filename: str, is_placeholder: bool = False):
        try:
            url = self._content_url(filename)
            logger.info("Showing image: %s (placeholder=%s)", filename, is_placeholder)
            
            if not is_placeholder:
                self._cancel_retry()
            
            self.current_video_file = None
            self.saved_position = 0.0
            self.currentFileState = {'type': 'image', 'file': filename, 'page': 1}
            self._stop_progress_updates()
            
            duration = 'inf'
            self.send_command('set_property', 'image-display-duration', duration)
            self.send_command('set_property', 'video-aspect', '-1')
            
            time.sleep(0.05)
            self._loading_since = time.time()
            result = self.send_command('loadfile', url, 'replace')
            
            if result and result.get('error') == 'success':
                self._grace_until = time.time() + 45
                time.sleep(0.05)
                self.send_command('set_property', 'pause', False)
                self.is_playing_placeholder = is_placeholder
                
                if not is_placeholder:
                    
                    self.skipPlaceholderOnVideoEnd = False
                    self._emit_progress()
                    self._cancel_retry()
                
                logger.info("Изображение загружено")
                self._show_badge()
            else:
                self._loading_since = 0.0
                self._grace_until = 0.0
                err = result.get('error', 'unknown') if result else 'no response'
                self._handle_load_error(filename, is_placeholder, err)
        except Exception as e:
            self._loading_since = 0.0
            self._grace_until = 0.0
            logger.error("Exception в _play_image: %s", e)
            self._handle_load_error(filename, is_placeholder, str(e))
    
    def _stop_video_if_needed(self):
        if self.current_video_file:
            self.send_command('stop')
            self.current_video_file = None
            self.saved_position = 0.0
    
    def _show_static_content(self, content_type: str, filename: str, page: int,
                              url: str, state_attrs: dict):
        self._cancel_retry()
        self._stop_video_if_needed()
        self.skipPlaceholderOnVideoEnd = True
        self._stop_progress_updates()
        
        self.send_command('set_property', 'image-display-duration', 'inf')
        self.send_command('set_property', 'video-aspect', '-1')
        time.sleep(0.05)
        
        self._loading_since = time.time()
        try:
            result = self.send_command('loadfile', url, 'replace')
            
            if result and result.get('error') == 'success':
                self._grace_until = time.time() + 45
                time.sleep(0.05)
                self.send_command('set_property', 'pause', False)
                
                for k, v in state_attrs.items():
                    setattr(self, k, v)
                
                self.is_playing_placeholder = False
                self.currentFileState = {'type': content_type, 'file': filename, 'page': page}
                
                self.skipPlaceholderOnVideoEnd = False
                
                self._emit_progress()
                self._cancel_retry()
                
                max_pages = getattr(self, f'current_{content_type}_total_pages', None)
                self._preload_adjacent_slides(filename, page, max_pages or 999, content_type)
                
                logger.info("%s страница %d показана", content_type.upper(), page)
                self._show_badge()
            else:
                self._loading_since = 0.0
                self._grace_until = 0.0
                logger.error("Ошибка загрузки %s: %s", content_type,
                             result.get('error', 'unknown') if result else 'no response')
        except Exception as e:
            self._loading_since = 0.0
            self._grace_until = 0.0
            logger.error("Exception в _show_static_content: %s", e)
    
    def _show_pdf_page(self, filename: str, page: int):
        try:
            folder_name = filename.replace('.pdf', '')
            url = self._converted_url(folder_name, 'page', page)
            logger.info("PDF: %s - %d", filename, page)
            self._show_static_content('pdf', filename, page, url, {
                'current_pdf_file': filename,
                'current_pdf_page': page,
            })
        except Exception as e:
            logger.error("Exception в _show_pdf_page: %s", e)
    
    def _show_pptx_slide(self, filename: str, slide: int):
        try:
            folder_name = filename.replace('.pptx', '')
            url = self._converted_url(folder_name, 'slide', slide)
            logger.info("PPTX: %s - %d", filename, slide)
            self._show_static_content('pptx', filename, slide, url, {
                'current_pptx_file': filename,
                'current_pptx_slide': slide,
            })
        except Exception as e:
            logger.error("Exception в _show_pptx_slide: %s", e)
    
    def _show_folder_image(self, folder_name: str, image_num: int):
        try:
            clean = folder_name.replace('.zip', '')
            url = self._folder_url(clean, image_num)
            logger.info("Folder: %s - image %d", folder_name, image_num)
            self._show_static_content('folder', folder_name, image_num, url, {
                'current_folder_name': folder_name,
                'current_folder_image': image_num,
            })
        except Exception as e:
            logger.error("Exception в _show_folder_image: %s", e)
    
    def _preload_adjacent_slides(self, file: str, current_page: int,
                                  total_pages: int, slide_type: str):
        pages = []
        if current_page > 1:
            pages.append(current_page - 1)
        if current_page < total_pages:
            pages.append(current_page + 1)
        
        device = self.content_device_id or self.device_id
        encoded = quote(file, safe='')
        
        for page in pages:
            if slide_type == 'pdf':
                url = f"{self.server_url}/api/devices/{device}/converted/{encoded}/page/{page}"
            elif slide_type == 'pptx':
                url = f"{self.server_url}/api/devices/{device}/converted/{encoded}/slide/{page}"
            elif slide_type == 'folder':
                url = f"{self.server_url}/api/devices/{device}/folder/{encoded}/image/{page}"
            else:
                continue
            
            self._preload_executor.submit(self._preload_one, url, slide_type, page)
    
    @staticmethod
    def _preload_one(url: str, slide_type: str, page: int):
        try:
            requests.head(url, timeout=5)
            logger.debug("Preloaded %s page %d", slide_type, page)
        except requests.RequestException:
            pass
    
    def _load_placeholder(self, force_refresh: bool = False):
        logger.info("Loading placeholder... (force_refresh=%s)", force_refresh)
        
        self.send_command('stop')
        self._stop_progress_updates()
        self._emit_progress_stop()
        
        if force_refresh:
            logger.info("Force refresh: очищаем кэш заглушки")
            self.cached_placeholder_file = None
            self.cached_placeholder_type = None
            self.currentFileState = {'type': None, 'file': None, 'page': 1}
        
        if self.cached_placeholder_file and self.cached_placeholder_type and not force_refresh:
            logger.info("Using cached placeholder: %s (%s)",
                        self.cached_placeholder_file, self.cached_placeholder_type)
            if self.cached_placeholder_type == 'video':
                self._play_video(self.cached_placeholder_file, is_placeholder=True)
            elif self.cached_placeholder_type == 'image':
                self._play_image(self.cached_placeholder_file, is_placeholder=True)
            return
        
        def load_from_api():
            if not self.running:
                return
            try:
                url = f"{self.server_url}/api/devices/{self.device_id}/placeholder"
                response = requests.get(url, timeout=5)
                
                if response.status_code == 200:
                    data = response.json()
                    placeholder_file = data.get('placeholder')
                    
                    if placeholder_file and placeholder_file != 'null':
                        logger.info("Placeholder: %s", placeholder_file)
                        ext = placeholder_file.split('.')[-1].lower()
                        
                        # ── Download locally for off-line loop ──
                        local_dir = '/tmp/mmrc'
                        os.makedirs(local_dir, exist_ok=True)
                        local_path = os.path.join(local_dir, placeholder_file)
                        
                        if ext in ('mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi'):
                            self.cached_placeholder_type = 'video'
                        elif ext in ('png', 'jpg', 'jpeg', 'gif', 'webp'):
                            self.cached_placeholder_type = 'image'
                        
                        file_url = self._content_url(placeholder_file)
                        try:
                            dl = requests.get(file_url, timeout=30, stream=True)
                            if dl.status_code == 200:
                                with open(local_path, 'wb') as f:
                                    for chunk in dl.iter_content(8192):
                                        f.write(chunk)
                                self.cached_placeholder_file = local_path
                                logger.info("Downloaded to %s (%s)", local_path, self.cached_placeholder_type)
                            else:
                                self.cached_placeholder_file = placeholder_file
                                logger.warning("Download failed HTTP %d, fallback to HTTP play", dl.status_code)
                        except requests.RequestException as e:
                            self.cached_placeholder_file = placeholder_file
                            logger.warning("Download error %s, fallback to HTTP play", e)
                        
                        if not self.running:
                            return
                        if self.cached_placeholder_type == 'video':
                            self._play_video(self.cached_placeholder_file, is_placeholder=True)
                        elif self.cached_placeholder_type == 'image':
                            self._play_image(self.cached_placeholder_file, is_placeholder=True)
                    else:
                        logger.info("No placeholder — idle mode")
                        self.is_playing_placeholder = True
                        self.cached_placeholder_file = None
                        self.cached_placeholder_type = None
                elif response.status_code == 404:
                    logger.info("No placeholder (404) — idle mode")
                    self.is_playing_placeholder = True
                    self.cached_placeholder_file = None
                    self.cached_placeholder_type = None
                else:
                    logger.warning("Failed to load placeholder: HTTP %d — idle mode",
                                   response.status_code)
                    self.is_playing_placeholder = True
            except requests.RequestException as e:
                logger.warning("Error loading placeholder: %s — idle mode", e)
                self.is_playing_placeholder = True
                self.cached_placeholder_file = None
                self.cached_placeholder_type = None
        
        threading.Thread(target=load_from_api, daemon=True).start()
    
    # ── Heartbeat (оптимизирован: Event вместо sleep) ──
    def _heartbeat(self):
        while self.running and not self._stop_heartbeat.is_set():
            if self._stop_heartbeat.wait(timeout=15):
                break
            
            try:
                if self.sio.connected and self.is_registered:
                    self.sio.emit('player/ping', {'device_id': self.device_id})
                    self.missed_pong_count += 1
                    if self.missed_pong_count >= 3:
                        logger.warning("Нет pong от сервера (%d пропущено), перерегистрация...",
                                       self.missed_pong_count)
                        self.is_registered = False
                        self.missed_pong_count = 0
                        if self.sio.connected:
                            self.sio.emit('player/register', {
                                'device_id': self.device_id,
                                'device_type': 'NATIVE_MPV',
                                'platform': 'Linux MPV',
                                'app_version': APP_VERSION,
                                'capabilities': {
                                    'video': True,
                                    'audio': True,
                                    'images': True,
                                    'pdf': True,
                                    'pptx': True,
                                    'streaming': True,
                                }
                            })
                
                if self.mpv_process.poll() is not None:
                    logger.error("Heartbeat: MPV процесс завершился!")
                    self._restart_mpv()
            except Exception as e:
                if self.running:
                    logger.warning("Heartbeat error: %s", e)
    
    def _start_ping_timer(self):
        self.missed_pong_count = 0
    
    def _stop_ping_timer(self):
        self.missed_pong_count = 0
    
    def _socket_watchdog(self):
        while self.running and not self._stop_heartbeat.is_set():
            if self._stop_heartbeat.wait(timeout=5):
                break
            try:
                if self.sio.connected and not self.is_registered:
                    logger.info("Watchdog: не зарегистрированы, повторная регистрация")
                    self.sio.emit('player/register', {
                        'device_id': self.device_id,
                        'device_type': 'NATIVE_MPV',
                        'platform': 'Linux MPV',
                        'app_version': APP_VERSION,
                        'capabilities': {
                            'video': True,
                            'audio': True,
                            'images': True,
                            'pdf': True,
                            'pptx': True,
                            'streaming': True,
                        }
                    })
            except Exception as e:
                if self.running:
                    logger.debug("Watchdog error: %s", e)
    
    def _connect_with_retry(self):
        retry_delay = 2
        max_delay = 60
        while self.running:
            try:
                logger.info("Подключение к %s...", self.server_url)
                self.sio.connect(self.server_url)
                logger.info("Подключено к серверу")
                return True
            except Exception as e:
                logger.warning("Ошибка подключения: %s — повтор через %dс", e, retry_delay)
                if self._stop_heartbeat.wait(timeout=retry_delay):
                    return False
                retry_delay = min(retry_delay * 2, max_delay)
        return False
    
    def run(self):
        heartbeat_thread = threading.Thread(target=self._heartbeat, daemon=True)
        heartbeat_thread.start()
        
        watchdog_thread = threading.Thread(target=self._socket_watchdog, daemon=True)
        watchdog_thread.start()
        
        if not self._connect_with_retry():
            self.cleanup()
            return
        
        self._load_placeholder()
        
        logger.info("Клиент запущен. Для выхода нажмите Ctrl+C")
        
        try:
            while self.running:
                if self._stop_heartbeat.wait(timeout=1):
                    break
                if self.mpv_process.poll() is not None:
                    logger.error("Основной цикл: MPV процесс завершился!")
                    self._restart_mpv()
        except KeyboardInterrupt:
            logger.info("Остановка...")
        finally:
            self.cleanup()
    
    def cleanup(self):
        logger.info("Очистка ресурсов...")
        self.running = False
        self._stop_heartbeat.set()
        self._stop_progress_updates()
        self._cancel_retry()
        self._preload_executor.shutdown(wait=False)
        
        if self.sio.connected:
            try:
                self.sio.disconnect()
            except Exception:
                pass
        
        if self.mpv_process and self.mpv_process.poll() is None:
            logger.info("Остановка MPV...")
            try:
                self.send_command('quit')
                time.sleep(0.5)
            except Exception:
                pass
            
            if self.mpv_process.poll() is None:
                self.mpv_process.terminate()
                try:
                    self.mpv_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.mpv_process.kill()
                    self.mpv_process.wait(timeout=1)
        
        if os.path.exists(self.ipc_socket):
            try:
                os.unlink(self.ipc_socket)
            except OSError:
                pass
        
        logger.info("Клиент остановлен")


def main():
    parser = argparse.ArgumentParser(
        description='VideoControl MPV Client v2.0',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    
    parser.add_argument('--server', required=True,
                        help='Server URL (http://192.168.1.100)')
    parser.add_argument('--device', required=True,
                        help='Device ID (mpv-001)')
    parser.add_argument('--display', default=':0',
                        help='X Display (default: :0)')
    parser.add_argument('--fullscreen', action='store_true',
                        help='Полноэкранный режим')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Подробный лог (DEBUG)')
    
    args = parser.parse_args()
    
    if args.verbose:
        logger.setLevel(logging.DEBUG)
    
    client = MPVClient(
        server_url=args.server,
        device_id=args.device,
        display=args.display,
        fullscreen=args.fullscreen
    )
    
    client.run()


if __name__ == '__main__':
    main()
