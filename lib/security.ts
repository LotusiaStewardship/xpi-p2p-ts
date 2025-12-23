/**
 * Core P2P Security Manager
 *
 * Protocol-agnostic security mechanisms for all P2P/DHT operations
 * Provides base-level protection that all protocols inherit
 */

import { EventEmitter } from 'events'
import {
  CORE_P2P_SECURITY_LIMITS,
  IProtocolValidator,
  CoreSecurityMetrics,
} from './types.js'

// ============================================================================
// DHT Announcement Rate Limiter
// ============================================================================

/**
 * Rate limiter for DHT announcements
 * Prevents spam by limiting announcement frequency per peer
 * Applied universally to all resource types
 */
export class DHTAnnouncementRateLimiter {
  /** Map with keys of peerId and values to Linux timestamp of peer's most recently accepted announcement */
  private lastAnnouncement: Map<string, number> = new Map()
  /** Map with keys of peerId and values to the number of total announcements made by the peer */
  private announcementCount: Map<string, number> = new Map()

  /**
   * Check if peer can make a DHT announcement
   */
  canAnnounce(peerId: string, minInterval: number = 30_000): boolean {
    const now = Date.now()
    const lastTime = this.lastAnnouncement.get(peerId)

    if (!lastTime) {
      this.lastAnnouncement.set(peerId, now)
      this.incrementCount(peerId)
      return true
    }

    const elapsed = now - lastTime
    if (elapsed < minInterval) {
      return false
    }

    this.lastAnnouncement.set(peerId, now)
    this.incrementCount(peerId)
    return true
  }

  /**
   * Increment announcement count
   */
  private incrementCount(peerId: string): void {
    const count = (this.announcementCount.get(peerId) || 0) + 1
    this.announcementCount.set(peerId, count)
  }

  /**
   * Get announcement count for peer
   */
  getCount(peerId: string): number {
    return this.announcementCount.get(peerId) || 0
  }

  /**
   * Cleanup old entries
   */
  cleanup(): void {
    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours

    for (const [peerId, timestamp] of this.lastAnnouncement) {
      if (now - timestamp > maxAge) {
        this.lastAnnouncement.delete(peerId)
        this.announcementCount.delete(peerId)
      }
    }
  }
}

// ============================================================================
// DHT Resource Tracker
// ============================================================================

/**
 * Track DHT resources per peer
 * Prevents a single peer from polluting the DHT
 */
export class DHTResourceTracker {
  private peerResources: Map<string, Set<string>> = new Map() // peerId -> resourceKeys
  private peerResourcesByType: Map<string, Map<string, Set<string>>> = new Map() // peerId -> type -> resourceKeys

  /**
   * Check if peer can announce another resource
   */
  canAnnounceResource(
    peerId: string,
    resourceType: string,
    resourceId: string,
  ): boolean {
    const resourceKey = `${resourceType}:${resourceId}`

    // Check global limit
    const peerResourceSet = this.peerResources.get(peerId) || new Set()
    if (
      peerResourceSet.size >=
        CORE_P2P_SECURITY_LIMITS.MAX_DHT_RESOURCES_PER_PEER &&
      !peerResourceSet.has(resourceKey)
    ) {
      console.warn(
        `[P2P Security] Peer ${peerId} exceeded global DHT resource limit (${CORE_P2P_SECURITY_LIMITS.MAX_DHT_RESOURCES_PER_PEER})`,
      )
      return false
    }

    // Check per-type limit
    let typeMap = this.peerResourcesByType.get(peerId)
    if (!typeMap) {
      typeMap = new Map()
      this.peerResourcesByType.set(peerId, typeMap)
    }

    const typeResourceSet = typeMap.get(resourceType) || new Set()
    if (
      typeResourceSet.size >=
        CORE_P2P_SECURITY_LIMITS.MAX_DHT_RESOURCES_PER_TYPE_PER_PEER &&
      !typeResourceSet.has(resourceId)
    ) {
      console.warn(
        `[P2P Security] Peer ${peerId} exceeded per-type DHT resource limit for ${resourceType} (${CORE_P2P_SECURITY_LIMITS.MAX_DHT_RESOURCES_PER_TYPE_PER_PEER})`,
      )
      return false
    }

    // Add resource
    peerResourceSet.add(resourceKey)
    this.peerResources.set(peerId, peerResourceSet)

    typeResourceSet.add(resourceId)
    typeMap.set(resourceType, typeResourceSet)

    return true
  }

  /**
   * Remove resource when it expires
   */
  removeResource(
    peerId: string,
    resourceType: string,
    resourceId: string,
  ): void {
    const resourceKey = `${resourceType}:${resourceId}`

    // Remove from global set
    const peerResourceSet = this.peerResources.get(peerId)
    if (peerResourceSet) {
      peerResourceSet.delete(resourceKey)
      if (peerResourceSet.size === 0) {
        this.peerResources.delete(peerId)
      }
    }

    // Remove from type-specific set
    const typeMap = this.peerResourcesByType.get(peerId)
    if (typeMap) {
      const typeResourceSet = typeMap.get(resourceType)
      if (typeResourceSet) {
        typeResourceSet.delete(resourceId)
        if (typeResourceSet.size === 0) {
          typeMap.delete(resourceType)
        }
      }
      if (typeMap.size === 0) {
        this.peerResourcesByType.delete(peerId)
      }
    }
  }

