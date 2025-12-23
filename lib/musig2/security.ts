/**
 * MuSig2 Security Validator
 *
 * Protocol-specific SECURITY CONSTRAINTS for MuSig2 sessions.
 *
 * ARCHITECTURE:
 * This module handles SECURITY POLICY ENFORCEMENT only:
 * - Peer blocking (after too many violations)
 * - DoS protection (message size limits)
 * - Timestamp skew validation
 * - Rate limiting (TODO)
 * - Session announcement validation
 *
 * IMPORTANT: This module does NOT perform payload structure validation.
 * Payload validation is handled by protocol.ts using validators from validation.ts.
 * This separation prevents double validation and maintains clear concerns:
 *
 * - security.ts: Security constraints (this module)
 * - protocol.ts: Ingress payload validation (single point)
 * - validation.ts: Pure validator functions
 * - coordinator.ts: Business logic + egress validation
 */

import type { IProtocolValidator, P2PMessage, PeerInfo } from '../types.js'
import type { MuSig2Payload, SessionAnnouncement } from './types.js'
import { DEFAULT_MUSIG2_P2P_CONFIG } from './types.js'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
// NOTE: Validation imports removed - payload structure validation is now handled
// exclusively by protocol.ts to avoid double validation. This module only handles
// security constraints (DoS protection, peer blocking, rate limiting).

/**
 * MuSig2 security configuration
 */
export interface MuSig2SecurityConfig {
  /** Minimum signers per session */
  minSigners?: number

  /** Maximum signers per session */
  maxSigners?: number

  /** Maximum session duration in milliseconds */
  maxSessionDuration?: number

  /** Require valid public keys in announcements */
  requireValidPublicKeys?: boolean

  // ============================================================================
  // Validation Security (Phase 5)
  // ============================================================================

  /** Maximum message size in bytes (DoS protection) */
  maxMessageSize?: number

  /** Maximum timestamp skew in milliseconds */
  maxTimestampSkew?: number

  /** Maximum invalid messages per peer before blocking */
  maxInvalidMessagesPerPeer?: number

  /** Enable validation-based security checks */
  enableValidationSecurity?: boolean

  /** Track validation violations for reputation */
  trackValidationViolations?: boolean
}

/**
 * Default security configuration
 */
export const DEFAULT_MUSIG2_SECURITY: Required<MuSig2SecurityConfig> = {
  minSigners: 2,
  maxSigners: 15,
  maxSessionDuration: 10 * 60 * 1000, // 10 minutes
  requireValidPublicKeys: true,

  // Validation Security (Phase 5)
  maxMessageSize: 100_000, // 100KB - DoS protection
  maxTimestampSkew: 5 * 60 * 1000, // 5 minutes
  maxInvalidMessagesPerPeer: 10, // Block peer after 10 invalid messages
  enableValidationSecurity: true,
  trackValidationViolations: true,
}

/**
 * MuSig2 Protocol Validator
 *
 * Implements protocol-specific validation for MuSig2 sessions
 * Enhanced with validation layer integration (Phase 5)
 */
export class MuSig2SecurityValidator implements IProtocolValidator {
  // Validation violation tracking (Phase 5)
  private validationViolations: Map<string, number> = new Map()
  private blockedPeers: Set<string> = new Set()

  constructor(
    private readonly config: MuSig2SecurityConfig = DEFAULT_MUSIG2_SECURITY,
  ) {}

