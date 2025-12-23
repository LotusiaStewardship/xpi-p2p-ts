/**
 * MuSig2 Replay Protection
 *
 * Provides protection against replay attacks in MuSig2 protocol messages.
 * Implements:
 * - Message ID deduplication with bounded memory
 * - Timestamp freshness validation
 * - Session-scoped sequence number tracking
 *
 * This prevents attackers from replaying old messages to disrupt sessions.
 */

import type { P2PMessage } from '../types.js'

/**
 * Replay protection configuration
 */
export interface ReplayProtectionConfig {
  /** Maximum age of messages in milliseconds (default: 5 minutes) */
  maxMessageAge?: number
  /** Cleanup interval for old entries in milliseconds (default: 1 minute) */
  cleanupInterval?: number
  /** Maximum number of seen message IDs to track (default: 10000) */
  maxSeenMessages?: number
  /** Enable sequence number validation (default: true) */
  enableSequenceValidation?: boolean
}

/**
 * Default replay protection configuration
 */
export const DEFAULT_REPLAY_PROTECTION_CONFIG: Required<ReplayProtectionConfig> =
  {
    maxMessageAge: 5 * 60 * 1000, // 5 minutes
    cleanupInterval: 60 * 1000, // 1 minute
    maxSeenMessages: 10000,
    enableSequenceValidation: true,
  }

/**
 * Validation result from replay protection
 */
export interface ReplayValidationResult {
  /** Whether the message passed replay validation */
  valid: boolean
  /** Reason for rejection (if invalid) */
  reason?: string
}

/**
 * MuSig2 Replay Protection
 *
 * Tracks seen messages and sequence numbers to prevent replay attacks.
 */
export class ReplayProtection {
  private readonly config: Required<ReplayProtectionConfig>

  /** Map of messageId -> timestamp for deduplication */
  private seenMessages: Map<string, number> = new Map()

  /** Map of sessionId -> Map of signerIndex -> lastSequenceNumber */
  private sessionSequences: Map<string, Map<number, number>> = new Map()

  /** Cleanup timer */
  private cleanupTimer?: NodeJS.Timeout

  constructor(config?: ReplayProtectionConfig) {
    this.config = {
      ...DEFAULT_REPLAY_PROTECTION_CONFIG,
      ...config,
    }
  }

