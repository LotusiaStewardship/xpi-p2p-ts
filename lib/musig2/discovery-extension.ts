/**
 * MuSig2 Discovery Extension
 *
 * Extends the base discovery layer with MuSig2-specific functionality
 */

import { EventEmitter } from 'events'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'
import type { P2PCoordinator } from '../coordinator.js'
import { DHTAdvertiser } from '../discovery/dht-advertiser.js'
import { DHTDiscoverer } from '../discovery/dht-discoverer.js'
import {
  DiscoveryError,
  DiscoveryErrorType,
  type DiscoveryOptions,
  type DiscoveryAdvertisement,
  type IDiscoveryCache,
} from '../discovery/types.js'
import type {
  MuSig2SignerCriteria,
  MuSig2SigningRequestCriteria,
  MuSig2SignerAdvertisement,
  MuSig2SigningRequestAdvertisement,
  MuSig2DiscoveryConfig,
} from './discovery-types.js'
import {
  DEFAULT_MUSIG2_DISCOVERY_CONFIG,
  isValidSignerAdvertisement,
  isValidSigningRequestAdvertisement,
  publicKeyToHex,
} from './discovery-types.js'
import { MuSig2Event, type TransactionType } from './types.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * MuSig2 Discovery Extension
 * High-level interface for MuSig2 signer and signing request discovery
 */
export class MuSig2Discovery extends EventEmitter {
  private advertiser: DHTAdvertiser
  private discoverer: DHTDiscoverer
  private config: Required<MuSig2DiscoveryConfig>
  private coordinator: P2PCoordinator
  private activeSignerAd: string | null = null
  private activeRequestAds: Map<string, string> = new Map()
  private refreshTimer: NodeJS.Timeout | null = null
  private externalCache?: IDiscoveryCache

  /**
   * Create a MuSig2Discovery instance
   *
   * @param coordinator - The P2P coordinator
   * @param config - MuSig2 discovery configuration
   * @param externalCache - Optional external cache for persistence (e.g., localStorage-backed)
   */
  constructor(
    coordinator: P2PCoordinator,
    config?: Partial<MuSig2DiscoveryConfig>,
    externalCache?: IDiscoveryCache,
  ) {
    super()
    this.coordinator = coordinator
    this.config = { ...DEFAULT_MUSIG2_DISCOVERY_CONFIG, ...config }
    this.externalCache = externalCache

    // Note: DHTAdvertiser is created without a signing key initially.
    // The signing key is set via setSigningKey() before advertising.
    this.advertiser = new DHTAdvertiser(coordinator)
    // Pass external cache to discoverer for persistence
    this.discoverer = new DHTDiscoverer(coordinator, externalCache)
  }

  // ============================================================================
  // Signing Key Management (PHASE 13)
  // ============================================================================

  /**
   * Set the signing key for advertisement signatures
   *
   * PHASE 13: The signing key must be the Bitcore PrivateKey that corresponds
   * to the PublicKey being advertised. This is the wallet's signing key.
   *
   * This must be called before advertiseSigner() or createSigningRequest().
   */
  setSigningKey(signingKey: PrivateKey): void {
    this.advertiser.setSigningKey(signingKey)
  }

  /**
   * Get the current signing key
   */
  getSigningKey(): PrivateKey | undefined {
    return this.advertiser.getSigningKey()
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Start the MuSig2 discovery extension
   */
  async start(): Promise<void> {
    await this.advertiser.start()
    await this.discoverer.start()

    if (
      this.config.enableAutoRefresh &&
      this.config.signerRefreshInterval > 0
    ) {
      this.refreshTimer = setInterval(() => {
        this.refreshActiveAdvertisements().catch(err => {
          this.emit(
            'error',
            new DiscoveryError(
              DiscoveryErrorType.CONFIGURATION_ERROR,
              `Auto-refresh failed: ${err.message}`,
              err,
            ),
          )
        })
      }, this.config.signerRefreshInterval)
    }
  }

  /**
   * Stop the MuSig2 discovery extension
   */
  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }

    await this.withdrawAllAdvertisements()
    await this.advertiser.stop()
    await this.discoverer.stop()
  }

  // ============================================================================
  // Signer Advertisement & Discovery
  // ============================================================================

  /**
   * Advertise as an available signer
   */
  async advertiseSigner(
    publicKey: PublicKey,
    transactionTypes: TransactionType[],
    options?: {
      amountRange?: { min?: number; max?: number }
      metadata?: MuSig2SignerAdvertisement['signerMetadata']
      ttl?: number
    },
  ): Promise<string> {
    if (this.activeSignerAd) {
      throw new DiscoveryError(
        DiscoveryErrorType.INVALID_ADVERTISEMENT,
        'Signer already advertised. Withdraw first before re-advertising.',
      )
    }

    const publicKeyHex = publicKeyToHex(publicKey)
    const advertisementId = this.generateSignerAdId(publicKeyHex)

    // PHASE 2: Get multiaddrs including relay addresses for NAT traversal
    // This is CRITICAL for browser-to-browser connectivity
    const allMultiaddrs = this.coordinator.libp2pNode
      .getMultiaddrs()
      .map(ma => ma.toString())

    // Prioritize relay circuit addresses for NAT traversal
    // Include both direct addresses AND relay addresses
    const multiaddrs = allMultiaddrs.filter(addr => {
      // Include relay circuit addresses (highest priority for NAT traversal)
      if (addr.includes('/p2p-circuit/')) {
        return true
      }
      // Include WebRTC addresses for browser-to-browser
      if (addr.includes('/webrtc/')) {
        return true
      }
      // Include WebSocket addresses
      if (addr.includes('/ws') || addr.includes('/wss')) {
        return true
      }
      // Include direct TCP addresses (for non-browser peers)
      if (addr.includes('/tcp/')) {
        return true
      }
      return false
    })

    // Ensure we have at least some addresses
    const finalMultiaddrs = multiaddrs.length > 0 ? multiaddrs : allMultiaddrs

    // Create advertisement with empty signature placeholder
    // DHTAdvertiser will replace with actual signature if signing key is available
    const advertisement: MuSig2SignerAdvertisement = {
      id: advertisementId,
      protocol: 'musig2',
      peerInfo: {
        peerId: this.coordinator.peerId,
        multiaddrs: finalMultiaddrs,
      },
      publicKey,
      transactionTypes,
      amountRange: options?.amountRange,
      signerMetadata: options?.metadata,
      capabilities: ['musig2-signer', ...transactionTypes],
      createdAt: Date.now(),
      expiresAt: Date.now() + (options?.ttl || this.config.signerTTL),
      reputation: 50,
      signature: Buffer.alloc(64), // Placeholder - replaced by DHTAdvertiser
      customCriteria: {
        transactionTypes,
        publicKeyHex,
      },
    }

    const discoveryOptions: DiscoveryOptions = {
      ttl: options?.ttl || this.config.signerTTL,
      autoRefresh: this.config.enableAutoRefresh,
      refreshInterval: this.config.signerRefreshInterval,
    }

    const adId = await this.advertiser.advertise(
      advertisement,
      discoveryOptions,
    )

    this.activeSignerAd = adId
    this.emit(MuSig2Event.SIGNER_ADVERTISED, advertisement)

    return adId
  }

  /**
   * Withdraw signer advertisement
   */
  async withdrawSigner(): Promise<void> {
    if (!this.activeSignerAd) {
      return
    }

    await this.advertiser.withdraw(this.activeSignerAd)
    this.activeSignerAd = null
    this.emit(MuSig2Event.SIGNER_WITHDRAWN)
  }

  /**
   * Discover available signers
   */
  async discoverSigners(
    criteria: Partial<MuSig2SignerCriteria> = {},
    options?: DiscoveryOptions,
  ): Promise<MuSig2SignerAdvertisement[]> {
    const fullCriteria: MuSig2SignerCriteria = {
      protocol: 'musig2',
      ...criteria,
    }

    const results = await this.discoverer.discover(fullCriteria, options)

    const signerAds: MuSig2SignerAdvertisement[] = []

    for (const ad of results) {
      if (this.isSignerAdvertisement(ad)) {
        if (this.matchesSignerCriteria(ad, fullCriteria)) {
          signerAds.push(ad as MuSig2SignerAdvertisement)
          this.emit(MuSig2Event.SIGNER_DISCOVERED, ad)
        }
      }
    }

    return signerAds
  }

  // ============================================================================
  // Signing Request Advertisement & Discovery
  // ============================================================================

  /**
   * Create and advertise a signing request
   */
  async createSigningRequest(
    requiredPublicKeys: PublicKey[],
    messageHash: string,
    options?: {
      metadata?: MuSig2SigningRequestAdvertisement['requestMetadata']
      ttl?: number
      creatorSignature?: Buffer
    },
  ): Promise<string> {
    if (this.activeRequestAds.size >= this.config.maxConcurrentRequests) {
      throw new DiscoveryError(
        DiscoveryErrorType.RATE_LIMIT_EXCEEDED,
        `Maximum concurrent requests (${this.config.maxConcurrentRequests}) exceeded`,
      )
    }

    const requestId = this.generateRequestId(requiredPublicKeys, messageHash)
    const peerId = this.coordinator.peerId
    const creatorPublicKey = requiredPublicKeys[0]

    // PHASE 2: Get multiaddrs including relay addresses for NAT traversal
    const allMultiaddrs = this.coordinator.libp2pNode
      .getMultiaddrs()
      .map(ma => ma.toString())

    // Prioritize relay circuit addresses for NAT traversal
    const multiaddrs = allMultiaddrs.filter(addr => {
      if (addr.includes('/p2p-circuit/')) return true
      if (addr.includes('/webrtc/')) return true
      if (addr.includes('/ws') || addr.includes('/wss')) return true
      if (addr.includes('/tcp/')) return true
      return false
    })

    const finalMultiaddrs = multiaddrs.length > 0 ? multiaddrs : allMultiaddrs

    // Create advertisement with empty signature placeholder
    // DHTAdvertiser will replace with actual signature if signing key is available
    const advertisement: MuSig2SigningRequestAdvertisement = {
      id: requestId,
      requestId,
      protocol: 'musig2-request',
      peerInfo: {
        peerId,
        multiaddrs: finalMultiaddrs,
      },
      requiredPublicKeys: requiredPublicKeys.map(pk => publicKeyToHex(pk)),
      messageHash,
      creatorPeerId: peerId,
      creatorPublicKey: publicKeyToHex(creatorPublicKey),
      requestMetadata: options?.metadata,
      creatorSignature: options?.creatorSignature || Buffer.alloc(0),
      capabilities: ['musig2-signing-request'],
      createdAt: Date.now(),
      expiresAt: Date.now() + (options?.ttl || this.config.requestTTL),
      reputation: 50,
      signature: Buffer.alloc(64), // Placeholder - replaced by DHTAdvertiser
      customCriteria: {
        requiredPublicKeys: requiredPublicKeys.map(pk => publicKeyToHex(pk)),
        messageHash,
      },
    }

    const discoveryOptions: DiscoveryOptions = {
      ttl: options?.ttl || this.config.requestTTL,
      autoRefresh: false,
    }

    const adId = await this.advertiser.advertise(
      advertisement,
      discoveryOptions,
    )

    this.activeRequestAds.set(requestId, adId)
    this.emit(MuSig2Event.SIGNING_REQUEST_CREATED, advertisement)

    return requestId
  }

  /**
   * Withdraw a signing request
   */
  async withdrawSigningRequest(requestId: string): Promise<void> {
    const adId = this.activeRequestAds.get(requestId)
    if (!adId) {
      return
    }

    await this.advertiser.withdraw(adId)
    this.activeRequestAds.delete(requestId)
  }

  /**
   * Discover signing requests
   */
  async discoverSigningRequests(
    criteria: Partial<MuSig2SigningRequestCriteria> = {},
    options?: DiscoveryOptions,
  ): Promise<MuSig2SigningRequestAdvertisement[]> {
    const fullCriteria: MuSig2SigningRequestCriteria = {
      protocol: 'musig2-request',
      ...criteria,
    }

    const results = await this.discoverer.discover(fullCriteria, options)

    const requestAds: MuSig2SigningRequestAdvertisement[] = []

    for (const ad of results) {
      if (this.isSigningRequestAdvertisement(ad)) {
        if (this.matchesRequestCriteria(ad, fullCriteria)) {
          requestAds.push(ad as MuSig2SigningRequestAdvertisement)
          this.emit(MuSig2Event.SIGNING_REQUEST_RECEIVED, ad)
        }
      }
    }

    return requestAds
  }

  /**
   * Join a signing request
   */
  async joinSigningRequest(
    requestId: string,
    publicKey: PublicKey,
  ): Promise<void> {
    const requests = await this.discoverSigningRequests({ maxResults: 100 })
    const request = requests.find(r => r.requestId === requestId)

    if (!request) {
      throw new DiscoveryError(
        DiscoveryErrorType.INVALID_CRITERIA,
        `Signing request ${requestId} not found`,
      )
    }

    const publicKeyHex = publicKeyToHex(publicKey)
    if (!request.requiredPublicKeys.includes(publicKeyHex)) {
      throw new DiscoveryError(
        DiscoveryErrorType.SECURITY_VALIDATION_FAILED,
        `Public key ${publicKeyHex} not in required signers list`,
      )
    }

    this.emit(MuSig2Event.SIGNING_REQUEST_JOINED, requestId)
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Generate deterministic signer advertisement ID
   *
   * IMPORTANT: This ID is deterministic based on the public key only.
   * This allows updating existing advertisements instead of creating duplicates.
   * The same public key will always generate the same advertisement ID.
   */
  private generateSignerAdId(publicKeyHex: string): string {
    // DETERMINISTIC: Same public key always gets same ID (no Date.now())
    const data = `musig2:signer:${publicKeyHex}`
    const hash = bytesToHex(sha256(new TextEncoder().encode(data)))
    return `${this.config.signerKeyPrefix}${hash.substring(0, 32)}`
  }

  /**
   * Generate deterministic signing request ID
   */
  private generateRequestId(
    requiredPublicKeys: PublicKey[],
    messageHash: string,
  ): string {
    const keysStr = requiredPublicKeys
      .map(pk => publicKeyToHex(pk))
      .sort()
      .join(':')
    const data = `musig2:request:${messageHash}${keysStr}${Date.now().toString()}`
    const hash = bytesToHex(sha256(new TextEncoder().encode(data)))
    return `${this.config.requestKeyPrefix}${hash.substring(0, 32)}`
  }

  /**
   * Check if advertisement is a signer advertisement
   */
  private isSignerAdvertisement(
    ad: DiscoveryAdvertisement,
  ): ad is MuSig2SignerAdvertisement {
    return isValidSignerAdvertisement(ad as Partial<MuSig2SignerAdvertisement>)
  }

  /**
   * Check if advertisement is a signing request
   */
  private isSigningRequestAdvertisement(
    ad: DiscoveryAdvertisement,
  ): ad is MuSig2SigningRequestAdvertisement {
    return isValidSigningRequestAdvertisement(
      ad as Partial<MuSig2SigningRequestAdvertisement>,
    )
  }

  /**
   * Check if signer advertisement matches criteria
   */
  private matchesSignerCriteria(
    ad: MuSig2SignerAdvertisement,
    criteria: MuSig2SignerCriteria,
  ): boolean {
    if (criteria.transactionTypes) {
      const hasMatchingType = criteria.transactionTypes.some(type =>
        ad.transactionTypes.includes(type),
      )
      if (!hasMatchingType) return false
    }

    if (criteria.minAmount !== undefined && ad.amountRange?.max !== undefined) {
      if (ad.amountRange.max < criteria.minAmount) return false
    }

    if (criteria.maxAmount !== undefined && ad.amountRange?.min !== undefined) {
      if (ad.amountRange.min > criteria.maxAmount) return false
    }

    if (criteria.requiredPublicKeys) {
      const publicKeyHex = publicKeyToHex(ad.publicKey)
      if (!criteria.requiredPublicKeys.includes(publicKeyHex)) return false
    }

    if (
      criteria.minMaturation !== undefined &&
      ad.signerMetadata?.identity?.maturationBlocks !== undefined
    ) {
      if (ad.signerMetadata.identity.maturationBlocks < criteria.minMaturation)
        return false
    }

    if (
      criteria.minTotalBurned !== undefined &&
      ad.signerMetadata?.identity?.totalBurned !== undefined
    ) {
      if (ad.signerMetadata.identity.totalBurned < criteria.minTotalBurned)
        return false
    }

    return true
  }

  /**
   * Check if signing request matches criteria
   */
  private matchesRequestCriteria(
    ad: MuSig2SigningRequestAdvertisement,
    criteria: MuSig2SigningRequestCriteria,
  ): boolean {
    if (
      criteria.transactionType &&
      ad.requestMetadata?.transactionType !== criteria.transactionType
    ) {
      return false
    }

    if (criteria.amountRange) {
      const amount = ad.requestMetadata?.amount
      if (amount === undefined) return false

      if (
        criteria.amountRange.min !== undefined &&
        amount < criteria.amountRange.min
      )
        return false
      if (
        criteria.amountRange.max !== undefined &&
        amount > criteria.amountRange.max
      )
        return false
    }

    if (criteria.includesPublicKeys) {
      const hasAllKeys = criteria.includesPublicKeys.every(key =>
        ad.requiredPublicKeys.includes(key),
      )
      if (!hasAllKeys) return false
    }

    if (criteria.creatorPeerIds) {
      if (!criteria.creatorPeerIds.includes(ad.creatorPeerId)) return false
    }

    if (
      criteria.expiresAfter !== undefined &&
      ad.expiresAt < criteria.expiresAfter
    ) {
      return false
    }

    return true
  }

  /**
   * Refresh all active advertisements
   */
  private async refreshActiveAdvertisements(): Promise<void> {
    if (this.activeSignerAd) {
      await this.advertiser.refresh(this.activeSignerAd)
    }

    for (const adId of this.activeRequestAds.values()) {
      await this.advertiser.refresh(adId)
    }
  }

  /**
   * Withdraw all advertisements
   */
  private async withdrawAllAdvertisements(): Promise<void> {
    if (this.activeSignerAd) {
      await this.withdrawSigner()
    }

    for (const requestId of Array.from(this.activeRequestAds.keys())) {
      await this.withdrawSigningRequest(requestId)
    }
  }

  // ============================================================================
  // Real-Time Subscriptions (GossipSub-based)
  // ============================================================================

  /**
   * Subscribe to real-time signer advertisements
   *
   * Uses GossipSub for event-driven notifications when new signers advertise.
   * This is more efficient than polling with discoverSigners().
   *
   * @param criteria - Optional criteria to filter signers
   * @param callback - Callback invoked for each matching signer
   * @returns Subscription ID for unsubscribing
   */
  async subscribeToSigners(
    criteria: Partial<MuSig2SignerCriteria> = {},
    callback: (signer: MuSig2SignerAdvertisement) => void,
  ): Promise<string> {
    const fullCriteria: MuSig2SignerCriteria = {
      protocol: 'musig2',
      ...criteria,
    }

    const subscription = await this.discoverer.subscribe(
      fullCriteria,
      (ad: DiscoveryAdvertisement) => {
        if (this.isSignerAdvertisement(ad)) {
          if (this.matchesSignerCriteria(ad, fullCriteria)) {
            this.emit(MuSig2Event.SIGNER_DISCOVERED, ad)
            callback(ad as MuSig2SignerAdvertisement)
          }
        }
      },
      {
        fetchExisting: true,
        deduplicate: true,
      },
    )

    return subscription.id
  }

  /**
   * Subscribe to real-time signing request advertisements
   *
   * Uses GossipSub for event-driven notifications when new signing requests are created.
   *
   * @param criteria - Optional criteria to filter requests
   * @param callback - Callback invoked for each matching request
   * @returns Subscription ID for unsubscribing
   */
  async subscribeToSigningRequests(
    criteria: Partial<MuSig2SigningRequestCriteria> = {},
    callback: (request: MuSig2SigningRequestAdvertisement) => void,
  ): Promise<string> {
    const fullCriteria: MuSig2SigningRequestCriteria = {
      protocol: 'musig2-request',
      ...criteria,
    }

    const subscription = await this.discoverer.subscribe(
      fullCriteria,
      (ad: DiscoveryAdvertisement) => {
        if (this.isSigningRequestAdvertisement(ad)) {
          if (this.matchesRequestCriteria(ad, fullCriteria)) {
            this.emit(MuSig2Event.SIGNING_REQUEST_RECEIVED, ad)
            callback(ad as MuSig2SigningRequestAdvertisement)
          }
        }
      },
      {
        fetchExisting: true,
        deduplicate: true,
      },
    )

    return subscription.id
  }

  /**
   * Unsubscribe from signer or signing request updates
   *
   * @param subscriptionId - Subscription ID returned from subscribe methods
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    await this.discoverer.unsubscribe(subscriptionId)
  }

  // ============================================================================
  // Cache & Diagnostics
  // ============================================================================

  /**
   * Get cache statistics from the underlying discoverer
   *
   * Useful for diagnostics to understand cache population and hit rates.
   *
   * @returns Cache statistics including size, hits, misses, and hit rate
   */
  getCacheStats(): {
    size: number
    hits: number
    misses: number
    hitRate: number
  } {
    return this.discoverer.getCacheStats()
  }

  /**
   * Clear the discovery cache
   *
   * @param protocol - Optional protocol filter ('musig2' or 'musig2-request')
   */
  clearCache(protocol?: string): void {
    this.discoverer.clearCache(protocol)
  }

  /**
   * Get active subscription IDs
   *
   * @returns Array of active subscription IDs
   */
  getActiveSubscriptions(): string[] {
    return this.discoverer.getActiveSubscriptions()
  }
}