  /**
   * Validate session announcement before accepting
   */
  async validateResourceAnnouncement(
    resourceType: string,
    resourceId: string,
    data: unknown,
    peerId: string,
  ): Promise<boolean> {
    // Only validate musig2-session announcements
    if (!resourceType.startsWith('musig2-session')) {
      return true
    }

    if (!data || typeof data !== 'object') {
      console.warn('[MuSig2Security] Invalid announcement data type')
      return false
    }

    const announcement = data as SessionAnnouncement

    // Validate required fields
    if (!announcement.sessionId || !announcement.coordinatorPeerId) {
      console.warn('[MuSig2Security] Missing required announcement fields')
      return false
    }

    // Validate session ID format
    if (announcement.sessionId !== resourceId) {
      console.warn('[MuSig2Security] Session ID mismatch')
      return false
    }

    // Validate signer count
    const minSigners =
      this.config.minSigners ?? DEFAULT_MUSIG2_SECURITY.minSigners
    const maxSigners =
      this.config.maxSigners ?? DEFAULT_MUSIG2_SECURITY.maxSigners

    if (announcement.requiredSigners < minSigners) {
      console.warn(
        `[MuSig2Security] Too few signers: ${announcement.requiredSigners} < ${minSigners}`,
      )
      return false
    }

    if (announcement.requiredSigners > maxSigners) {
      console.warn(
        `[MuSig2Security] Too many signers: ${announcement.requiredSigners} > ${maxSigners}`,
      )
      return false
    }

    // Validate signers array if provided
    if (announcement.signers) {
      if (announcement.signers.length !== announcement.requiredSigners) {
        console.warn('[MuSig2Security] Signer count mismatch')
        return false
      }

      // Validate public keys if required
      if (
        this.config.requireValidPublicKeys ??
        DEFAULT_MUSIG2_SECURITY.requireValidPublicKeys
      ) {
        for (const signerPubKey of announcement.signers) {
          try {
            PublicKey.fromString(signerPubKey)
          } catch (error) {
            console.warn(
              `[MuSig2Security] Invalid signer public key: ${signerPubKey}`,
            )
            return false
          }
        }
      }
    }

    // Validate timestamps
    const now = Date.now()
    if (announcement.createdAt > now + 60000) {
      // Allow 1 minute clock skew
      console.warn('[MuSig2Security] Announcement timestamp in future')
      return false
    }

    if (announcement.expiresAt < now) {
      console.warn('[MuSig2Security] Announcement expired')
      return false
    }

    const maxDuration =
      this.config.maxSessionDuration ??
      DEFAULT_MUSIG2_SECURITY.maxSessionDuration
    if (announcement.expiresAt - announcement.createdAt > maxDuration) {
      console.warn('[MuSig2Security] Announcement duration too long')
      return false
    }

    // Validate message hash format (should be 64 hex characters)
    if (!/^[0-9a-f]{64}$/i.test(announcement.messageHash)) {
      console.warn('[MuSig2Security] Invalid message hash format')
      return false
    }

    return true
  }

  /**
   * Validate MuSig2 message security constraints before processing
   *
   * ARCHITECTURE NOTE:
   * This method validates SECURITY CONSTRAINTS ONLY (DoS protection, peer blocking,
   * timestamp skew). Payload structure validation is handled by protocol.ts to avoid
   * double validation. The validation layer (validation.ts) provides the actual
   * payload validators that protocol.ts uses.
   *
   * Flow:
   * 1. security.ts: validateMessage() - Security constraints (this method)
   * 2. protocol.ts: _validateAndRouteMessage() - Payload structure validation
   * 3. coordinator.ts: Business logic (no re-validation needed)
   */
  async validateMessage(message: P2PMessage, from: PeerInfo): Promise<boolean> {
    // Check if peer is blocked due to too many violations
    if (this.blockedPeers.has(from.peerId)) {
      console.warn(
        `[MuSig2Security] Blocked peer attempted message: ${from.peerId}`,
      )
      return false
    }

    // Check message size (DoS protection)
    const maxMessageSize =
      this.config.maxMessageSize ?? DEFAULT_MUSIG2_SECURITY.maxMessageSize
    if (this._isMessageTooLarge(message, maxMessageSize)) {
      this._trackValidationViolation(from.peerId, 'message_too_large')
      return false
    }

    // Basic payload existence check (not structure validation)
    if (!message.payload || typeof message.payload !== 'object') {
      console.warn('[MuSig2Security] Invalid message payload')
      this._trackValidationViolation(from.peerId, 'invalid_payload')
      return false
    }

    const payload = message.payload as MuSig2Payload

    // All MuSig2 messages must have sessionId and timestamp (security requirement)
    if (!payload.sessionId || !payload.timestamp) {
      console.warn('[MuSig2Security] Missing sessionId or timestamp')
      this._trackValidationViolation(from.peerId, 'missing_fields')
      return false
    }

    // Validate timestamp with configurable skew (security constraint)
    const maxTimestampSkew =
      this.config.maxTimestampSkew ?? DEFAULT_MUSIG2_SECURITY.maxTimestampSkew
    const now = Date.now()
    const messageTime = payload.timestamp as number
    if (Math.abs(now - messageTime) > maxTimestampSkew) {
      console.warn('[MuSig2Security] Message timestamp too old or in future')
      this._trackValidationViolation(from.peerId, 'timestamp_skew')
      return false
    }

    // NOTE: Payload structure validation is intentionally NOT performed here.
    // It is handled by protocol.ts via _validateAndRouteMessage() to avoid
    // double validation. This method only checks security constraints.

    // TODO: Add rate limiting per peer per message type
    // TODO: Add session-specific security checks (e.g., verify sender is participant)
    // TODO: Add cryptographic proof verification for critical messages

    return true
  }

  // NOTE: Payload structure validation methods have been removed from security.ts.
  // They are now handled exclusively by protocol.ts via _validateAndRouteMessage().
  // This prevents double validation and maintains clear separation of concerns:
  // - security.ts: Security constraints (DoS, blocking, rate limiting)
  // - protocol.ts: Payload structure validation (single point of ingress validation)
  // - validation.ts: Pure validator functions (used by protocol.ts)
  // - coordinator.ts: Business logic + egress validation