  /**
   * Start the replay protection cleanup timer
   */
  start(): void {
    if (this.cleanupTimer) {
      return
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, this.config.cleanupInterval)

    // Don't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Stop the replay protection cleanup timer
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  /**
   * Validate a message is not a replay
   *
   * Checks:
   * 1. Timestamp freshness (within maxMessageAge window)
   * 2. Message ID uniqueness (not seen before)
   * 3. Sequence number ordering (if enabled and provided)
   *
   * @param message - The P2P message to validate
   * @param sessionId - Session ID for sequence tracking
   * @param signerIndex - Signer index for sequence tracking
   * @param sequenceNumber - Optional sequence number for ordering
   * @returns Validation result
   */
  validateMessage(
    message: P2PMessage,
    sessionId?: string,
    signerIndex?: number,
    sequenceNumber?: number,
  ): ReplayValidationResult {
    const now = Date.now()

    // 1. Check timestamp freshness (±maxMessageAge)
    if (message.timestamp) {
      const age = Math.abs(now - message.timestamp)
      if (age > this.config.maxMessageAge) {
        return {
          valid: false,
          reason: 'timestamp_out_of_range',
        }
      }
    }

    // 2. Check message ID uniqueness
    if (message.messageId) {
      if (this.seenMessages.has(message.messageId)) {
        return {
          valid: false,
          reason: 'duplicate_message_id',
        }
      }

      // Record this message ID
      this.recordMessageId(message.messageId, now)
    }

    // 3. Check sequence number (if enabled and provided)
    if (
      this.config.enableSequenceValidation &&
      sessionId !== undefined &&
      signerIndex !== undefined &&
      sequenceNumber !== undefined
    ) {
      const seqResult = this.validateSequenceNumber(
        sessionId,
        signerIndex,
        sequenceNumber,
      )
      if (!seqResult.valid) {
        return seqResult
      }
    }

    return { valid: true }
  }

  /**
   * Validate sequence number is strictly increasing
   */
  private validateSequenceNumber(
    sessionId: string,
    signerIndex: number,
    sequenceNumber: number,
  ): ReplayValidationResult {
    let sessionSeqs = this.sessionSequences.get(sessionId)

    if (!sessionSeqs) {
      // First message from this session - create tracking
      sessionSeqs = new Map()
      this.sessionSequences.set(sessionId, sessionSeqs)
    }

    const lastSeq = sessionSeqs.get(signerIndex) ?? -1

    // Sequence must be strictly increasing
    if (sequenceNumber <= lastSeq) {
      return {
        valid: false,
        reason: 'sequence_number_not_increasing',
      }
    }

    // Update the sequence number
    sessionSeqs.set(signerIndex, sequenceNumber)

    return { valid: true }
  }

  /**
   * Record a message ID as seen
   */
  private recordMessageId(messageId: string, timestamp: number): void {
    // Enforce maximum size by removing oldest entries if needed
    if (this.seenMessages.size >= this.config.maxSeenMessages) {
      // Remove oldest 10% of entries
      const entriesToRemove = Math.ceil(this.config.maxSeenMessages * 0.1)
      const sortedEntries = Array.from(this.seenMessages.entries()).sort(
        (a, b) => a[1] - b[1],
      )

      for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
        this.seenMessages.delete(sortedEntries[i][0])
      }
    }

    this.seenMessages.set(messageId, timestamp)
  }

  /**
   * Get the next sequence number for a session/signer
   * Useful for generating outgoing messages
   */
  getNextSequenceNumber(sessionId: string, signerIndex: number): number {
    const sessionSeqs = this.sessionSequences.get(sessionId)
    if (!sessionSeqs) {
      return 0
    }

    const lastSeq = sessionSeqs.get(signerIndex) ?? -1
    return lastSeq + 1
  }

  /**
   * Clear session data when session ends
   */
  clearSession(sessionId: string): void {
    this.sessionSequences.delete(sessionId)
  }

  /**
   * Cleanup old entries to prevent unbounded memory growth
   */
  cleanup(): void {
    const now = Date.now()
    const maxAge = this.config.maxMessageAge * 2 // Keep for 2x the max age

    // Clean up old message IDs
    for (const [messageId, timestamp] of this.seenMessages) {
      if (now - timestamp > maxAge) {
        this.seenMessages.delete(messageId)
      }
    }
  }

  /**
   * Clear all replay protection data
   */
  clear(): void {
    this.seenMessages.clear()
    this.sessionSequences.clear()
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): {
    seenMessagesCount: number
    activeSessionsCount: number
    config: Required<ReplayProtectionConfig>
  } {
    return {
      seenMessagesCount: this.seenMessages.size,
      activeSessionsCount: this.sessionSequences.size,
      config: { ...this.config },
    }
  }

  /**
   * Check if a message ID has been seen
   */
  hasSeenMessage(messageId: string): boolean {
    return this.seenMessages.has(messageId)
  }

  /**
   * Get the last sequence number for a session/signer
   */
  getLastSequenceNumber(
    sessionId: string,
    signerIndex: number,
  ): number | undefined {
    const sessionSeqs = this.sessionSequences.get(sessionId)
    if (!sessionSeqs) {
      return undefined
    }
    return sessionSeqs.get(signerIndex)
  }
}

/**
 * Create a replay protection instance with default configuration
 */
export function createReplayProtection(
  config?: ReplayProtectionConfig,
): ReplayProtection {
  return new ReplayProtection(config)
}
