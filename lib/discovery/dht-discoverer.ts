/**
 * DHT Discoverer Implementation
 *
 * PHASE 2 ARCHITECTURE (ROOT CAUSE FIX):
 *
 * This implementation follows the CORRECT libp2p discovery architecture:
 * - discover(): Queries LOCAL CACHE ONLY (populated by GossipSub subscriptions)
 * - subscribe(): GossipSub subscription for real-time updates (populates cache)
 *
 * WHY DHT IS NOT USED FOR DISCOVERY:
 * - DHT is a key-value store - you can only retrieve exactly what you stored with the exact key
 * - Wildcard queries like "discovery:musig2:all" are architecturally impossible
 * - The correct pattern is: GossipSub for discovery, DHT for specific key lookups
 *
 * HOW IT WORKS:
 * 1. On start(), auto-subscribes to common discovery topics (musig2, musig2-request, etc.)
 * 2. GossipSub messages populate the local cache
 * 3. discover() queries the local cache (fast, synchronous-like)
 * 4. subscribe() creates additional GossipSub subscriptions for real-time updates
 */

import type { P2PCoordinator } from '../coordinator.js'
import type { P2PMessage } from '../types.js'
import {
  type IDiscoveryDiscoverer,
  type IDiscoveryCache,
  type DiscoveryCacheEntry,
  type DiscoveryCriteria,
  type DiscoveryAdvertisement,
  type DiscoveryOptions,
  type DiscoverySubscription,
  type SubscriptionOptions,
  type SecurityValidationResult,
  DiscoveryError,
  DiscoveryErrorType,
  DEFAULT_DISCOVERY_OPTIONS,
  InMemoryDiscoveryCache,
} from './types.js'
import { DiscoverySecurityValidator } from './security.js'
import { Hash } from 'xpi-ts/lib/bitcore/crypto/hash'
import { Schnorr } from 'xpi-ts/lib/bitcore/crypto/schnorr'
import { Signature } from 'xpi-ts/lib/bitcore/crypto/signature'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'

// ============================================================================
// Constants
// ============================================================================

/**
 * GossipSub topic prefix for discovery advertisements
 */
const DISCOVERY_TOPIC_PREFIX = 'lotus/discovery'

/**
 * Default subscription options
 */
