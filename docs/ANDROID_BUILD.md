# Сборка нативного Android приложения

## Вариант 1: Android Studio (рекомендуется)

1. **Установите Android Studio:**
   ```bash
   sudo snap install android-studio --classic
   ```

2. **Откройте проект:**
    - Запустите Android Studio
    - File → Open → выберите `/vid/videocontrol/clients/android-mediaplayer`
    - Дождитесь синхронизации Gradle

3. **Настройте:**
    - Откройте `MainActivity.kt`
    - Измените `SERVER_URL` и `DEVICE_ID`

4. **Соберите APK:**
    - Build → Build Bundle(s) / APK(s) → Build APK(s)
    - APK будет в `app/build/outputs/apk/debug/`

5. **Установите:**
   ```bash
   adb install app/build/outputs/apk/debug/app-debug.apk
   ```

## Вариант 2: Командная строка (требует правильный Gradle)

```bash
# Установите Gradle 8.1+
sdk install gradle 8.1.1

# Создайте wrapper
gradle wrapper --gradle-version 8.1.1

# Соберите
./gradlew assembleDebug

# APK в app/build/outputs/apk/debug/app-debug.apk
```

## Текущая проблема

Системный Gradle (4.4.1) слишком старый для Android Gradle Plugin 8.1.  
**Решение:** Используйте Android Studio.

## Быстрое решение

Если срочно нужен APK:

1. Скопируйте папку `android-mediaplayer` на машину с Android Studio
2. Соберите там
3. Скопируйте APK обратно

Или используйте Docker:

```bash
docker run --rm -v $(pwd):/project mingc/android-build-box bash -c "cd /project && ./gradlew assembleDebug"
```

