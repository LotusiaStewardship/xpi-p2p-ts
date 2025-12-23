/**
 * P2P Discovery Types
 *
 * Core interfaces for P2P node advertising and discovery
 */

import type { P2PCoordinator } from '../coordinator.js'
import type { P2PMessage, PeerInfo } from '../types.js'

// ============================================================================
// Core Discovery Interfaces
// ============================================================================

/**
 * Discovery criteria for finding peers
 */
export interface DiscoveryCriteria {
  /** Protocol identifier (e.g., 'musig2', 'swapsig') */
  protocol: string

  /** Required capabilities/features */
  capabilities?: string[]

  /** Minimum reputation score */
  minReputation?: number

  /** Geographic location filter */
  location?: {
    latitude: number
    longitude: number
    radiusKm: number
  }

  /** Custom filtering criteria */
  customCriteria?: Record<string, unknown>

  /** Maximum number of results to return */
  maxResults?: number

  /** Discovery timeout in milliseconds */
  timeout?: number
}

/**
 * Advertisement data published to DHT
 *
 * Phase 4 Security: Signatures are now REQUIRED for all advertisements.
 * Unsigned advertisements will be rejected by the security validator.
 */
export interface DiscoveryAdvertisement {
  /** Unique advertisement identifier */
  id: string

  /** Protocol identifier */
  protocol: string

  /** Peer information */
  peerInfo: PeerInfo

  /** List of supported capabilities */
  capabilities: string[]

  /**
   * Advertisement signature for authenticity (REQUIRED - Phase 4)
   * Must be a valid Lotus Schnorr signature over the advertisement data
   */
  signature: Buffer

  /** Creation timestamp */
  createdAt: number

  /** Expiration timestamp */
  expiresAt: number

  /** Reputation score */
  reputation: number

  /** Optional metadata */
  metadata?: Record<string, unknown>

  /** Custom filtering criteria */
  customCriteria?: Record<string, unknown>

  /** Geographic location (if available) */
  location?: {
    latitude: number
    longitude: number
  }
}

/**
 * Unsigned advertisement for internal use before signing
 * Used during advertisement creation before signature is added
 */
export interface UnsignedDiscoveryAdvertisement
  extends Omit<DiscoveryAdvertisement, 'signature'> {
  /** Signature is optional during creation */
  signature?: Buffer
}

/**
 * Discovery operation options
 */
export interface DiscoveryOptions {
  /** Advertisement TTL in milliseconds */
  ttl?: number

  /** Number of replicas for DHT storage */
  replicas?: number

  /** Enable automatic refresh */
  autoRefresh?: boolean

  /** Refresh interval in milliseconds */
  refreshInterval?: number

  /** Enable caching for discovery results */
  enableCache?: boolean

  /** Cache TTL in milliseconds */
  cacheTTL?: number

  /** Maximum retry attempts */
  maxRetries?: number

  /** Retry delay in milliseconds */
  retryDelay?: number

  /** Enable rate limiting */
  enableRateLimit?: boolean

  /** Rate limit window in milliseconds */
  rateLimitWindow?: number

  /** Maximum operations per window */
  maxOperationsPerWindow?: number
}

/**
 * Discovery subscription
 */
export interface DiscoverySubscription {
  /** Subscription identifier */
  id: string

  /** Discovery criteria */
  criteria: DiscoveryCriteria

  /** Subscription callback */
  callback: (advertisement: DiscoveryAdvertisement) => void

  /** Whether subscription is active */
  active: boolean

  /** Subscription creation timestamp */
  createdAt: number

  /** Last activity timestamp */
  lastActivity: number

  /** GossipSub topic for this subscription */
  topic: string
}

/**
 * Subscription options for GossipSub-based discovery
 */
export interface SubscriptionOptions {
  /** Whether to fetch existing advertisements from DHT on subscribe */
  fetchExisting?: boolean

  /** Timeout for initial DHT fetch (ms) */
  fetchTimeout?: number

  /** Whether to deduplicate advertisements by ID */
  deduplicate?: boolean
}

// ============================================================================
// Discovery Cache Interface
// ============================================================================

/**
 * Cache entry for discovered advertisements
 */
export interface DiscoveryCacheEntry {
  /** The advertisement data */
  advertisement: DiscoveryAdvertisement

  /** When the entry was added to cache */
  addedAt: number

  /** Last time this entry was accessed */
  lastAccess: number

  /** Number of times this entry has been accessed */
  accessCount: number

  /** Source of the advertisement */
  source: 'gossipsub' | 'dht' | 'direct'
}