const DEFAULT_SUBSCRIPTION_OPTIONS: Required<SubscriptionOptions> = {
  fetchExisting: true,
  fetchTimeout: 5000,
  deduplicate: true,
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal cache entry (compatible with DiscoveryCacheEntry)
 */
interface CacheEntry {
  /** Advertisement data */
  advertisement: DiscoveryAdvertisement

  /** When the entry was added to cache */
  addedAt: number

  /** Cache timestamp (alias for addedAt, for backward compatibility) */
  timestamp: number

  /** Access count */
  accessCount: number

  /** Last access time */
  lastAccess: number

  /** Source of the advertisement */
  source: 'gossipsub' | 'dht' | 'direct'
}

/**
 * Subscription record
 */
interface SubscriptionRecord {
  /** Subscription ID */
  id: string

  /** Subscription criteria */
  criteria: DiscoveryCriteria

  /** GossipSub topic */
  topic: string

  /** Event handler */
  handler: (advertisement: DiscoveryAdvertisement) => void

  /** Whether subscription is active */
  active: boolean

  /** Creation timestamp */
  createdAt: number

  /** Last update timestamp */
  lastUpdate: number

  /** Seen advertisements set (for deduplication) */
  seenAdvertisements: Set<string>

  /** Subscription options */
  options: Required<SubscriptionOptions>
}

/**
 * Cache statistics
 */
interface CacheStats {
  size: number
  hits: number
  misses: number
  hitRate: number
}

// ============================================================================
// DHT Discoverer Class
// ============================================================================

/**
 * DHT-based discovery discoverer with GossipSub subscriptions
 *
 * This implementation follows the proper libp2p architecture:
 * - DHT for persistent storage and one-time queries
 * - GossipSub for real-time event-driven subscriptions
 *
 * Supports injectable cache for persistence across page reloads.
 */
export class DHTDiscoverer implements IDiscoveryDiscoverer {
  private readonly coordinator: P2PCoordinator
  private readonly cache: Map<string, CacheEntry>
  private readonly externalCache?: IDiscoveryCache
  private readonly subscriptions = new Map<string, SubscriptionRecord>()
  private readonly rateLimitTracker = new Map<
    string,
    { count: number; windowStart: number }
  >()
  private started = false
  private cleanupTimer?: NodeJS.Timeout
  private cacheStats: CacheStats = {
    size: 0,
    hits: 0,
    misses: 0,
    hitRate: 0,
  }

  /**
   * Create a new DHTDiscoverer
   *
   * @param coordinator - The P2P coordinator
   * @param externalCache - Optional external cache for persistence (e.g., localStorage-backed)
   */
  constructor(coordinator: P2PCoordinator, externalCache?: IDiscoveryCache) {
    this.coordinator = coordinator
    this.externalCache = externalCache
    this.cache = new Map<string, CacheEntry>()

    // If external cache provided, restore entries to internal cache
    if (externalCache) {
      this.restoreFromExternalCache()
    }
  }

  /**
   * Restore cache entries from external cache
   */
  private restoreFromExternalCache(): void {
    if (!this.externalCache) return

    let restored = 0
    const now = Date.now()

    for (const [key, entry] of this.externalCache.entries()) {
      // Skip expired entries
      if (entry.advertisement.expiresAt <= now) {
        continue
      }

      // Convert to internal CacheEntry format
      this.cache.set(key, {
        advertisement: entry.advertisement,
        addedAt: entry.addedAt,
        timestamp: entry.addedAt,
        accessCount: entry.accessCount,
        lastAccess: entry.lastAccess,
        source: entry.source,
      })
      restored++
    }

    if (restored > 0) {
      console.log(
        `[Discovery] Restored ${restored} entries from external cache`,
      )
    }
    this.updateCacheStats()
  }

  // ========================================================================
  // Public Methods
  // ========================================================================

  /**
   * Discover peers based on criteria (LOCAL CACHE QUERY ONLY)
   *
   * PHASE 2 ROOT CAUSE FIX: This method now queries the LOCAL CACHE ONLY.
   * The cache is populated by GossipSub subscriptions (via subscribe() or auto-subscription).
   *
   * DHT is NOT used for "find all" queries because:
   * - DHT is a key-value store - you can only retrieve exactly what you stored with the exact key
   * - Wildcard queries like "discovery:musig2:all" are architecturally impossible
   * - The correct pattern is: GossipSub for discovery, DHT for specific key lookups
   *
   * For real-time updates, use subscribe() instead.
   */
  async discover(
    criteria: DiscoveryCriteria,
    options?: Partial<DiscoveryOptions>,
  ): Promise<DiscoveryAdvertisement[]> {
    if (!this.started) {
      throw new DiscoveryError(
        DiscoveryErrorType.CONFIGURATION_ERROR,
        'Discoverer not started',
      )
    }

    const opts = { ...DEFAULT_DISCOVERY_OPTIONS, ...options }

    // Check rate limits
    this.checkRateLimits(criteria.protocol, opts)

    const results: DiscoveryAdvertisement[] = []
    const seenIds = new Set<string>()
    const now = Date.now()

    // PHASE 2: Query LOCAL CACHE ONLY
    // The cache is populated by GossipSub subscriptions
    // NOTE: We do NOT query DHT here - DHT is a key-value store,
    // not a search engine. "Find all signers" is not a valid DHT query.
    for (const [_key, entry] of this.cache.entries()) {
      const advertisement = entry.advertisement

      // Skip if doesn't match protocol
      if (advertisement.protocol !== criteria.protocol) {
        continue
      }

      // Skip duplicates
      if (seenIds.has(advertisement.id)) {
        continue
      }
      seenIds.add(advertisement.id)

      // Validate advertisement (check expiration, required fields)
      if (!this.isValidAdvertisement(advertisement, now)) {
        continue
      }

      // Apply criteria filters
      if (!this.matchesCriteria(advertisement, criteria)) {
        continue
      }

      // Validate security
      const securityResult =
        await this.validateAdvertisementSecurity(advertisement)
      if (securityResult.valid && securityResult.securityScore >= 50) {
        results.push(advertisement)
        // Update cache access stats
        entry.accessCount++
        entry.lastAccess = now
        this.cacheStats.hits++
      }
    }

    // Sort results by reputation (descending) and cache relevance
    results.sort((a, b) => {
      const cacheEntryA = this.cache.get(a.id)
      const cacheEntryB = this.cache.get(b.id)

      // Prioritize by reputation, then by cache access frequency
      if (a.reputation !== b.reputation) {
        return b.reputation - a.reputation
      }

      return (cacheEntryB?.accessCount || 0) - (cacheEntryA?.accessCount || 0)
    })

    // Apply maxResults limit
    if (criteria.maxResults && results.length > criteria.maxResults) {
      return results.slice(0, criteria.maxResults)
    }

    console.log(
      `[Discovery] discover() returned ${results.length} results from local cache (protocol: ${criteria.protocol})`,
    )
    return results
  }

  /**
   * Subscribe to discovery updates via GossipSub (event-driven)
   *
   * This creates a real-time subscription using GossipSub pub/sub.
   * New advertisements matching the criteria will trigger the callback
   * immediately when published, without polling.
   *
   * @param criteria - Discovery criteria to match
   * @param callback - Callback invoked for each matching advertisement
   * @param subscriptionOptions - Options for the subscription
   * @returns Subscription handle
   */
  async subscribe(
    criteria: DiscoveryCriteria,
    callback: (advertisement: DiscoveryAdvertisement) => void,
    subscriptionOptions?: SubscriptionOptions,
  ): Promise<DiscoverySubscription> {
    if (!this.started) {
      throw new DiscoveryError(
        DiscoveryErrorType.CONFIGURATION_ERROR,
        'Discoverer not started',
      )
    }

    const opts = { ...DEFAULT_SUBSCRIPTION_OPTIONS, ...subscriptionOptions }
    const subscriptionId = this.generateSubscriptionId(criteria)
    const topic = this.criteriaToTopic(criteria)

    // Create subscription record
    const subscription: SubscriptionRecord = {
      id: subscriptionId,
      criteria,
      topic,
      handler: callback,
      active: true,
      createdAt: Date.now(),
      lastUpdate: Date.now(),
      seenAdvertisements: new Set(),
      options: opts,
    }

    this.subscriptions.set(subscriptionId, subscription)

    // Subscribe to GossipSub topic for real-time updates
    await this.coordinator.subscribeToTopic(topic, (data: Uint8Array) => {
      this.handleGossipSubMessage(subscriptionId, data)
    })

    console.log(
      `[Discovery] Subscribed to GossipSub topic: ${topic} (subscription: ${subscriptionId})`,
    )

    // Optionally fetch existing advertisements from local cache
    // PHASE 2: This now queries the local cache (populated by GossipSub), not DHT
    if (opts.fetchExisting) {
      try {
        const fetchCriteria = {
          ...criteria,
          timeout: opts.fetchTimeout,
        }
        const existing = await this.discover(fetchCriteria)

        // Notify about existing advertisements
        for (const advertisement of existing) {
          if (
            !opts.deduplicate ||
            !subscription.seenAdvertisements.has(advertisement.id)
          ) {
            subscription.seenAdvertisements.add(advertisement.id)
            subscription.lastUpdate = Date.now()

            // Call handler asynchronously to avoid blocking
            setImmediate(() => {
              if (subscription.active) {
                callback(advertisement)
              }
            })
          }
        }
      } catch (error) {
        console.warn(
          `[Discovery] Failed to fetch existing advertisements for subscription ${subscriptionId}:`,
          error,
        )
        // Continue anyway - subscription is still active for new advertisements
      }
    }

    // Return subscription object
    return {
      id: subscriptionId,
      criteria,
      callback,
      active: true,
      createdAt: subscription.createdAt,
      lastActivity: subscription.lastUpdate,
      topic,
    }
  }

  /**
   * Unsubscribe from discovery updates
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) {
      return
    }

    // Mark as inactive first
    subscription.active = false

    // Unsubscribe from GossipSub topic
    try {
      await this.coordinator.unsubscribeFromTopic(subscription.topic)
      console.log(
        `[Discovery] Unsubscribed from GossipSub topic: ${subscription.topic}`,
      )
    } catch (error) {
      console.warn(
        `[Discovery] Failed to unsubscribe from topic ${subscription.topic}:`,
        error,
      )
    }

    // Remove from subscriptions
    this.subscriptions.delete(subscriptionId)
  }

  /**
   * Get active subscriptions
   */
  getActiveSubscriptions(): string[] {
    return Array.from(this.subscriptions.entries())
      .filter(([, record]) => record.active)
      .map(([id]) => id)
  }

  /**
   * Clear discovery cache
   */
  clearCache(protocol?: string): void {
    if (protocol) {
      // Clear only specific protocol entries
      for (const [key, entry] of Array.from(this.cache.entries())) {
        if (entry.advertisement.protocol === protocol) {
          this.cache.delete(key)
        }
      }
    } else {
      // Clear all cache
      this.cache.clear()
    }

    this.updateCacheStats()
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number
    hits: number
    misses: number
    hitRate: number
  } {
    this.updateCacheStats()
    return { ...this.cacheStats }
  }

  /**
   * Start the discoverer
   *
   * PHASE 2: Auto-subscribes to common discovery topics to populate the cache.
   * This ensures discover() has data to return even before explicit subscribe() calls.
   */
  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true

    // Start cleanup timer
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupCache()
        this.cleanupSubscriptions()
      },
      5 * 60 * 1000,
    ) // Every 5 minutes

    // PHASE 2: Auto-subscribe to common discovery topics
    // This ensures the cache is populated before any discover() calls
    // The cache is the PRIMARY source for discover() - not DHT
    await this.autoSubscribeToDiscoveryTopics()
  }

  /**
   * Auto-subscribe to common discovery topics
   *
   * PHASE 2: This populates the local cache with advertisements from the network.
   * Without this, discover() would return empty results because the cache is empty.
   */
  private async autoSubscribeToDiscoveryTopics(): Promise<void> {
    const commonTopics = [
      `${DISCOVERY_TOPIC_PREFIX}/musig2`, // MuSig2 signer advertisements
      `${DISCOVERY_TOPIC_PREFIX}/musig2-request`, // MuSig2 signing requests
      `${DISCOVERY_TOPIC_PREFIX}/wallet-presence`, // Wallet presence/online status
    ]

    for (const topic of commonTopics) {
      try {
        await this.coordinator.subscribeToTopic(topic, (data: Uint8Array) => {
          this.handleAutoSubscriptionMessage(topic, data)
        })
        console.log(`[Discovery] Auto-subscribed to topic: ${topic}`)
      } catch (error) {
        // Non-fatal - some topics may not be available
        console.warn(`[Discovery] Failed to auto-subscribe to ${topic}:`, error)
      }
    }
  }

  /**
   * Handle incoming GossipSub message from auto-subscription
   *
   * PHASE 2: Parses advertisements and adds them to the local cache.
   * This is how discover() gets its data.
   *
   * PHASE 4: Adds signature verification - unsigned advertisements are rejected.
   */
  private handleAutoSubscriptionMessage(topic: string, data: Uint8Array): void {
    try {
      // Parse and deserialize the advertisement from the message
      // PHASE 12: Use deserializeFromTransport to reconstruct PublicKey and Buffer
      const messageStr = new TextDecoder().decode(data)
      const rawData = JSON.parse(messageStr) as Record<string, unknown>
      const advertisement = this.deserializeFromTransport(rawData)

      // Validate advertisement structure and expiration
      if (!this.isValidAdvertisement(advertisement, Date.now())) {
        console.warn(
          `[Discovery] Invalid advertisement received on auto-subscription topic ${topic}`,
        )
        return
      }

      // PHASE 4: Verify signature - reject unsigned advertisements
      if (!this.verifyAdvertisementSignature(advertisement)) {
        console.warn(
          `[Discovery] Rejecting unsigned/invalid advertisement on auto-subscription topic ${topic}: ${advertisement.id}`,
        )
        return
      }

      // Add to cache - this makes it available to discover()
      this.addToCache(advertisement)
      console.log(
        `[Discovery] Cached advertisement from auto-subscription: ${advertisement.id} (protocol: ${advertisement.protocol})`,
      )
    } catch (error) {
      console.warn(
        `[Discovery] Failed to parse auto-subscription message from ${topic}:`,
        error,
      )
    }
  }

  /**
   * Stop the discoverer
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

    // Unsubscribe from all GossipSub topics
    const subscriptionIds = Array.from(this.subscriptions.keys())
    await Promise.allSettled(subscriptionIds.map(id => this.unsubscribe(id)))
  }

  // ========================================================================
  // Private Methods - GossipSub Handling
  // ========================================================================

  /**
   * Deserialize advertisement from network transport
   *
   * PHASE 12: PublicKey and Buffer instances don't survive JSON serialization.
   * This method reconstructs them from hex strings.
   */
  private deserializeFromTransport(
    raw: Record<string, unknown>,
  ): DiscoveryAdvertisement {
    const peerInfo = raw.peerInfo as Record<string, unknown>

    // Build the base advertisement
    const result: Record<string, unknown> = {
      ...raw,
      signature:
        typeof raw.signature === 'string'
          ? Buffer.from(raw.signature, 'hex')
          : raw.signature,
      peerInfo: {
        ...peerInfo,
        // Note: peerInfo.publicKey is NOT used for MuSig2 - see publicKey field below
        publicKey:
          typeof peerInfo.publicKey === 'string'
            ? PublicKey.fromString(peerInfo.publicKey)
            : peerInfo.publicKey,
      },
    }

    // PHASE 13: Deserialize MuSig2-specific publicKey field
    // For MuSig2 advertisements, the wallet's Bitcore PublicKey is in the top-level
    // 'publicKey' field, NOT in peerInfo.publicKey (which is for libp2p identity)
    if (typeof raw.publicKey === 'string') {
      result.publicKey = PublicKey.fromString(raw.publicKey)
    }

    return result as unknown as DiscoveryAdvertisement
  }

  /**
   * Handle incoming GossipSub message
   *
   * PHASE 4: Adds signature verification - unsigned advertisements are rejected.
   */
  private handleGossipSubMessage(
    subscriptionId: string,
    data: Uint8Array,
  ): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || !subscription.active) {
      return
    }

    try {
      // Parse and deserialize the advertisement from the message
      // PHASE 12: Use deserializeFromTransport to reconstruct PublicKey and Buffer
      const messageStr = new TextDecoder().decode(data)
      const rawData = JSON.parse(messageStr) as Record<string, unknown>
      const advertisement = this.deserializeFromTransport(rawData)

      // Validate advertisement structure
      if (!this.isValidAdvertisement(advertisement, Date.now())) {
        console.warn(
          `[Discovery] Invalid advertisement received on topic ${subscription.topic}`,
        )
        return
      }

      // PHASE 4: Verify signature - reject unsigned advertisements
      if (!this.verifyAdvertisementSignature(advertisement)) {
        console.warn(
          `[Discovery] Rejecting unsigned/invalid advertisement on topic ${subscription.topic}: ${advertisement.id}`,
        )
        return
      }

      // Check if it matches criteria
      if (!this.matchesCriteria(advertisement, subscription.criteria)) {
        // Doesn't match criteria - ignore
        return
      }

      // Deduplicate if enabled
      if (
        subscription.options.deduplicate &&
        subscription.seenAdvertisements.has(advertisement.id)
      ) {
        return
      }

      // Mark as seen
      subscription.seenAdvertisements.add(advertisement.id)
      subscription.lastUpdate = Date.now()

      // Add to cache
      this.addToCache(advertisement)

      // Invoke callback
      subscription.handler(advertisement)
    } catch (error) {
      console.error(
        `[Discovery] Error processing GossipSub message for subscription ${subscriptionId}:`,
        error,
      )
    }
  }

  /**
   * Convert criteria to GossipSub topic
   *
   * Topic naming convention:
   * - lotus/discovery/{protocol} - All advertisements for a protocol
   * - lotus/discovery/{protocol}/{capability} - Capability-specific (future)
   */
  private criteriaToTopic(criteria: DiscoveryCriteria): string {
    // Base topic is protocol-specific
    return `${DISCOVERY_TOPIC_PREFIX}/${criteria.protocol}`
  }

  // ========================================================================
  // Private Methods - DHT Operations
  // ========================================================================

  /**
   * Get DHT keys for discovery criteria
   */
  private getDHTKeys(criteria: DiscoveryCriteria): string[] {
    const keys: string[] = []

    // Protocol-specific key
    keys.push(`discovery:${criteria.protocol}:all`)

    // Capability-specific keys
    if (criteria.capabilities) {
      for (const capability of criteria.capabilities) {
        keys.push(`discovery:${criteria.protocol}:capability:${capability}`)
      }
    }

    // Location-based key (if location filter is specified)
    if (criteria.location) {
      const latGrid = Math.floor(criteria.location.latitude / 5) * 5 // 5-degree grid
      const lonGrid = Math.floor(criteria.location.longitude / 5) * 5
      keys.push(`discovery:${criteria.protocol}:location:${latGrid}:${lonGrid}`)
    }

    return keys
  }

  /**
   * Check if advertisement is valid
   */
  private isValidAdvertisement(
    advertisement: DiscoveryAdvertisement,
    now: number,
  ): boolean {
    // Check required fields
    if (
      !advertisement.id ||
      !advertisement.protocol ||
      !advertisement.peerInfo
    ) {
      return false
    }

    // Check expiration
    if (advertisement.expiresAt <= now) {
      return false
    }

    // Check peer info
    if (
      !advertisement.peerInfo.peerId ||
      !advertisement.peerInfo.multiaddrs?.length
    ) {
      return false
    }

    return true
  }

  /**
   * Check if advertisement matches criteria
   */
  private matchesCriteria(
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

    // Custom criteria
    if (criteria.customCriteria) {
      if (!advertisement.customCriteria) {
        return false
      }

      // Check if all custom criteria keys match
      for (const [key, expectedValue] of Object.entries(
        criteria.customCriteria,
      )) {
        const actualValue = advertisement.customCriteria[key]
        if (actualValue !== expectedValue) {
          return false
        }
      }
    }

    return true
  }

  /**
   * Validate advertisement security
   */
  private async validateAdvertisementSecurity(
    advertisement: DiscoveryAdvertisement,
  ): Promise<SecurityValidationResult> {
    const now = Date.now()
    const result: SecurityValidationResult = {
      valid: true,
      securityScore: 100,
      details: {
        signatureValid: true,
        notExpired: advertisement.expiresAt > now,
        reputationAcceptable: advertisement.reputation >= 50,
        criteriaMatch: true,
        customValidation: true,
      },
    }

    // Check expiration
    if (!result.details.notExpired) {
      result.valid = false
      result.error = 'Advertisement expired'
      result.securityScore -= 50
    }

    // Check reputation
    if (!result.details.reputationAcceptable) {
      result.valid = false
      result.error = 'Reputation too low'
      result.securityScore -= 30
    }

    // Validate signature if present
    if (advertisement.signature) {
      try {
        // Use the security validator to verify the signature
        const securityValidator = new DiscoverySecurityValidator(
          this.coordinator,
          {
            enableSignatureVerification: true,
            enableReplayPrevention: true,
            enableRateLimiting: false, // Skip rate limiting for validation
            rateLimits: {
              maxAdvertisementsPerPeer: 0,
              maxDiscoveryQueriesPerPeer: 0,
              windowSizeMs: 0,
            },
            minReputation: 0, // Minimum reputation threshold
            maxAdvertisementAge: 24 * 60 * 60 * 1000, // 24 hours
            customValidators: [],
          },
        )

        const validation = await securityValidator.validateAdvertisement(
          advertisement,
          {} as DiscoveryCriteria, // Empty criteria for signature validation only
        )
        result.details.signatureValid = validation.details.signatureValid
      } catch (error) {
        result.details.signatureValid = false
        result.securityScore -= 20
      }
    }

    return result
  }

  // ========================================================================
  // Private Methods - Cache Management
  // ========================================================================

  /**
   * Add advertisement to cache
   *
   * @param advertisement - The advertisement to cache
   * @param source - Source of the advertisement (default: 'gossipsub')
   */
  private addToCache(
    advertisement: DiscoveryAdvertisement,
    source: 'gossipsub' | 'dht' | 'direct' = 'gossipsub',
  ): void {
    const existing = this.cache.get(advertisement.id)
    const now = Date.now()

    let entry: CacheEntry

    if (existing) {
      // Update existing entry
      existing.timestamp = now
      existing.addedAt = existing.addedAt || now // Preserve original addedAt
      existing.accessCount++
      existing.lastAccess = now
      entry = existing
    } else {
      // Add new entry
      entry = {
        advertisement,
        addedAt: now,
        timestamp: now,
        accessCount: 1,
        lastAccess: now,
        source,
      }
      this.cache.set(advertisement.id, entry)
    }

    // Sync to external cache if available
    if (this.externalCache) {
      this.externalCache.set(advertisement.id, {
        advertisement: entry.advertisement,
        addedAt: entry.addedAt,
        lastAccess: entry.lastAccess,
        accessCount: entry.accessCount,
        source: entry.source,
      })
    }

    this.updateCacheStats()
  }

  /**
   * Check rate limits
   */
  private checkRateLimits(
    protocol: string,
    options: Required<DiscoveryOptions>,
  ): void {
    if (!options.enableCache) {
      return
    }

    const now = Date.now()
    const windowStart = now - options.cacheTTL
    const key = `discover:${protocol}`

    let tracker = this.rateLimitTracker.get(key)
    if (!tracker || tracker.windowStart < windowStart) {
      tracker = { count: 0, windowStart: now }
      this.rateLimitTracker.set(key, tracker)
    }

    if (tracker.count >= 100) {
      // Max 100 discoveries per cache TTL
      throw new DiscoveryError(
        DiscoveryErrorType.RATE_LIMIT_EXCEEDED,
        'Discovery rate limit exceeded',
      )
    }

    tracker.count++
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now()
    const maxAge = 30 * 60 * 1000 // 30 minutes

    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (now - entry.timestamp > maxAge) {
        this.cache.delete(key)
      }
    }

    this.updateCacheStats()
  }

  /**
   * Clean up inactive subscriptions
   */
  private cleanupSubscriptions(): void {
    const now = Date.now()
    const maxAge = 60 * 60 * 1000 // 1 hour

    const inactiveIds: string[] = []
    for (const [id, subscription] of Array.from(this.subscriptions.entries())) {
      if (!subscription.active || now - subscription.lastUpdate > maxAge) {
        inactiveIds.push(id)
      }
    }

    for (const id of inactiveIds) {
      this.unsubscribe(id).catch(() => {
        // Best effort cleanup
      })
    }
  }

  // ========================================================================
  // Private Methods - Utilities
  // ========================================================================

  /**
   * Calculate distance between two coordinates (Haversine formula)
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
   * Generate subscription ID
   */
  private generateSubscriptionId(criteria: DiscoveryCriteria): string {
    const hash = this.simpleHash(JSON.stringify(criteria) + Date.now())
    return `sub:${hash}`
  }

  /**
   * Simple hash function for generating IDs
   */
  private simpleHash(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash)
  }

  /**
   * Update cache statistics
   */
  private updateCacheStats(): void {
    this.cacheStats.size = this.cache.size
    const total = this.cacheStats.hits + this.cacheStats.misses
    this.cacheStats.hitRate = total > 0 ? this.cacheStats.hits / total : 0
  }

  // ========================================================================
  // Phase 4 Security Methods
  // ========================================================================

  /**
   * Verify advertisement signature (Phase 4)
   *
   * SECURITY: All advertisements MUST be signed with Lotus Schnorr.
   * Unsigned or invalid signatures are rejected.
   *
   * @param advertisement - The advertisement to verify
   * @returns true if signature is valid, false otherwise
   */
  private verifyAdvertisementSignature(
    advertisement: DiscoveryAdvertisement,
  ): boolean {
    // Phase 4: Signature is required
    if (!advertisement.signature) {
      console.warn(
        `[Discovery] Advertisement ${advertisement.id} has no signature`,
      )
      return false
    }

    // PHASE 13: Get the correct public key based on protocol
    // For MuSig2 advertisements, use the top-level 'publicKey' field (Bitcore wallet key)
    // For other protocols, fall back to peerInfo.publicKey
    const publicKey = this.getAdvertisementPublicKey(advertisement)
    if (!publicKey) {
      console.warn(
        `[Discovery] Advertisement ${advertisement.id} has no public key`,
      )
      return false
    }

    try {
      // Construct the signed message
      const messageData = this.constructSignedMessage(advertisement)

      // Hash the message for Schnorr verification
      const messageHash = Hash.sha256(messageData)

      // Parse signature from Buffer
      const signature = Signature.fromBuffer(advertisement.signature)
      signature.isSchnorr = true

      // Verify the Schnorr signature using Lotus format (big-endian)
      return Schnorr.verify(messageHash, signature, publicKey, 'big')
    } catch (error) {
      console.error(
        `[Discovery] Signature verification failed for ${advertisement.id}:`,
        error,
      )
      return false
    }
  }

  /**
   * Get the public key to use for signature verification
   *
   * PHASE 13: For MuSig2 advertisements, the Bitcore wallet public key is in
   * the top-level 'publicKey' field. For other protocols, use peerInfo.publicKey.
   *
   * This separation exists because:
   * - peerInfo.peerId is the libp2p peer ID (for P2P transport/coordination)
   * - MuSig2SignerAdvertisement.publicKey is the Bitcore wallet key (for MuSig2 identity)
   */
  private getAdvertisementPublicKey(
    advertisement: DiscoveryAdvertisement,
  ): PublicKey | undefined {
    // For MuSig2 protocol, use the top-level publicKey field
    if (
      advertisement.protocol === 'musig2' ||
      advertisement.protocol === 'musig2-request'
    ) {
      // Cast to access MuSig2-specific field
      const musig2Ad = advertisement as DiscoveryAdvertisement & {
        publicKey?: PublicKey
        creatorPublicKey?: string
      }

      // For signer advertisements, use publicKey
      if (musig2Ad.publicKey instanceof PublicKey) {
        return musig2Ad.publicKey
      }

      // For signing request advertisements, use creatorPublicKey
      if (typeof musig2Ad.creatorPublicKey === 'string') {
        try {
          return PublicKey.fromString(musig2Ad.creatorPublicKey)
        } catch {
          // Fall through to peerInfo.publicKey
        }
      }
    }

    // Fall back to peerInfo.publicKey for other protocols
    return advertisement.peerInfo.publicKey
  }

  /**
   * Construct the message that was signed for the advertisement
   * This must exactly match the signing process in the advertiser
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
}
