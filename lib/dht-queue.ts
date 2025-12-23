/**
 * DHT Announcement Queue
 *
 * Queues DHT announcements when the routing table is empty and
 * flushes them when the DHT becomes ready.
 *
 * Phase 1: SDK Connectivity (P1.2)
 */

import { EventEmitter } from 'events'
import type { ResourceAnnouncement } from './types.js'

/**
 * Queued announcement with metadata
 */
export interface QueuedAnnouncement {
  key: string
  announcement: ResourceAnnouncement
  queuedAt: number
  attempts: number
  lastAttempt?: number
}

/**
 * DHT Queue configuration
 */
export interface DHTQueueConfig {
  /** Maximum queue size (default: 1000) */
  maxQueueSize: number
  /** TTL for queued items in ms (default: 5 minutes) */
  queueTTL: number
  /** Maximum retry attempts per item (default: 3) */
  maxRetries: number
  /** Delay between retries in ms (default: 5000) */
  retryDelay: number
  /** Batch size for flush operations (default: 10) */
  flushBatchSize: number
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DHTQueueConfig = {
  maxQueueSize: 1000,
  queueTTL: 5 * 60 * 1000, // 5 minutes
  maxRetries: 3,
  retryDelay: 5000,
  flushBatchSize: 10,
}

/**
 * DHT Queue Events
 */
export interface DHTQueueEvents {
  'queue:added': (data: { key: string; queueSize: number }) => void
  'queue:flushed': (data: { count: number; failed: number }) => void
  'queue:expired': (data: { key: string; age: number }) => void
  'queue:overflow': (data: { dropped: string }) => void
  'queue:retry': (data: { key: string; attempt: number }) => void
}

/**
 * DHT Announcement Queue
 *
 * Handles:
 * - Queuing announcements when DHT is not ready
 * - Automatic flush when DHT becomes ready
 * - Expiration of stale queued items
 * - Retry logic with backoff
 */
export class DHTAnnouncementQueue extends EventEmitter {
  private pendingQueue: Map<string, QueuedAnnouncement> = new Map()
  private config: DHTQueueConfig
  private flushCallback?: (
    key: string,
    announcement: ResourceAnnouncement,
  ) => Promise<boolean>
  private cleanupInterval?: NodeJS.Timeout

  constructor(config?: Partial<DHTQueueConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Start cleanup interval
    this._startCleanup()
  }

  /**
   * Set the flush callback
   *
   * This callback is invoked for each queued item during flush.
   * It should return true if the announcement was successfully propagated.
   *
   * @param callback - Function to propagate announcement to DHT
   */
  setFlushCallback(
    callback: (
      key: string,
      announcement: ResourceAnnouncement,
    ) => Promise<boolean>,
  ): void {
    this.flushCallback = callback
  }

  /**
   * Queue an announcement for later propagation
   *
   * @param key - DHT key
   * @param announcement - Resource announcement to queue
   */
  enqueue(key: string, announcement: ResourceAnnouncement): void {
    // Check if already queued - update if so
    const existing = this.pendingQueue.get(key)
    if (existing) {
      existing.announcement = announcement
      existing.queuedAt = Date.now()
      return
    }

    // Check queue size limit
    if (this.pendingQueue.size >= this.config.maxQueueSize) {
      // Remove oldest item
      const oldestKey = this._findOldestKey()
      if (oldestKey) {
        this.pendingQueue.delete(oldestKey)
        this.emit('queue:overflow', { dropped: oldestKey })
      }
    }

    // Add to queue
    this.pendingQueue.set(key, {
      key,
      announcement,
      queuedAt: Date.now(),
      attempts: 0,
    })

    this.emit('queue:added', { key, queueSize: this.pendingQueue.size })

    console.log(
      `[DHTQueue] Queued announcement: ${key} (queue size: ${this.pendingQueue.size})`,
    )
  }