  /**
   * Get resource count for peer
   */
  getResourceCount(peerId: string): number {
    return this.peerResources.get(peerId)?.size || 0
  }

  /**
   * Get resource count for peer and type
   */
  getResourceCountByType(peerId: string, resourceType: string): number {
    const typeMap = this.peerResourcesByType.get(peerId)
    return typeMap?.get(resourceType)?.size || 0
  }
}

// ============================================================================
// Core Peer Ban Manager
// ============================================================================

/**
 * Core peer ban management
 * Handles blacklisting and temporary bans at the P2P layer
 */
export class CorePeerBanManager extends EventEmitter {
  private blacklist: Set<string> = new Set()
  private tempBans: Map<string, number> = new Map() // peerId -> until timestamp
  private warningCount: Map<string, number> = new Map()

  /**
   * Ban peer permanently
   */
  banPeer(peerId: string, reason: string): void {
    this.blacklist.add(peerId)
    console.warn(`[P2P Security] ⛔ BANNED peer: ${peerId} (${reason})`)
    this.emit('peer:banned', peerId, reason)
  }

  /**
   * Temporarily ban peer
   */
  tempBanPeer(peerId: string, durationMs: number, reason: string): void {
    const until = Date.now() + durationMs
    this.tempBans.set(peerId, until)
    console.warn(
      `[P2P Security] ⚠️  TEMP BAN: ${peerId} for ${Math.round(durationMs / 1000)}s (${reason})`,
    )
    this.emit('peer:temp-banned', peerId, durationMs, reason)
  }

  /**
   * Issue warning to peer
   */
  warnPeer(peerId: string, reason: string): void {
    const count = (this.warningCount.get(peerId) || 0) + 1
    this.warningCount.set(peerId, count)

    console.warn(`[P2P Security] ⚠️  WARNING ${count}: ${peerId} (${reason})`)
    this.emit('peer:warned', peerId, count, reason)

    // Escalate to temp ban after 5 warnings
    if (count >= 5) {
      this.tempBanPeer(peerId, 60 * 60 * 1000, 'repeated-warnings') // 1 hour
    }

    // Escalate to permanent ban after 10 warnings
    if (count >= 10) {
      this.banPeer(peerId, 'excessive-warnings')
    }
  }

  /**
   * Check if peer is allowed
   */
  isAllowed(peerId: string): boolean {
    // Check permanent ban
    if (this.blacklist.has(peerId)) {
      return false
    }

    // Check temp ban
    const tempBanUntil = this.tempBans.get(peerId)
    if (tempBanUntil && Date.now() < tempBanUntil) {
      return false
    }

    // Remove expired temp ban
    if (tempBanUntil && Date.now() >= tempBanUntil) {
      this.tempBans.delete(peerId)
      console.log(`[P2P Security] Temp ban expired: ${peerId}`)
    }

    return true
  }

  /**
   * Unban peer (admin override)
   */
  unbanPeer(peerId: string): void {
    this.blacklist.delete(peerId)
    this.tempBans.delete(peerId)
    this.warningCount.delete(peerId)
    console.log(`[P2P Security] Unbanned peer: ${peerId}`)
    this.emit('peer:unbanned', peerId)
  }

  /**
   * Get banned peer count
   */
  getBannedCount(): number {
    return this.blacklist.size
  }

  /**
   * Get warning count
   */
  getWarningCount(): number {
    return this.warningCount.size
  }

  /**
   * Get all banned peers
   */
  getBannedPeers(): string[] {
    return Array.from(this.blacklist)
  }
}

// ============================================================================
// Core Security Manager
// ============================================================================

/**
 * Core security manager for P2P coordinator
 * Provides universal security mechanisms for all protocols
 */
export class CoreSecurityManager extends EventEmitter {
  public dhtRateLimiter: DHTAnnouncementRateLimiter
  public resourceTracker: DHTResourceTracker
  public peerBanManager: CorePeerBanManager
  private protocolValidators: Map<string, IProtocolValidator> = new Map()
  private metrics: CoreSecurityMetrics
  private disableRateLimiting: boolean
  private customLimits: Partial<typeof CORE_P2P_SECURITY_LIMITS>

