/**
 * MD5 Helper - вычисление MD5 хэша файла в браузере
 * Используется для дедупликации перед загрузкой
 */

/**
 * Вычислить MD5 хэш файла в браузере (SparkMD5)
 * @param {File} file - Файл для хэширования
 * @param {Function} onProgress - Колбэк прогресса (0-100)
 * @returns {Promise<string>} - MD5 хэш в hex формате
 */
export async function calculateFileMD5(file, onProgress = null) {
  // Проверяем доступность SparkMD5
  if (typeof SparkMD5 === 'undefined') {
    return simpleHash(file);
  }
  
  try {
    // Для больших файлов (>100MB) хэшируем только первые 10MB для скорости
    const chunkSize = 2 * 1024 * 1024; // 2 MB chunk size
    const isBigFile = file.size > 100 * 1024 * 1024;
    const maxBytes = isBigFile ? (10 * 1024 * 1024) : file.size; // Макс 10MB для больших файлов
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const spark = new SparkMD5.ArrayBuffer();
      let bytesRead = 0;
      
      reader.onload = (e) => {
        spark.append(e.target.result);
        bytesRead += e.target.result.byteLength;
        
        if (onProgress) {
          const progress = Math.round((bytesRead / maxBytes) * 100);
          onProgress(Math.min(progress, 100));
        }
        
        if (bytesRead < maxBytes && bytesRead < file.size) {
          loadNext();
        } else {
          const md5 = spark.end();
          if (onProgress) onProgress(100);
          resolve(md5);
        }
      };
      
      reader.onerror = () => reject(new Error('Failed to read file'));
      
      function loadNext() {
        const start = bytesRead;
        const end = Math.min(start + chunkSize, maxBytes, file.size);
        const slice = file.slice(start, end);
        reader.readAsArrayBuffer(slice);
      }
      
      loadNext();
    });
  } catch (e) {
    console.error('[MD5] Error calculating MD5:', e);
    // Fallback: используем простой хэш
    return simpleHash(file);
  }
}

/**
 * Простой хэш для fallback (если SparkMD5 не доступен)
 */
function simpleHash(file) {
  const str = `${file.name}-${file.size}-${file.lastModified}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(32, '0');
}

/**
 * Проверить доступна ли библиотека SparkMD5
 */
export function isMD5Available() {
  return typeof SparkMD5 !== 'undefined';
}