/**
 * Injectable discovery cache interface
 *
 * Allows external cache implementations (e.g., localStorage-backed)
 * to be injected into the discoverer for persistence across page reloads.
 */
export interface IDiscoveryCache {
  /**
   * Get a cache entry by key
   */
  get(key: string): DiscoveryCacheEntry | undefined

  /**
   * Set a cache entry
   */
  set(key: string, entry: DiscoveryCacheEntry): void

  /**
   * Delete a cache entry
   */
  delete(key: string): boolean

  /**
   * Check if a key exists in the cache
   */
  has(key: string): boolean

  /**
   * Get all entries as an iterator
   */
  entries(): IterableIterator<[string, DiscoveryCacheEntry]>

  /**
   * Clear all entries (optionally filtered by protocol)
   */
  clear(protocol?: string): void

  /**
   * Get the number of entries in the cache
   */
  readonly size: number
}

/**
 * Default in-memory cache implementation
 */
export class InMemoryDiscoveryCache implements IDiscoveryCache {
  private cache = new Map<string, DiscoveryCacheEntry>()

  get(key: string): DiscoveryCacheEntry | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccess = Date.now()
      entry.accessCount++
    }
    return entry
  }

  set(key: string, entry: DiscoveryCacheEntry): void {
    this.cache.set(key, entry)
  }

  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  entries(): IterableIterator<[string, DiscoveryCacheEntry]> {
    return this.cache.entries()
  }

  clear(protocol?: string): void {
    if (protocol) {
      for (const [key, entry] of Array.from(this.cache.entries())) {
        if (entry.advertisement.protocol === protocol) {
          this.cache.delete(key)
        }
      }
    } else {
      this.cache.clear()
    }
  }

  get size(): number {
    return this.cache.size
  }
}

// ============================================================================
// Advertiser Interface
// ============================================================================

/**
 * Discovery advertiser interface
 */
export interface IDiscoveryAdvertiser {
  /**
   * Advertise peer capabilities to DHT
   *
   * @param advertisement - Advertisement data
   * @param options - Advertising options
   * @returns Promise resolving to advertisement ID
   */
  advertise(
    advertisement: DiscoveryAdvertisement,
    options?: DiscoveryOptions,
  ): Promise<string>

  /**
   * Withdraw advertisement from DHT
   *
   * @param advertisementId - Advertisement identifier
   * @returns Promise resolving when withdrawn
   */
  withdraw(advertisementId: string): Promise<void>

  /**
   * Refresh existing advertisement
   *
   * @param advertisementId - Advertisement identifier
   * @param options - Refresh options
   * @returns Promise resolving when refreshed
   */
  refresh(advertisementId: string, options?: DiscoveryOptions): Promise<void>

  /**
   * Get active advertisements
   *
   * @returns Array of active advertisement IDs
   */
  getActiveAdvertisements(): string[]

  /**
   * Check if advertisement is active
   *
   * @param advertisementId - Advertisement identifier
   * @returns Whether advertisement is active
   */
  isAdvertisementActive(advertisementId: string): boolean

  /**
   * Start the advertiser
   *
   * @returns Promise resolving when started
   */
  start(): Promise<void>

  /**
   * Stop the advertiser
   *
   * @returns Promise resolving when stopped
   */
  stop(): Promise<void>
}

// ============================================================================
// Discoverer Interface
// ============================================================================

/**
 * Discovery discoverer interface
 */
export interface IDiscoveryDiscoverer {
  /**
   * Discover peers based on criteria
   *
   * @param criteria - Discovery criteria
   * @param options - Discovery options
   * @returns Promise resolving to discovered advertisements
   */
  discover(
    criteria: DiscoveryCriteria,
    options?: DiscoveryOptions,
  ): Promise<DiscoveryAdvertisement[]>

  /**
   * Subscribe to discovery updates via GossipSub (event-driven)
   *
   * @param criteria - Discovery criteria
   * @param callback - Callback for new advertisements
   * @param options - Subscription options
   * @returns Subscription handle
   */
  subscribe(
    criteria: DiscoveryCriteria,
    callback: (advertisement: DiscoveryAdvertisement) => void,
    options?: SubscriptionOptions,
  ): Promise<DiscoverySubscription>

  /**
   * Unsubscribe from discovery updates
   *
   * @param subscriptionId - Subscription identifier
   * @returns Promise resolving when unsubscribed
   */
  unsubscribe(subscriptionId: string): Promise<void>

  /**
   * Get active subscriptions
   *
   * @returns Array of active subscription IDs
   */
  getActiveSubscriptions(): string[]