  /**
   * Check if message is too large (DoS protection)
   */
  private _isMessageTooLarge(message: P2PMessage, maxSize: number): boolean {
    try {
      const serialized = JSON.stringify(message)
      return serialized.length > maxSize
    } catch {
      return true // If we can't serialize, consider it too large
    }
  }

  /**
   * Track validation violations for reputation (Phase 5)
   */
  private _trackValidationViolation(
    peerId: string,
    violationType: string,
  ): void {
    const trackViolations =
      this.config.trackValidationViolations ??
      DEFAULT_MUSIG2_SECURITY.trackValidationViolations
    if (!trackViolations) {
      return
    }

    const currentCount = this.validationViolations.get(peerId) ?? 0
    const newCount = currentCount + 1
    this.validationViolations.set(peerId, newCount)

    console.warn(
      `[MuSig2Security] Validation violation from ${peerId}: ${violationType} (count: ${newCount})`,
    )

    // Block peer if too many violations
    const maxInvalidMessages =
      this.config.maxInvalidMessagesPerPeer ??
      DEFAULT_MUSIG2_SECURITY.maxInvalidMessagesPerPeer
    if (newCount >= maxInvalidMessages) {
      this.blockedPeers.add(peerId)
      console.warn(
        `[MuSig2Security] Blocked peer ${peerId} due to ${newCount} validation violations`,
      )
    }
  }

  // Legacy validation methods (validateJoinMessage, validateNonceMessage,
  // validatePartialSigMessage) have been removed. Payload structure validation
  // is now handled exclusively by protocol.ts using validation.ts validators.
  //
  // TODO: Add semantic validation methods that check business logic constraints:
  // - validateJoinAuthorization(): Verify sender is allowed to join session
  // - validateNonceUniqueness(): Verify nonce hasn't been used before
  // - validatePartialSigConsistency(): Verify partial sig matches session state

  /**
   * Check if peer can announce a session
   */
  async canAnnounceResource(
    resourceType: string,
    peerId: string,
  ): Promise<boolean> {
    // Check if peer is blocked
    if (this.blockedPeers.has(peerId)) {
      console.warn(
        `[MuSig2Security] Blocked peer ${peerId} attempted to announce resource`,
      )
      return false
    }

    // Basic check - can be extended with reputation system
    if (!resourceType.startsWith('musig2-session')) {
      return true
    }

    // For now, allow all non-blocked peers to announce
    // In production, could check reputation, rate limits, etc.
    return true
  }

  // ============================================================================
  // Security Status Methods (Phase 5)
  // ============================================================================

  /**
   * Get security status for monitoring
   */
  getSecurityStatus() {
    return {
      blockedPeers: Array.from(this.blockedPeers),
      blockedPeerCount: this.blockedPeers.size,
      validationViolations: Object.fromEntries(this.validationViolations),
      totalViolations: Array.from(this.validationViolations.values()).reduce(
        (a, b) => a + b,
        0,
      ),
      config: {
        maxMessageSize:
          this.config.maxMessageSize ?? DEFAULT_MUSIG2_SECURITY.maxMessageSize,
        maxTimestampSkew:
          this.config.maxTimestampSkew ??
          DEFAULT_MUSIG2_SECURITY.maxTimestampSkew,
        maxInvalidMessagesPerPeer:
          this.config.maxInvalidMessagesPerPeer ??
          DEFAULT_MUSIG2_SECURITY.maxInvalidMessagesPerPeer,
        enableValidationSecurity:
          this.config.enableValidationSecurity ??
          DEFAULT_MUSIG2_SECURITY.enableValidationSecurity,
        trackValidationViolations:
          this.config.trackValidationViolations ??
          DEFAULT_MUSIG2_SECURITY.trackValidationViolations,
      },
    }
  }

  /**
   * Check if a peer is blocked
   */
  isPeerBlocked(peerId: string): boolean {
    return this.blockedPeers.has(peerId)
  }

  /**
   * Get violation count for a peer
   */
  getViolationCount(peerId: string): number {
    return this.validationViolations.get(peerId) ?? 0
  }

  /**
   * Unblock a peer (for manual intervention)
   */
  unblockPeer(peerId: string): boolean {
    const wasBlocked = this.blockedPeers.delete(peerId)
    if (wasBlocked) {
      this.validationViolations.delete(peerId)
      console.log(`[MuSig2Security] Unblocked peer: ${peerId}`)
    }
    return wasBlocked
  }

  /**
   * Clear all violations (for testing or reset)
   */
  clearViolations(): void {
    this.validationViolations.clear()
    this.blockedPeers.clear()
    console.log('[MuSig2Security] Cleared all violations and blocked peers')
  }
}