  /**
   * Flush all queued announcements
   *
   * Called when DHT becomes ready. Processes items in batches
   * to avoid overwhelming the network.
   *
   * @returns Number of successfully flushed items
   */
  async flush(): Promise<{ success: number; failed: number }> {
    if (!this.flushCallback) {
      console.warn('[DHTQueue] No flush callback set - cannot flush')
      return { success: 0, failed: 0 }
    }

    if (this.pendingQueue.size === 0) {
      return { success: 0, failed: 0 }
    }

    console.log(
      `[DHTQueue] Flushing ${this.pendingQueue.size} queued announcements`,
    )

    let success = 0
    let failed = 0

    // Process in batches
    const items = Array.from(this.pendingQueue.values())

    for (let i = 0; i < items.length; i += this.config.flushBatchSize) {
      const batch = items.slice(i, i + this.config.flushBatchSize)

      const results = await Promise.all(
        batch.map(async item => {
          try {
            item.attempts++
            item.lastAttempt = Date.now()

            const result = await this.flushCallback!(
              item.key,
              item.announcement,
            )

            if (result) {
              // Success - remove from queue
              this.pendingQueue.delete(item.key)
              return true
            } else {
              // Failed - check retry limit
              if (item.attempts >= this.config.maxRetries) {
                this.pendingQueue.delete(item.key)
                console.warn(
                  `[DHTQueue] Max retries exceeded for ${item.key}, dropping`,
                )
              } else {
                this.emit('queue:retry', {
                  key: item.key,
                  attempt: item.attempts,
                })
              }
              return false
            }
          } catch (error) {
            console.error(`[DHTQueue] Error flushing ${item.key}:`, error)

            // Check retry limit
            if (item.attempts >= this.config.maxRetries) {
              this.pendingQueue.delete(item.key)
            }
            return false
          }
        }),
      )

      success += results.filter(r => r).length
      failed += results.filter(r => !r).length

      // Small delay between batches to avoid overwhelming network
      if (i + this.config.flushBatchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    this.emit('queue:flushed', { count: success, failed })

    console.log(
      `[DHTQueue] Flush complete: ${success} success, ${failed} failed, ${this.pendingQueue.size} remaining`,
    )

    return { success, failed }
  }

  /**
   * Get count of pending announcements
   */
  getPendingCount(): number {
    return this.pendingQueue.size
  }

  /**
   * Get all pending keys
   */
  getPendingKeys(): string[] {
    return Array.from(this.pendingQueue.keys())
  }

  /**
   * Check if a key is queued
   */
  isQueued(key: string): boolean {
    return this.pendingQueue.has(key)
  }

  /**
   * Remove a specific item from queue
   */
  remove(key: string): boolean {
    return this.pendingQueue.delete(key)
  }

  /**
   * Clear all queued items
   */
  clear(): void {
    this.pendingQueue.clear()
  }

  /**
   * Stop the queue (cleanup)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }
    this.pendingQueue.clear()
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    queueSize: number
    oldestAge: number | null
    totalAttempts: number
  } {
    let oldestAge: number | null = null
    let totalAttempts = 0

    for (const item of this.pendingQueue.values()) {
      const age = Date.now() - item.queuedAt
      if (oldestAge === null || age > oldestAge) {
        oldestAge = age
      }
      totalAttempts += item.attempts
    }

    return {
      queueSize: this.pendingQueue.size,
      oldestAge,
      totalAttempts,
    }
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Start periodic cleanup of expired items
   */
  private _startCleanup(): void {
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this._cleanupExpired()
    }, 60000)
  }

  /**
   * Remove expired items from queue
   */
  private _cleanupExpired(): void {
    const now = Date.now()
    const expiredKeys: string[] = []

    for (const [key, item] of this.pendingQueue) {
      const age = now - item.queuedAt

      if (age > this.config.queueTTL) {
        expiredKeys.push(key)
        this.emit('queue:expired', { key, age })
      }
    }

    for (const key of expiredKeys) {
      this.pendingQueue.delete(key)
    }

    if (expiredKeys.length > 0) {
      console.log(`[DHTQueue] Cleaned up ${expiredKeys.length} expired items`)
    }
  }

  /**
   * Find the oldest queued key
   */
  private _findOldestKey(): string | null {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, item] of this.pendingQueue) {
      if (item.queuedAt < oldestTime) {
        oldestTime = item.queuedAt
        oldestKey = key
      }
    }

    return oldestKey
  }
}