  /**
   * Clear discovery cache
   *
   * @param protocol - Optional protocol filter
   */
  clearCache(protocol?: string): void

  /**
   * Get cache statistics
   *
   * @returns Cache statistics
   */
  getCacheStats(): {
    size: number
    hits: number
    misses: number
    hitRate: number
  }

  /**
   * Start the discoverer
   *
   * @returns Promise resolving when started
   */
  start(): Promise<void>

  /**
   * Stop the discoverer
   *
   * @returns Promise resolving when stopped
   */
  stop(): Promise<void>
}

// ============================================================================
// Security Types
// ============================================================================

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  /** Whether validation passed */
  valid: boolean

  /** Validation error message (if invalid) */
  error?: string

  /** Security score (0-100) */
  securityScore: number

  /** Validation details */
  details: {
    signatureValid: boolean
    notExpired: boolean
    reputationAcceptable: boolean
    criteriaMatch: boolean
    customValidation: boolean
  }
}

/**
 * Reputation data
 */
export interface ReputationData {
  /** Peer identifier */
  peerId: string

  /** Current reputation score */
  score: number

  /** Number of successful interactions */
  successes: number

  /** Number of failed interactions */
  failures: number

  /** Last interaction timestamp */
  lastInteraction: number

  /** Reputation history */
  history: Array<{
    timestamp: number
    success: boolean
    weight: number
    reason?: string
  }>
}

/**
 * Security policy configuration
 */
export interface SecurityPolicy {
  /** Minimum reputation score */
  minReputation: number

  /** Maximum advertisement age in milliseconds */
  maxAdvertisementAge: number

  /** Enable signature verification */
  enableSignatureVerification: boolean

  /** Enable replay attack prevention */
  enableReplayPrevention: boolean

  /** Enable rate limiting */
  enableRateLimiting: boolean

  /** Rate limit configuration */
  rateLimits: {
    maxAdvertisementsPerPeer: number
    maxDiscoveryQueriesPerPeer: number
    windowSizeMs: number
  }

  /** Custom validation rules */
  customValidators: Array<{
    name: string
    validator: (advertisement: DiscoveryAdvertisement) => boolean
  }>
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Discovery error types
 */
export enum DiscoveryErrorType {
  /** Invalid advertisement data */
  INVALID_ADVERTISEMENT = 'INVALID_ADVERTISEMENT',

  /** Advertisement expired */
  ADVERTISEMENT_EXPIRED = 'ADVERTISEMENT_EXPIRED',

  /** Security validation failed */
  SECURITY_VALIDATION_FAILED = 'SECURITY_VALIDATION_FAILED',

  /** DHT operation failed */
  DHT_OPERATION_FAILED = 'DHT_OPERATION_FAILED',

  /** Network timeout */
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',

  /** Rate limit exceeded */
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  /** Invalid criteria */
  INVALID_CRITERIA = 'INVALID_CRITERIA',

  /** Subscription error */
  SUBSCRIPTION_ERROR = 'SUBSCRIPTION_ERROR',

  /** Cache error */
  CACHE_ERROR = 'CACHE_ERROR',

  /** Configuration error */
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',

  /** Signature error */
  SIGNATURE_ERROR = 'SIGNATURE_ERROR',
}

/**
 * Discovery error
 */
export class DiscoveryError extends Error {
  public readonly type: DiscoveryErrorType
  public readonly cause?: Error

  constructor(type: DiscoveryErrorType, message: string, cause?: Error) {
    super(message)
    this.name = 'DiscoveryError'
    this.type = type
    this.cause = cause
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default discovery options
 */
export const DEFAULT_DISCOVERY_OPTIONS: Required<DiscoveryOptions> = {
  ttl: 30 * 60 * 1000, // 30 minutes
  replicas: 3,
  autoRefresh: true,
  refreshInterval: 20 * 60 * 1000, // 20 minutes
  enableCache: true,
  cacheTTL: 5 * 60 * 1000, // 5 minutes
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  enableRateLimit: true,
  rateLimitWindow: 60 * 1000, // 1 minute
  maxOperationsPerWindow: 10,
}

/**
 * Default security policy
 */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  minReputation: 50,
  maxAdvertisementAge: 60 * 60 * 1000, // 1 hour
  enableSignatureVerification: true,
  enableReplayPrevention: true,
  enableRateLimiting: true,
  rateLimits: {
    maxAdvertisementsPerPeer: 5,
    maxDiscoveryQueriesPerPeer: 20,
    windowSizeMs: 60 * 1000, // 1 minute
  },
  customValidators: [],
}
