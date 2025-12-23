/**
 * DHT Advertiser Implementation
 *
 * Handles advertising peer capabilities to DHT
 */

import type { P2PCoordinator } from '../coordinator.js'
import type { P2PMessage } from '../types.js'
import { Hash } from 'xpi-ts/lib/bitcore/crypto/hash'
import { Schnorr } from 'xpi-ts/lib/bitcore/crypto/schnorr'
import { Signature } from 'xpi-ts/lib/bitcore/crypto/signature'
import { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import {
  type IDiscoveryAdvertiser,
  type DiscoveryAdvertisement,
  type DiscoveryOptions,
  type SecurityValidationResult,
  type ReputationData,
  DiscoveryError,
  DiscoveryErrorType,
  DEFAULT_DISCOVERY_OPTIONS,
} from './types.js'

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Active advertisement record
 */
interface ActiveAdvertisement {
  /** Advertisement data */
  advertisement: DiscoveryAdvertisement

  /** Advertisement options */
  options: Required<DiscoveryOptions>

  /** Last refresh timestamp */
  lastRefresh: number

  /** Refresh timer ID */
  refreshTimer?: NodeJS.Timeout

  /** Retry count */
  retryCount: number

  /** Whether advertisement is being withdrawn */
  withdrawing: boolean
}

/**
 * Rate limit tracker
 */
interface RateLimitTracker {
  /** Operations in current window */
  operations: number

  /** Window start timestamp */
  windowStart: number

  /** Peer operation counts */
  peerOperations: Map<string, number>
}

/**
 * DHT-based discovery advertiser
 */
export class DHTAdvertiser implements IDiscoveryAdvertiser {
  private readonly coordinator: P2PCoordinator
  private readonly activeAdvertisements = new Map<string, ActiveAdvertisement>()
  private readonly rateLimitTracker = new Map<
    string,
    { count: number; windowStart: number }
  >()
  private started = false
  private cleanupTimer?: NodeJS.Timeout
  private signingKey?: PrivateKey

  constructor(coordinator: P2PCoordinator, signingKey?: PrivateKey) {
    this.coordinator = coordinator
    this.signingKey = signingKey
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  /**
   * Advertise peer capabilities to DHT
   *
   * If a signing key is available, the signature will be replaced with a valid one.
   */
  async advertise(
    advertisement: DiscoveryAdvertisement,
    options: DiscoveryOptions = {},
  ): Promise<string> {
    if (!this.started) {
      throw new DiscoveryError(
        DiscoveryErrorType.CONFIGURATION_ERROR,
        'Advertiser not started',
      )
    }

    const opts = { ...DEFAULT_DISCOVERY_OPTIONS, ...options }

    // Validate advertisement
    await this.validateAdvertisement(advertisement)

    // Sign advertisement if signing key is available
    if (this.signingKey) {
      advertisement = await this.signAdvertisement(advertisement)
    }

    // Check rate limits
    this.checkRateLimits(advertisement.peerInfo.peerId, opts)

    // Store advertisement
    const record: ActiveAdvertisement = {
      advertisement,
      options: opts,
      lastRefresh: Date.now(),
      retryCount: 0,
      withdrawing: false,
    }

    this.activeAdvertisements.set(advertisement.id, record)

    try {
      // Publish to DHT
      await this.publishToDHT(advertisement, opts)

      // Set up auto-refresh if enabled
      if (opts.autoRefresh) {
        this.setupRefreshTimer(advertisement.id, record)
      }

      return advertisement.id
    } catch (error) {
      // Clean up on failure
      this.activeAdvertisements.delete(advertisement.id)
      throw new DiscoveryError(
        DiscoveryErrorType.DHT_OPERATION_FAILED,
        `Failed to advertise: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      )
    }
  }

  /**
   * Withdraw advertisement from DHT
   */
  async withdraw(advertisementId: string): Promise<void> {
    const record = this.activeAdvertisements.get(advertisementId)
    if (!record) {
      return // Already withdrawn or never existed
    }

    record.withdrawing = true

    // Clear refresh timer
    if (record.refreshTimer) {
      clearTimeout(record.refreshTimer)
      record.refreshTimer = undefined
    }

    try {
      // Remove from DHT
      await this.removeFromDHT(advertisementId)
    } catch (error) {
      throw new DiscoveryError(
        DiscoveryErrorType.DHT_OPERATION_FAILED,
        `Failed to withdraw advertisement: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      )
    } finally {
      // Clean up local record
      this.activeAdvertisements.delete(advertisementId)
    }
  }

  /**
   * Refresh existing advertisement
   */
  async refresh(
    advertisementId: string,
    options: DiscoveryOptions = {},
  ): Promise<void> {
    const record = this.activeAdvertisements.get(advertisementId)
    if (!record) {
      throw new DiscoveryError(
        DiscoveryErrorType.INVALID_ADVERTISEMENT,
        'Advertisement not found',
      )
    }

    if (record.withdrawing) {
      throw new DiscoveryError(
        DiscoveryErrorType.INVALID_ADVERTISEMENT,
        'Advertisement is being withdrawn',
      )
    }

    const opts = { ...record.options, ...options }

    try {
      // Update expiration
      const now = Date.now()
      record.advertisement.expiresAt = now + opts.ttl
      record.lastRefresh = now
      record.retryCount = 0

      // Republish to DHT
      await this.publishToDHT(record.advertisement, opts)

      // Reset refresh timer
      if (opts.autoRefresh && record.refreshTimer) {
        clearTimeout(record.refreshTimer)
        this.setupRefreshTimer(advertisementId, record)
      }
    } catch (error) {
      record.retryCount++

      // Retry if within limits
      if (record.retryCount < opts.maxRetries) {
        setTimeout(() => {
          this.refresh(advertisementId, options).catch(() => {
            // Retry failed, will be handled by cleanup
          })
        }, opts.retryDelay * record.retryCount)
      } else {
        // Max retries reached, withdraw advertisement
        await this.withdraw(advertisementId).catch(() => {
          // Best effort cleanup
        })
      }

      throw new DiscoveryError(
        DiscoveryErrorType.DHT_OPERATION_FAILED,
        `Failed to refresh advertisement: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      )
    }
  }

  /**
   * Get active advertisements
   */
  getActiveAdvertisements(): string[] {
    return Array.from(this.activeAdvertisements.keys())
  }

  /**
   * Check if advertisement is active
   */
  isAdvertisementActive(advertisementId: string): boolean {
    const record = this.activeAdvertisements.get(advertisementId)
    return record !== undefined && !record.withdrawing
  }

  /**
   * Start the advertiser
   */
  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredAdvertisements()
    }, 60 * 1000) // Check every minute
  }

  /**
   * Stop the advertiser
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.started = false

    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }

    // Withdraw all active advertisements
    const withdrawalPromises = Array.from(this.activeAdvertisements.keys()).map(
      id =>
        this.withdraw(id).catch(() => {
          // Best effort cleanup
        }),
    )

    await Promise.allSettled(withdrawalPromises)
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Sign advertisement with private key
   *
   * PHASE 13: For MuSig2 advertisements, the signing key must match the
   * top-level 'publicKey' field (Bitcore wallet key). We no longer add
   * peerInfo.publicKey since that conflates libp2p identity with wallet identity.
   */
  private async signAdvertisement(
    advertisement: DiscoveryAdvertisement,
  ): Promise<DiscoveryAdvertisement> {
    if (!this.signingKey) {
      throw new DiscoveryError(
        DiscoveryErrorType.CONFIGURATION_ERROR,
        'No signing key available',
      )
    }

    try {
      // Construct the message to sign (must match verification)
      const messageData = this.constructSignedMessage(advertisement)

      // Hash the message for Schnorr signing
      const messageHash = Hash.sha256(messageData)

      // Sign with Schnorr (big-endian)
      const signature = Schnorr.sign(messageHash, this.signingKey, 'big')

      // Convert to Buffer and attach to advertisement
      const signedAdvertisement = { ...advertisement }
      signedAdvertisement.signature = signature.toBuffer('schnorr')

      // PHASE 13: For MuSig2 advertisements, do NOT add peerInfo.publicKey
      // The public key for signature verification is in the top-level 'publicKey' field
      // For non-MuSig2 protocols, add peerInfo.publicKey if not present
      if (
        advertisement.protocol !== 'musig2' &&
        advertisement.protocol !== 'musig2-request'
      ) {
        if (!signedAdvertisement.peerInfo.publicKey) {
          signedAdvertisement.peerInfo.publicKey = this.signingKey.publicKey
        }
      }

      return signedAdvertisement
    } catch (error) {
      throw new DiscoveryError(
        DiscoveryErrorType.SIGNATURE_ERROR,
        `Failed to sign advertisement: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  /**
   * Construct the message that will be signed for the advertisement
   * This must exactly match the verification process
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
   * Set signing key for advertisements
   */
  setSigningKey(signingKey: PrivateKey): void {
    this.signingKey = signingKey
  }

  /**
   * Get current signing key
   */
  getSigningKey(): PrivateKey | undefined {
    return this.signingKey
  }

  /**
   * Validate advertisement data
   */
  private async validateAdvertisement(
    advertisement: DiscoveryAdvertisement,
  ): Promise<void> {
    // Check required fields
    if (
      !advertisement.id ||
      !advertisement.protocol ||
      !advertisement.peerInfo
    ) {
      throw new DiscoveryError(
        DiscoveryErrorType.INVALID_ADVERTISEMENT,
        'Missing required advertisement fields',
      )
    }

    // Check expiration
    if (advertisement.expiresAt <= Date.now()) {
      throw new DiscoveryError(
        DiscoveryErrorType.ADVERTISEMENT_EXPIRED,
        'Advertisement already expired',
      )
    }

    // Check peer info
    if (
      !advertisement.peerInfo.peerId ||
      !advertisement.peerInfo.multiaddrs?.length
    ) {
      throw new DiscoveryError(
        DiscoveryErrorType.INVALID_ADVERTISEMENT,
        'Invalid peer information',
      )
    }

    // Validate signature if present
    if (advertisement.signature) {
      // Signature verification is handled by the security layer
      // Advertisements without signatures will have lower security scores
    }
  }

  /**
   * Check rate limits
   */
  private checkRateLimits(
    peerId: string,
    options: Required<DiscoveryOptions>,
  ): void {
    if (!options.enableRateLimit) {
      return
    }

    const now = Date.now()

    // Reset window if needed
    const windowStart = now - options.rateLimitWindow
    let totalOperations = 0
    for (const [pid, tracker] of Array.from(this.rateLimitTracker.entries())) {
      if (tracker.windowStart < windowStart) {
        this.rateLimitTracker.delete(pid)
      } else {
        totalOperations += tracker.count
      }
    }

    // Check global rate limit
    if (totalOperations >= options.maxOperationsPerWindow) {
      throw new DiscoveryError(
        DiscoveryErrorType.RATE_LIMIT_EXCEEDED,
        'Global rate limit exceeded',
      )
    }

    // Check peer-specific rate limit
    const tracker = this.rateLimitTracker.get(peerId) || {
      count: 0,
      windowStart: now,
    }
    if (tracker.count >= 5) {
      // Max 5 advertisements per peer per window
      throw new DiscoveryError(
        DiscoveryErrorType.RATE_LIMIT_EXCEEDED,
        'Peer rate limit exceeded',
      )
    }

    // Update counters
    const currentPeer = this.coordinator.peerId
    const currentTracker = this.rateLimitTracker.get(currentPeer) || {
      count: 0,
      windowStart: now,
    }
    currentTracker.count++
    this.rateLimitTracker.set(currentPeer, currentTracker)
  }

  /**
   * Serialize advertisement for network transport
   *
   * PHASE 12: PublicKey and Buffer instances don't survive JSON serialization.
   * This method converts them to hex strings for transport.
   *
   * PHASE 13: Also serialize MuSig2-specific publicKey field (top-level).
   * For MuSig2 advertisements, the Bitcore wallet public key is in the top-level
   * 'publicKey' field, NOT in peerInfo.publicKey.
   */
  private serializeForTransport(
    advertisement: DiscoveryAdvertisement,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ...advertisement,
      signature: advertisement.signature
        ? advertisement.signature.toString('hex')
        : undefined,
      peerInfo: {
        ...advertisement.peerInfo,
        publicKey: advertisement.peerInfo.publicKey
          ? advertisement.peerInfo.publicKey.toString()
          : undefined,
      },
    }

    // PHASE 13: Serialize MuSig2-specific publicKey field
    // Cast to access potential MuSig2-specific field
    const musig2Ad = advertisement as DiscoveryAdvertisement & {
      publicKey?: PublicKey
    }
    if (
      musig2Ad.publicKey &&
      typeof musig2Ad.publicKey.toString === 'function'
    ) {
      result.publicKey = musig2Ad.publicKey.toString()
    }

    return result
  }

  /**
   * Publish advertisement to GossipSub (PRIMARY) and DHT (SECONDARY)
   *
   * PHASE 2: GossipSub is now the PRIMARY publish path.
   * This implements the correct architecture:
   * - GossipSub: PRIMARY - Real-time notification to all subscribers (discovery mechanism)
   * - DHT: SECONDARY - Persistent storage for specific key lookups only (NOT for "find all" queries)
   *
   * The discover() method now queries LOCAL CACHE which is populated by GossipSub subscriptions.
   * DHT is only used for direct key lookups when you know the exact advertisement ID.
   */
  private async publishToDHT(
    advertisement: DiscoveryAdvertisement,
    options: Required<DiscoveryOptions>,
  ): Promise<void> {
    const topic = this.getGossipSubTopic(advertisement)

    // Serialize for transport (Phase 12: handle PublicKey and Buffer)
    const serialized = this.serializeForTransport(advertisement)

    // 1. PRIMARY: Publish to GossipSub for real-time discovery
    // This is the main discovery mechanism - subscribers receive advertisements immediately
    // PHASE 2: Added retry logic for reliability
    let gossipSubSuccess = false
    const maxRetries = 3
    const retryDelayMs = 1000

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.coordinator.publishToTopic(topic, serialized)
        console.log(
          `[Discovery] Published advertisement to GossipSub topic: ${topic} (attempt ${attempt})`,
        )
        gossipSubSuccess = true
        break
      } catch (error) {
        console.warn(
          `[Discovery] GossipSub publish attempt ${attempt}/${maxRetries} failed for topic ${topic}:`,
          error,
        )
        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          await new Promise(resolve =>
            setTimeout(resolve, retryDelayMs * attempt),
          )
        }
      }
    }

    if (!gossipSubSuccess) {
      console.error(
        `[Discovery] All GossipSub publish attempts failed for topic ${topic}`,
      )
    }

    // 2. SECONDARY: Store in DHT for specific key lookups (optional)
    // NOTE: This is NOT used for "find all" queries - only for direct key lookups
    // when you know the exact advertisement ID
    const dhtStats = this.coordinator.getDHTStats()
    if (dhtStats.isReady) {
      try {
        await this.coordinator.announceResource(
          'discovery:advertisement',
          advertisement.id,
          advertisement,
          {
            ttl: options.ttl,
            expiresAt: advertisement.expiresAt,
          },
        )
        console.log(
          `[Discovery] Stored advertisement in DHT: ${advertisement.id}`,
        )
      } catch (error) {
        // DHT storage failure is non-fatal - GossipSub is the primary path
        console.warn('[Discovery] DHT storage failed (non-fatal):', error)
      }
    } else {
      console.log(
        '[Discovery] DHT not ready - skipping DHT storage (GossipSub is primary)',
      )
    }
  }

  /**
   * Get GossipSub topic for advertisement
   *
   * Topic naming convention matches the discoverer:
   * - lotus/discovery/{protocol}
   */
  private getGossipSubTopic(advertisement: DiscoveryAdvertisement): string {
    return `lotus/discovery/${advertisement.protocol}`
  }

  /**
   * Remove advertisement from DHT
   */
  private async removeFromDHT(advertisementId: string): Promise<void> {
    const dhtKey = `discovery:advertisement:${advertisementId}`

    // Use P2P coordinator's remove method
    // Note: No explicit remove method exists, so we just let it expire
  }

  /**
   * Get DHT key for advertisement
   */
  private getDHTKey(advertisement: DiscoveryAdvertisement): string {
    return `discovery:advertisement:${advertisement.protocol}:${advertisement.id}`
  }

  /**
   * Set up refresh timer
   */
  private setupRefreshTimer(
    advertisementId: string,
    record: ActiveAdvertisement,
  ): void {
    if (record.refreshTimer) {
      clearTimeout(record.refreshTimer)
    }

    const refreshInterval = record.options.refreshInterval
    record.refreshTimer = setTimeout(async () => {
      try {
        await this.refresh(advertisementId)
      } catch (error) {
        // Refresh failed, will be handled by retry logic
        console.error('Advertisement refresh failed:', error)
      }
    }, refreshInterval)
  }

  /**
   * Clean up expired advertisements
   */
  private cleanupExpiredAdvertisements(): void {
    const now = Date.now()
    const expiredIds: string[] = []

    for (const [id, record] of Array.from(
      this.activeAdvertisements.entries(),
    )) {
      if (record.advertisement.expiresAt <= now || record.withdrawing) {
        expiredIds.push(id)
      }
    }

    for (const id of expiredIds) {
      this.withdraw(id).catch(() => {
        // Best effort cleanup
      })
    }
  }
}
