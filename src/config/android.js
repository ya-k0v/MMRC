/**
 * Конфигурация Android-приложения для ADB-операций
 * @module config/android
 */

export const ANDROID_PACKAGE_NAME = process.env.MMRC_ANDROID_PACKAGE || 'com.videocontrol.mediaplayer';
export const ANDROID_MAIN_ACTIVITY = process.env.MMRC_ANDROID_ACTIVITY || `${ANDROID_PACKAGE_NAME}.MainActivity`;
export const ANDROID_CONFIG_RECEIVER = `${ANDROID_PACKAGE_NAME}/.ConfigReceiver`;
export const ANDROID_CONFIGURE_ACTION = `${ANDROID_PACKAGE_NAME}.CONFIGURE`;
export const DEFAULT_ADB_PORT = process.env.MMRC_ADB_PORT || 5555;