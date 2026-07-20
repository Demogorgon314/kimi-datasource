export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNotFound(err) {
  return isRecord(err) && err.code === 'ENOENT';
}

export function asciiHeader(value, fallback = 'unknown') {
  const cleaned = String(value).replaceAll(/[^ -~]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}
