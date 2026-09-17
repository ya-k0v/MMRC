# ADB Diagnostics

## Connection

```bash
adb devices
adb connect <IP>:5555
adb disconnect <IP>:5555
```

## Device Info

```bash
adb -s <IP>:5555 shell getprop ro.product.model
adb -s <IP>:5555 shell getprop ro.build.version.release
adb -s <IP>:5555 shell getprop ro.build.characteristics
adb -s <IP>:5555 shell getprop ro.serialno
adb -s <IP>:5555 shell ip addr show wlan0 | grep "inet "
```

## MMRC App

```bash
adb -s <IP>:5555 install -r /path/to/app-release.apk
adb -s <IP>:5555 shell am start -n com.videocontrol.mediaplayer/.MainActivity
adb -s <IP>:5555 shell am force-stop com.videocontrol.mediaplayer
adb -s <IP>:5555 shell dumpsys package com.videocontrol.mediaplayer | grep versionName
adb -s <IP>:5555 shell logcat -d -t 100 | grep -i "videocontrol\|mmrc"
adb -s <IP>:5555 shell pm list packages | grep videocontrol
adb -s <IP>:5555 shell pm clear com.videocontrol.mediaplayer
```

## System Commands

```bash
adb -s <IP>:5555 reboot
adb -s <IP>:5555 shell screencap -p /sdcard/screen.png
adb -s <IP>:5555 pull /sdcard/screen.png ./screen.png
adb -s <IP>:5555 shell ping -c 3 <SERVER_IP>
adb -s <IP>:5555 shell df -h /data
adb -s <IP>:5555 shell ps | grep -i "video\|media"
adb -s <IP>:5555 shell media volume --get
adb -s <IP>:5555 shell media volume --set 10
adb kill-server
adb start-server
```

## Troubleshooting

### Device not connecting

```bash
adb devices
nc -zv <IP> 5555
adb kill-server
adb start-server
adb connect <IP>:5555
```

### App not launching

```bash
adb -s <IP>:5555 shell pm list packages | grep videocontrol
adb -s <IP>:5555 shell dumpsys package com.videocontrol.mediaplayer | grep -A5 "Activity"
adb -s <IP>:5555 shell pm clear com.videocontrol.mediaplayer
```