  constructor(config?: {
    disableRateLimiting?: boolean
    customLimits?: Partial<typeof CORE_P2P_SECURITY_LIMITS>
  }) {
    super()

    this.disableRateLimiting = config?.disableRateLimiting ?? false
    this.customLimits = config?.customLimits ?? {}

    this.dhtRateLimiter = new DHTAnnouncementRateLimiter()
    this.resourceTracker = new DHTResourceTracker()
    this.peerBanManager = new CorePeerBanManager()

    this.metrics = {
      dhtAnnouncements: { total: 0, rejected: 0, rateLimited: 0 },
      messages: { total: 0, rejected: 0, oversized: 0 },
      peers: { banned: 0, warnings: 0 },
    }

    // Forward ban manager events
    this.peerBanManager.on('peer:banned', (peerId, reason) => {
      this.metrics.peers.banned++
      this.emit('peer:banned', peerId, reason)
    })

    this.peerBanManager.on('peer:warned', (peerId, count, reason) => {
      this.metrics.peers.warnings++
      this.emit('peer:warned', peerId, count, reason)
    })

    if (this.disableRateLimiting) {
      console.warn('[P2P Security] ⚠️  RATE LIMITING DISABLED (testing mode)')
    }
  }

  /**
   * Register protocol validator
   */
  registerProtocolValidator(
    protocolName: string,
    validator: IProtocolValidator,
  ): void {
    this.protocolValidators.set(protocolName, validator)
  }

  /**
   * Check if peer can announce resource to DHT
   * Combines rate limiting and resource count checks
   */
  async canAnnounceToDHT(
    peerId: string,
    resourceType: string,
    resourceId: string,
    data: unknown,
  ): Promise<boolean> {
    this.metrics.dhtAnnouncements.total++

    // Skip all security checks if disabled (testing only)
    if (this.disableRateLimiting) {
      return true
    }

    // Check if peer is banned
    if (!this.peerBanManager.isAllowed(peerId)) {
      this.metrics.dhtAnnouncements.rejected++
      console.warn(
        `[P2P Security] DHT announcement rejected from banned peer: ${peerId}`,
      )
      return false
    }

    // Check rate limit (use custom limit if provided)
    const minInterval =
      this.customLimits.MIN_DHT_ANNOUNCEMENT_INTERVAL ??
      CORE_P2P_SECURITY_LIMITS.MIN_DHT_ANNOUNCEMENT_INTERVAL

    if (!this.dhtRateLimiter.canAnnounce(peerId, minInterval)) {
      this.metrics.dhtAnnouncements.rateLimited++
      this.peerBanManager.warnPeer(peerId, 'dht-rate-limit-violation')
      console.warn(`[P2P Security] DHT announcement rate limited: ${peerId}`)
      return false
    }

    // Check resource count limits
    if (
      !this.resourceTracker.canAnnounceResource(
        peerId,
        resourceType,
        resourceId,
      )
    ) {
      this.metrics.dhtAnnouncements.rejected++
      this.peerBanManager.warnPeer(peerId, 'dht-resource-limit-exceeded')
      return false
    }

    // Check protocol-specific validator if registered
    const validator = this._findValidatorForResourceType(resourceType)
    if (validator?.canAnnounceResource) {
      const allowed = await validator.canAnnounceResource(resourceType, peerId)
      if (!allowed) {
        this.metrics.dhtAnnouncements.rejected++
        return false
      }
    }

    // Validate announcement data if protocol validator exists
    if (validator?.validateResourceAnnouncement) {
      const valid = await validator.validateResourceAnnouncement(
        resourceType,
        resourceId,
        data,
        peerId,
      )
      if (!valid) {
        this.metrics.dhtAnnouncements.rejected++
        this.peerBanManager.warnPeer(peerId, 'invalid-dht-announcement')
        return false
      }
    }

    return true
  }

  /**
   * Record message processed
   */
  recordMessage(valid: boolean, oversized: boolean = false): void {
    this.metrics.messages.total++
    if (!valid) {
      this.metrics.messages.rejected++
    }
    if (oversized) {
      this.metrics.messages.oversized++
    }
  }

  /**
   * Find protocol validator for resource type
   * Matches by prefix (e.g., "musig2-session" -> "musig2" validator)
   */
  private _findValidatorForResourceType(
    resourceType: string,
  ): IProtocolValidator | undefined {
    // Try exact match first
    if (this.protocolValidators.has(resourceType)) {
      return this.protocolValidators.get(resourceType)
    }

    // Try prefix match (e.g., "musig2-session" -> "musig2")
    for (const [protocolName, validator] of this.protocolValidators) {
      if (resourceType.startsWith(protocolName)) {
        return validator
      }
    }

    return undefined
  }

  /**
   * Cleanup old security data
   */
  cleanup(): void {
    this.dhtRateLimiter.cleanup()
  }

  /**
   * Get security metrics
   */
  getMetrics(): CoreSecurityMetrics {
    return {
      ...this.metrics,
      peers: {
        banned: this.peerBanManager.getBannedCount(),
        warnings: this.peerBanManager.getWarningCount(),
      },
    }
  }

  /**
   * Reset metrics (for testing or periodic reporting)
   */
  resetMetrics(): void {
    this.metrics = {
      dhtAnnouncements: { total: 0, rejected: 0, rateLimited: 0 },
      messages: { total: 0, rejected: 0, oversized: 0 },
      peers: { banned: 0, warnings: 0 },
    }
  }
}
