/**
 * MuSig2 Session Lock
 *
 * Provides mutex-style locking for session operations to prevent race conditions
 * when multiple participants attempt concurrent operations on the same session.
 *
 * @module SessionLock
 */

/**
 * Session-level mutex for preventing race conditions
 *
 * This class provides a simple async mutex implementation that ensures
 * only one operation can modify a session at a time. This prevents
 * issues like:
 * - Two participants joining simultaneously and corrupting the participants map
 * - Concurrent nonce submissions causing state inconsistencies
 * - Race conditions during phase transitions
 */
export class SessionLock {
  private locks: Map<string, Promise<void>> = new Map()
  private resolvers: Map<string, () => void> = new Map()

  /**
   * Acquire a lock for a session
   *
   * If the session is already locked, this will wait until the lock is released.
   * Returns a release function that MUST be called when the operation is complete.
   *
   * @param sessionId - The session ID to lock
   * @returns A release function to call when done
   *
   * @example
   * ```typescript
   * const release = await sessionLock.acquire(sessionId)
   * try {
   *   // ... perform session operations
   * } finally {
   *   release()
   * }
   * ```
   */
  async acquire(sessionId: string): Promise<() => void> {
    // Wait for any existing lock to be released
    const existing = this.locks.get(sessionId)
    if (existing) {
      await existing
    }

    // Create new lock
    let release: () => void
    const lock = new Promise<void>(resolve => {
      release = resolve
    })

    this.locks.set(sessionId, lock)
    this.resolvers.set(sessionId, release!)

    // Return release function
    return () => {
      this.locks.delete(sessionId)
      this.resolvers.delete(sessionId)
      release()
    }
  }

  /**
   * Try to acquire a lock without waiting
   *
   * Returns null if the session is already locked, otherwise returns
   * the release function.
   *
   * @param sessionId - The session ID to lock
   * @returns Release function if lock acquired, null if already locked
   */
  tryAcquire(sessionId: string): (() => void) | null {
    if (this.locks.has(sessionId)) {
      return null
    }

    let release: () => void
    const lock = new Promise<void>(resolve => {
      release = resolve
    })

    this.locks.set(sessionId, lock)
    this.resolvers.set(sessionId, release!)

    return () => {
      this.locks.delete(sessionId)
      this.resolvers.delete(sessionId)
      release!()
    }
  }

  /**
   * Check if a session is currently locked
   *
   * @param sessionId - The session ID to check
   * @returns True if the session is locked
   */
  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId)
  }

  /**
   * Force release a lock (use with caution)
   *
   * This should only be used in cleanup scenarios where the lock holder
   * may have crashed or timed out.
   *
   * @param sessionId - The session ID to unlock
   */
  forceRelease(sessionId: string): void {
    const resolver = this.resolvers.get(sessionId)
    if (resolver) {
      this.locks.delete(sessionId)
      this.resolvers.delete(sessionId)
      resolver()
    }
  }

  /**
   * Clear all locks (use during cleanup/shutdown)
   */
  clearAll(): void {
    for (const sessionId of this.resolvers.keys()) {
      this.forceRelease(sessionId)
    }
  }

  /**
   * Get the number of active locks
   */
  get size(): number {
    return this.locks.size
  }
}

/**
 * Execute an operation with a session lock
 *
 * Convenience function that acquires a lock, executes the operation,
 * and releases the lock automatically.
 *
 * @param lock - The SessionLock instance
 * @param sessionId - The session ID to lock
 * @param operation - The async operation to execute
 * @returns The result of the operation
 *
 * @example
 * ```typescript
 * const result = await withSessionLock(sessionLock, sessionId, async () => {
 *   // ... perform session operations
 *   return someResult
 * })
 * ```
 */
export async function withSessionLock<T>(
  lock: SessionLock,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lock.acquire(sessionId)
  try {
    return await operation()
  } finally {
    release()
  }
}
