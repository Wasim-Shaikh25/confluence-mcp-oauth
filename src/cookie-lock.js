import fs from "node:fs";

const RETRY_MS = 50;

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short spin wait for lock release
  }
}
const MAX_WAIT_MS = 10_000;

/**
 * Serialize sync read/write of the cookie JSON to avoid corruption from parallel tool calls.
 * @template T
 * @param {string} filePath
 * @param {() => T} fn
 * @returns {T}
 */
export function withCookieFileLockSync(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") {
        throw e;
      }
      sleepSync(RETRY_MS);
    }
  }
  throw new Error(`Cookie file lock timeout after ${MAX_WAIT_MS}ms: ${filePath}`);
}

/**
 * Delete the cookie file (and any stale lock) under the file lock. Used by the
 * keep-alive when the session is confirmed dead after repeated auth failures.
 * Safe: no-op if the file is already gone.
 * @param {string} filePath
 * @returns {boolean} true if a file was deleted
 */
export function deleteCookieFileSync(filePath) {
  return withCookieFileLockSync(filePath, () => {
    let deleted = false;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted = true;
      }
    } catch {
      // ignore — best-effort cleanup
    }
    return deleted;
  });
}
