/**
 * Discovery Security Layer
 *
 * Handles security validation for discovery operations
 */

import type { P2PCoordinator } from '../coordinator.js'
import { EventEmitter } from 'events'
import { Hash } from 'xpi-ts/lib/bitcore/crypto/hash'
import { Schnorr } from 'xpi-ts/lib/bitcore/crypto/schnorr'
import { Signature } from 'xpi-ts/lib/bitcore/crypto/signature'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import {
  type DiscoveryAdvertisement,
  type DiscoveryCriteria,
  type SecurityValidationResult,
  type ReputationData,
  type SecurityPolicy,
  DiscoveryError,
  DiscoveryErrorType,
  DEFAULT_SECURITY_POLICY,
} from './types.js'

// ============================================================================
// Security Validator Class
// ============================================================================

/**
 * Discovery security validator
 */
export class DiscoverySecurityValidator {
  private readonly coordinator: P2PCoordinator
  private readonly reputationData = new Map<string, ReputationData>()
  private readonly seenAdvertisements = new Map<string, number>()
  private readonly rateLimitTracker = new Map<
    string,
    { count: number; windowStart: number }
  >()
  private readonly policy: SecurityPolicy
  private cleanupTimer?: NodeJS.Timeout

  constructor(
    coordinator: P2PCoordinator,
    policy: Partial<SecurityPolicy> = {},
  ) {
    this.coordinator = coordinator
    this.policy = { ...DEFAULT_SECURITY_POLICY, ...policy }
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  /**
   * Validate advertisement security
   */
  async validateAdvertisement(
    advertisement: DiscoveryAdvertisement,
    criteria?: DiscoveryCriteria,
  ): Promise<SecurityValidationResult> {
    const now = Date.now()
    const result: SecurityValidationResult = {
      valid: true,
      securityScore: 100,
      details: {
        signatureValid: true,
        notExpired: true,
        reputationAcceptable: true,
        criteriaMatch: true,
        customValidation: true,
      },
    }

    try {
      // Check expiration
      if (advertisement.expiresAt <= now) {
        result.valid = false
        result.error = 'Advertisement expired'
        result.details.notExpired = false
        result.securityScore -= 50
      }

      // Check age
      const age = now - advertisement.createdAt
      if (age > this.policy.maxAdvertisementAge) {
        result.valid = false
        result.error = 'Advertisement too old'
        result.securityScore -= 30
      }

      // Validate signature
      if (this.policy.enableSignatureVerification) {
        const signatureValid = await this.validateSignature(advertisement)
        result.details.signatureValid = signatureValid
        if (!signatureValid) {
          result.valid = false
          result.error = 'Invalid signature'
          result.securityScore -= 40
        }
      }

      // Check reputation
      const reputation = this.getReputation(advertisement.peerInfo.peerId)
      result.details.reputationAcceptable =
        reputation.score >= this.policy.minReputation
      if (!result.details.reputationAcceptable) {
        result.valid = false
        result.error = 'Reputation too low'
        result.securityScore -= 30
      }

      // Check for replay attacks
      if (this.policy.enableReplayPrevention) {
        const isReplay = this.checkReplayAttack(advertisement)
        if (isReplay) {
          result.valid = false
          result.error = 'Replay attack detected'
          result.securityScore -= 60
        }
      }

      // Validate against criteria
      if (criteria) {
        result.details.criteriaMatch = this.validateCriteriaMatch(
          advertisement,
          criteria,
        )
        if (!result.details.criteriaMatch) {
          result.valid = false
          result.error = 'Criteria mismatch'
          result.securityScore -= 20
        }
      }

      // Custom validation
      for (const validator of this.policy.customValidators) {
        try {
          const isValid = await validator.validator(advertisement)
          if (!isValid) {
            result.details.customValidation = false
            result.securityScore -= 10
          }
        } catch (error) {
          result.details.customValidation = false
          result.securityScore -= 15
        }
      }

      // Final validity check
      result.valid = result.valid && result.securityScore >= 50

      return result
    } catch (error) {
      return {
        valid: false,
        error: `Security validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        securityScore: 0,
        details: {
          signatureValid: false,
          notExpired: false,
          reputationAcceptable: false,
          criteriaMatch: false,
          customValidation: false,
        },
      }
    }
  }

  /**
   * Update reputation based on interaction
   */
  updateReputation(
    peerId: string,
    success: boolean,
    weight: number = 1,
    reason?: string,
  ): void {
    const reputation = this.getReputation(peerId)
    const now = Date.now()

    // Update statistics
    if (success) {
      reputation.successes += weight
      reputation.score = Math.min(100, reputation.score + weight * 2)
    } else {
      reputation.failures += weight
      reputation.score = Math.max(0, reputation.score - weight * 5)
    }

    reputation.lastInteraction = now

    // Add to history
    reputation.history.push({
      timestamp: now,
      success,
      weight,
      reason,
    })

    // Limit history size
    if (reputation.history.length > 100) {
      reputation.history = reputation.history.slice(-100)
    }

    this.reputationData.set(peerId, reputation)
  }

  /**
   * Get reputation data for peer
   */
  getReputation(peerId: string): ReputationData {
    let reputation = this.reputationData.get(peerId)

    if (!reputation) {
      reputation = {
        peerId,
        score: 75, // Start with neutral reputation
        successes: 0,
        failures: 0,
        lastInteraction: Date.now(),
        history: [],
      }
      this.reputationData.set(peerId, reputation)
    }

    return reputation
  }

  /**
   * Check rate limits for discovery operations
   */
  checkRateLimit(peerId: string, operation: 'advertise' | 'discover'): boolean {
    if (!this.policy.enableRateLimiting) {
      return true
    }

    const now = Date.now()
    const windowStart = now - this.policy.rateLimits.windowSizeMs
    const key = `${peerId}:${operation}`

    let tracker = this.rateLimitTracker.get(key)
    if (!tracker || tracker.windowStart < windowStart) {
      tracker = { count: 0, windowStart: now }
      this.rateLimitTracker.set(key, tracker)
    }

    const maxOperations =
      operation === 'advertise'
        ? this.policy.rateLimits.maxAdvertisementsPerPeer
        : this.policy.rateLimits.maxDiscoveryQueriesPerPeer

    if (tracker.count >= maxOperations) {
      return false
    }

    tracker.count++
    return true
  }

  /**
   * Start security monitoring
   */
  start(): void {
    if (this.cleanupTimer) {
      return
    }

    // Start cleanup timer
    this.cleanupTimer = setInterval(
      () => {
        this.cleanup()
      },
      60 * 60 * 1000,
    ) // Clean up every hour
  }

  /**
   * Stop security monitoring
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  /**
   * Get security statistics
   */
  getSecurityStats(): {
    totalPeers: number
    averageReputation: number
    lowReputationPeers: number
    rateLimitViolations: number
    replayAttacksPrevented: number
  } {
    const peers = Array.from(this.reputationData.values())
    const totalPeers = peers.length
    const averageReputation =
      totalPeers > 0
        ? peers.reduce((sum, p) => sum + p.score, 0) / totalPeers
        : 0
    const lowReputationPeers = peers.filter(
      p => p.score < this.policy.minReputation,
    ).length

    let rateLimitViolations = 0
    for (const tracker of Array.from(this.rateLimitTracker.values())) {
      rateLimitViolations += tracker.count
    }

    const replayAttacksPrevented = this.seenAdvertisements.size

    return {
      totalPeers,
      averageReputation,
      lowReputationPeers,
      rateLimitViolations,
      replayAttacksPrevented,
    }
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Validate advertisement signature (Phase 4: Strict enforcement)
   *
   * SECURITY: Signatures are now REQUIRED for all advertisements.
   * This method will reject any advertisement without a valid signature.
   */
  private async validateSignature(
    advertisement: DiscoveryAdvertisement,
  ): Promise<boolean> {
    // Phase 4: Signature is now required
    if (!advertisement.signature) {
      console.warn(
        `[DiscoverySecurity] Rejecting advertisement ${advertisement.id}: missing signature`,
      )
      return false
    }

    if (!advertisement.peerInfo.publicKey) {
      console.warn(
        `[DiscoverySecurity] Rejecting advertisement ${advertisement.id}: missing public key`,
      )
      return false
    }

    try {
      // Reconstruct the signed message exactly as it was created
      // This must match the signing process in the advertiser
      const messageData = this.constructSignedMessage(advertisement)

      // Hash the message for Schnorr verification
      const messageHash = Hash.sha256(messageData)

      // Parse signature from Buffer to Signature object
      const signature = Signature.fromBuffer(advertisement.signature)

      // Ensure it's marked as a Schnorr signature
      if (!signature.isSchnorr) {
        signature.isSchnorr = true
      }

      // Verify the Schnorr signature using Lotus format (big-endian)
      const isValid = Schnorr.verify(
        messageHash,
        signature,
        advertisement.peerInfo.publicKey,
        'big',
      )

      if (!isValid) {
        console.warn(
          `[DiscoverySecurity] Rejecting advertisement ${advertisement.id}: invalid signature`,
        )
      }

      return isValid
    } catch (error) {
      console.error(
        `[DiscoverySecurity] Signature verification failed for ${advertisement.id}:`,
        error,
      )
      return false
    }
  }

  /**
   * Verify advertisement signature (public method for external use)
   * Phase 4: Strict signature verification
   */
  verifyAdvertisementSignature(advertisement: DiscoveryAdvertisement): boolean {
    // Synchronous wrapper for the async validation
    // Note: This is safe because validateSignature doesn't actually use async operations
    try {
      if (!advertisement.signature) {
        console.warn(
          `[DiscoverySecurity] Rejecting unsigned advertisement: ${advertisement.id}`,
        )
        return false
      }

      if (!advertisement.peerInfo.publicKey) {
        console.warn(
          `[DiscoverySecurity] Rejecting advertisement without public key: ${advertisement.id}`,
        )
        return false
      }

      const messageData = this.constructSignedMessage(advertisement)
      const messageHash = Hash.sha256(messageData)
      const signature = Signature.fromBuffer(advertisement.signature)
      signature.isSchnorr = true

      return Schnorr.verify(
        messageHash,
        signature,
        advertisement.peerInfo.publicKey,
        'big',
      )
    } catch (error) {
      console.error(
        `[DiscoverySecurity] Signature verification error for ${advertisement.id}:`,
        error,
      )
      return false
    }
  }

  /**
   * Construct the message that was signed for the advertisement
   * This must exactly match the signing process
   */
  private constructSignedMessage(
    advertisement: DiscoveryAdvertisement,
  ): Buffer {
    const parts: Buffer[] = []

    // Add peer ID
    parts.push(Buffer.from(advertisement.peerInfo.peerId))

    // Add multiaddrs if available
    if (advertisement.peerInfo.multiaddrs) {
      parts.push(Buffer.from(JSON.stringify(advertisement.peerInfo.multiaddrs)))
    }

    // Add protocol
    parts.push(Buffer.from(advertisement.protocol))

    // Add capabilities if available
    if (advertisement.capabilities) {
      parts.push(Buffer.from(JSON.stringify(advertisement.capabilities)))
    }

    // Add timestamps
    parts.push(Buffer.from(advertisement.createdAt.toString()))
    parts.push(Buffer.from(advertisement.expiresAt.toString()))

    // Add custom criteria if available
    if (advertisement.customCriteria) {
      parts.push(Buffer.from(JSON.stringify(advertisement.customCriteria)))
    }

    return Buffer.concat(parts)
  }

  /**
   * Check for replay attacks
   */
  private checkReplayAttack(advertisement: DiscoveryAdvertisement): boolean {
    const key = `${advertisement.peerInfo.peerId}:${advertisement.id}`
    const existingTimestamp = this.seenAdvertisements.get(key)

    if (existingTimestamp) {
      // Check if this is a newer version of the same advertisement
      if (advertisement.createdAt <= existingTimestamp) {
        return true // Replay detected
      }
    }

    // Record this advertisement
    this.seenAdvertisements.set(key, advertisement.createdAt)
    return false
  }

  /**
   * Validate advertisement matches criteria
   */
  private validateCriteriaMatch(
    advertisement: DiscoveryAdvertisement,
    criteria: DiscoveryCriteria,
  ): boolean {
    // Protocol match
    if (advertisement.protocol !== criteria.protocol) {
      return false
    }

    // Capabilities match
    if (criteria.capabilities) {
      const hasAllCapabilities = criteria.capabilities.every(cap =>
        advertisement.capabilities.includes(cap),
      )
      if (!hasAllCapabilities) {
        return false
      }
    }

    // Reputation filter
    if (
      criteria.minReputation &&
      advertisement.reputation < criteria.minReputation
    ) {
      return false
    }

    // Location filter
    if (criteria.location && advertisement.location) {
      const distance = this.calculateDistance(
        criteria.location.latitude,
        criteria.location.longitude,
        advertisement.location.latitude,
        advertisement.location.longitude,
      )
      if (distance > criteria.location.radiusKm) {
        return false
      }
    }

    return true
  }

  /**
   * Calculate distance between two coordinates
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371 // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1)
    const dLon = this.toRadians(lon2 - lon1)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180)
  }

  /**
   * Clean up old data
   */
  private cleanup(): void {
    const now = Date.now()
    const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Clean up old reputation data
    for (const [peerId, reputation] of Array.from(
      this.reputationData.entries(),
    )) {
      if (now - reputation.lastInteraction > maxAge) {
        this.reputationData.delete(peerId)
      }
    }

    // Clean up old seen advertisements
    for (const [key, timestamp] of Array.from(
      this.seenAdvertisements.entries(),
    )) {
      if (now - timestamp > maxAge) {
        this.seenAdvertisements.delete(key)
      }
    }

    // Clean up old rate limit trackers
    for (const [key, tracker] of Array.from(this.rateLimitTracker.entries())) {
      if (now - tracker.windowStart > this.policy.rateLimits.windowSizeMs * 2) {
        this.rateLimitTracker.delete(key)
      }
    }
  }
}

// ============================================================================
// Security Policy Factory
// ============================================================================

/**
 * Create security policy for specific protocol
 */
export function createSecurityPolicy(
  protocol: string,
  overrides: Partial<SecurityPolicy> = {},
): SecurityPolicy {
  const basePolicy = { ...DEFAULT_SECURITY_POLICY }

  // Protocol-specific adjustments
  switch (protocol) {
    case 'musig2':
      return {
        ...basePolicy,
        minReputation: 70, // Higher reputation for MuSig2
        maxAdvertisementAge: 30 * 60 * 1000, // 30 minutes
        ...overrides,
      }

    case 'swapsig':
      return {
        ...basePolicy,
        minReputation: 60, // Medium reputation for SwapSig
        maxAdvertisementAge: 60 * 60 * 1000, // 1 hour
        ...overrides,
      }

    default:
      return {
        ...basePolicy,
        ...overrides,
      }
  }
}

// ============================================================================
// Custom Validators
// ============================================================================

/**
 * Validator for MuSig2 advertisements
 */
export const musig2Validator = {
  name: 'musig2-validator',
  validator: async (
    advertisement: DiscoveryAdvertisement,
  ): Promise<boolean> => {
    if (advertisement.protocol !== 'musig2') {
      return true // Not applicable
    }

    // Check for required MuSig2 capabilities
    const requiredCapabilities = [
      'musig2-signer',
      'nonce-commitment',
      'partial-signature',
    ]
    return requiredCapabilities.every(cap =>
      advertisement.capabilities.includes(cap),
    )
  },
}

/**
 * Validator for geographic location
 */
export const locationValidator = {
  name: 'location-validator',
  validator: async (
    advertisement: DiscoveryAdvertisement,
  ): Promise<boolean> => {
    if (!advertisement.location) {
      return true // Location not required
    }

    // Validate coordinate ranges
    const { latitude, longitude } = advertisement.location
    return (
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    )
  },
}

/**
 * Validator for capability completeness
 */
export const capabilityValidator = {
  name: 'capability-validator',
  validator: async (
    advertisement: DiscoveryAdvertisement,
  ): Promise<boolean> => {
    // Ensure advertisement has at least one capability
    return advertisement.capabilities.length > 0
  },
}
