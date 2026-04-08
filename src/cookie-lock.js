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
