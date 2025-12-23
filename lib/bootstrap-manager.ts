/**
 * Bootstrap Manager
 *
 * Manages connections to bootstrap peers with automatic reconnection,
 * peer list exchange, and capability registration.
 *
 * Phase 1: SDK Connectivity (P1.1)
 */

import { EventEmitter } from 'events'
import type { Libp2p } from 'libp2p'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import type {
  BootstrapConfig,
  BootstrapConnection,
  BootstrapPeerInfo,
} from './types.js'

/**
 * Bootstrap protocol version
 */
export const BOOTSTRAP_PROTOCOL = '/lotus/bootstrap/1.0.0'

/**
 * Default bootstrap configuration
 */
const DEFAULT_CONFIG: Required<BootstrapConfig> = {
  reconnectBaseDelay: 1000, // 1 second
  reconnectMaxDelay: 60000, // 60 seconds
  reconnectJitter: 0.3, // 30% jitter
  maxReconnectAttempts: Infinity,
  healthCheckInterval: 30000, // 30 seconds
  connectionTimeout: 10000, // 10 seconds
}

/**
 * Bootstrap Manager Events
 */
export interface BootstrapManagerEvents {
  'bootstrap:connected': (data: { peerId: string; multiaddr: string }) => void
  'bootstrap:disconnected': (data: { peerId: string; reason?: string }) => void
  'bootstrap:reconnecting': (data: {
    peerId: string
    attempt: number
    delay: number
  }) => void
  'bootstrap:failed': (data: {
    peerId: string
    error: string
    attempts: number
  }) => void
  'bootstrap:peers-received': (data: {
    fromPeerId: string
    peers: BootstrapPeerInfo[]
  }) => void
  'bootstrap:all-connected': () => void
  'bootstrap:all-disconnected': () => void
}

/**
 * Bootstrap Manager
 *
 * Handles:
 * - Automatic reconnection with exponential backoff
 * - Peer list exchange via bootstrap protocol
 * - Capability registration with bootstrap nodes
 * - Health monitoring of bootstrap connections
 */
export class BootstrapManager extends EventEmitter {
  private node?: Libp2p
  private bootstrapPeers: Map<string, BootstrapConnection> = new Map()
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map()
  private healthCheckInterval?: NodeJS.Timeout
  private config: Required<BootstrapConfig>
  private registeredCapabilities: Set<string> = new Set()
  private isStarted = false

  constructor(config?: Partial<BootstrapConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Initialize with libp2p node
   */
  initialize(node: Libp2p): void {
    this.node = node

    // Listen for peer disconnect events to trigger reconnection
    this.node.addEventListener('peer:disconnect', event => {
      const peerId = event.detail.toString()
      if (this.bootstrapPeers.has(peerId)) {
        this._handleBootstrapDisconnect(peerId)
      }
    })

    // Listen for peer connect events
    this.node.addEventListener('peer:connect', event => {
      const peerId = event.detail.toString()
      if (this.bootstrapPeers.has(peerId)) {
        this._handleBootstrapConnect(peerId)
      }
    })
  }

  /**
   * Start managing bootstrap connections
   *
   * @param bootstrapAddrs - Array of bootstrap multiaddrs with peer IDs
   */
  async start(bootstrapAddrs: string[]): Promise<void> {
    if (!this.node) {
      throw new Error(
        'BootstrapManager not initialized - call initialize() first',
      )
    }

    if (this.isStarted) {
      console.warn('[BootstrapManager] Already started')
      return
    }

    this.isStarted = true

    // Parse and store bootstrap peer info
    for (const addr of bootstrapAddrs) {
      const peerId = this._extractPeerId(addr)
      if (peerId) {
        this.bootstrapPeers.set(peerId, {
          peerId,
          multiaddr: addr,
          isConnected: false,
          reconnectAttempts: 0,
          lastConnected: undefined,
          lastDisconnected: undefined,
        })
      }
    }

    // Attempt initial connections
    await this._connectToAll()

    // Start health check interval
    this._startHealthCheck()

    console.log(
      `[BootstrapManager] Started with ${this.bootstrapPeers.size} bootstrap peers`,
    )
  }

  /**
   * Stop managing bootstrap connections
   */
  async stop(): Promise<void> {
    this.isStarted = false

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()

    // Stop health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = undefined
    }

    // Clear state
    this.bootstrapPeers.clear()
    this.registeredCapabilities.clear()

    console.log('[BootstrapManager] Stopped')
  }

  /**
   * Connect to a specific bootstrap peer
   */
  async connect(bootstrapAddr: string): Promise<void> {
    if (!this.node) {
      throw new Error('BootstrapManager not initialized')
    }

    const peerId = this._extractPeerId(bootstrapAddr)
    if (!peerId) {
      throw new Error(`Invalid bootstrap address: ${bootstrapAddr}`)
    }

    // Store if not already tracked
    if (!this.bootstrapPeers.has(peerId)) {
      this.bootstrapPeers.set(peerId, {
        peerId,
        multiaddr: bootstrapAddr,
        isConnected: false,
        reconnectAttempts: 0,
      })
    }

    await this._connectToPeer(peerId)
  }

  /**
   * Manually trigger reconnection to a bootstrap peer
   */
  async reconnect(bootstrapAddr: string): Promise<void> {
    const peerId = this._extractPeerId(bootstrapAddr)
    if (!peerId) {
      throw new Error(`Invalid bootstrap address: ${bootstrapAddr}`)
    }

    const connection = this.bootstrapPeers.get(peerId)
    if (!connection) {
      throw new Error(`Bootstrap peer not found: ${peerId}`)
    }

    // Clear any pending reconnect timer
    const timer = this.reconnectTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(peerId)
    }

    // Reset reconnect attempts for manual reconnect
    connection.reconnectAttempts = 0

    await this._connectToPeer(peerId)
  }

  /**
   * Request peer list from bootstrap node
   *
   * @param protocol - Optional protocol filter (e.g., 'musig2')
   * @returns Array of peer info from bootstrap
   */
  async requestPeerList(protocol?: string): Promise<BootstrapPeerInfo[]> {
    if (!this.node) {
      throw new Error('BootstrapManager not initialized')
    }

    const allPeers: BootstrapPeerInfo[] = []

    // Query all connected bootstrap peers
    for (const [peerId, connection] of this.bootstrapPeers) {
      if (!connection.isConnected) continue

      try {
        const peers = await this._queryBootstrapPeers(peerId, protocol)
        allPeers.push(...peers)

        this.emit('bootstrap:peers-received', {
          fromPeerId: peerId,
          peers,
        })
      } catch (error) {
        console.warn(
          `[BootstrapManager] Failed to get peers from ${peerId}:`,
          error,
        )
      }
    }

    // Deduplicate by peer ID
    const uniquePeers = new Map<string, BootstrapPeerInfo>()
    for (const peer of allPeers) {
      if (!uniquePeers.has(peer.peerId)) {
        uniquePeers.set(peer.peerId, peer)
      }
    }

    return Array.from(uniquePeers.values())
  }

  /**
   * Register a capability with bootstrap nodes
   *
   * @param capability - Capability name (e.g., 'musig2-signer')
   */
  async registerCapability(capability: string): Promise<void> {
    if (!this.node) {
      throw new Error('BootstrapManager not initialized')
    }

    this.registeredCapabilities.add(capability)

    // Register with all connected bootstrap peers
    for (const [peerId, connection] of this.bootstrapPeers) {
      if (!connection.isConnected) continue

      try {
        await this._registerCapabilityWithPeer(peerId, capability)
      } catch (error) {
        console.warn(
          `[BootstrapManager] Failed to register capability with ${peerId}:`,
          error,
        )
      }
    }
  }

  /**
   * Unregister a capability from bootstrap nodes
   */
  async unregisterCapability(capability: string): Promise<void> {
    this.registeredCapabilities.delete(capability)

    // Unregister from all connected bootstrap peers
    for (const [peerId, connection] of this.bootstrapPeers) {
      if (!connection.isConnected) continue

      try {
        await this._unregisterCapabilityWithPeer(peerId, capability)
      } catch (error) {
        console.warn(
          `[BootstrapManager] Failed to unregister capability from ${peerId}:`,
          error,
        )
      }
    }
  }

  /**
   * Get connection status for all bootstrap peers
   */
  getStatus(): Map<string, BootstrapConnection> {
    return new Map(this.bootstrapPeers)
  }

  /**
   * Check if connected to at least one bootstrap peer
   */
  isConnectedToBootstrap(): boolean {
    for (const connection of this.bootstrapPeers.values()) {
      if (connection.isConnected) return true
    }
    return false
  }

  /**
   * Get count of connected bootstrap peers
   */
  getConnectedCount(): number {
    let count = 0
    for (const connection of this.bootstrapPeers.values()) {
      if (connection.isConnected) count++
    }
    return count
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Extract peer ID from multiaddr string
   */
  private _extractPeerId(addr: string): string | null {
    const parts = addr.split('/p2p/')
    if (parts.length >= 2) {
      return parts[parts.length - 1]
    }
    return null
  }

  /**
   * Connect to all bootstrap peers
   */
  private async _connectToAll(): Promise<void> {
    const promises = Array.from(this.bootstrapPeers.keys()).map(peerId =>
      this._connectToPeer(peerId).catch(error => {
        console.warn(
          `[BootstrapManager] Initial connect to ${peerId} failed:`,
          error,
        )
      }),
    )

    await Promise.all(promises)
  }

  /**
   * Connect to a specific bootstrap peer
   */
  private async _connectToPeer(peerId: string): Promise<void> {
    if (!this.node) return

    const connection = this.bootstrapPeers.get(peerId)
    if (!connection) return

    try {
      const ma = multiaddr(connection.multiaddr)

      // Use timeout for connection attempt
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, this.config.connectionTimeout)

      try {
        await this.node.dial(ma, { signal: controller.signal })
        clearTimeout(timeout)

        // Connection successful - state will be updated by peer:connect event
        console.log(`[BootstrapManager] Connected to bootstrap peer: ${peerId}`)
      } catch (error) {
        clearTimeout(timeout)
        throw error
      }
    } catch (error) {
      // Connection failed - schedule reconnect
      this._scheduleReconnect(peerId)
      throw error
    }
  }

  /**
   * Handle bootstrap peer connection
   */
  private _handleBootstrapConnect(peerId: string): void {
    const connection = this.bootstrapPeers.get(peerId)
    if (!connection) return

    // Clear any pending reconnect timer
    const timer = this.reconnectTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(peerId)
    }

    // Update connection state
    connection.isConnected = true
    connection.reconnectAttempts = 0
    connection.lastConnected = Date.now()

    this.emit('bootstrap:connected', {
      peerId,
      multiaddr: connection.multiaddr,
    })

    // Check if all bootstrap peers are now connected
    if (this._allConnected()) {
      this.emit('bootstrap:all-connected')
    }

    // Re-register capabilities with newly connected peer
    this._reregisterCapabilities(peerId).catch(error => {
      console.warn(
        `[BootstrapManager] Failed to re-register capabilities with ${peerId}:`,
        error,
      )
    })
  }

  /**
   * Handle bootstrap peer disconnection
   */
  private _handleBootstrapDisconnect(peerId: string): void {
    const connection = this.bootstrapPeers.get(peerId)
    if (!connection) return

    const wasConnected = connection.isConnected

    // Update connection state
    connection.isConnected = false
    connection.lastDisconnected = Date.now()

    if (wasConnected) {
      this.emit('bootstrap:disconnected', {
        peerId,
        reason: 'peer disconnected',
      })

      // Check if all bootstrap peers are now disconnected
      if (!this.isConnectedToBootstrap()) {
        this.emit('bootstrap:all-disconnected')
      }
    }

    // Schedule reconnection if still running
    if (this.isStarted) {
      this._scheduleReconnect(peerId)
    }
  }

  /**
   * Schedule reconnection with exponential backoff and jitter
   */
  private _scheduleReconnect(peerId: string): void {
    const connection = this.bootstrapPeers.get(peerId)
    if (!connection) return

    // Check max attempts
    if (connection.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emit('bootstrap:failed', {
        peerId,
        error: 'Max reconnect attempts exceeded',
        attempts: connection.reconnectAttempts,
      })
      return
    }

    // Calculate delay with exponential backoff
    const baseDelay = Math.min(
      this.config.reconnectBaseDelay *
        Math.pow(2, connection.reconnectAttempts),
      this.config.reconnectMaxDelay,
    )

    // Add jitter to prevent thundering herd
    const jitter =
      baseDelay * this.config.reconnectJitter * (Math.random() - 0.5)
    const delay = Math.max(0, baseDelay + jitter)

    connection.reconnectAttempts++

    this.emit('bootstrap:reconnecting', {
      peerId,
      attempt: connection.reconnectAttempts,
      delay,
    })

    console.log(
      `[BootstrapManager] Scheduling reconnect to ${peerId} in ${Math.round(delay)}ms (attempt ${connection.reconnectAttempts})`,
    )

    // Clear any existing timer
    const existingTimer = this.reconnectTimers.get(peerId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Schedule reconnect
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(peerId)
      this._connectToPeer(peerId).catch(error => {
        console.warn(`[BootstrapManager] Reconnect to ${peerId} failed:`, error)
        // _connectToPeer will schedule another reconnect on failure
      })
    }, delay)

    this.reconnectTimers.set(peerId, timer)
  }

  /**
   * Start periodic health check
   */
  private _startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this._performHealthCheck()
    }, this.config.healthCheckInterval)
  }

  /**
   * Perform health check on all bootstrap connections
   */
  private _performHealthCheck(): void {
    if (!this.node) return

    for (const [peerId, connection] of this.bootstrapPeers) {
      // Check if we think we're connected
      if (connection.isConnected) {
        // Verify connection is still active
        try {
          const parsedPeerId = peerIdFromString(peerId)
          const connections = this.node.getConnections(parsedPeerId)

          if (connections.length === 0) {
            // Connection lost but we didn't get disconnect event
            console.warn(
              `[BootstrapManager] Health check: ${peerId} connection lost`,
            )
            this._handleBootstrapDisconnect(peerId)
          }
        } catch (error) {
          console.warn(
            `[BootstrapManager] Health check error for ${peerId}:`,
            error,
          )
        }
      }
    }
  }

  /**
   * Check if all bootstrap peers are connected
   */
  private _allConnected(): boolean {
    for (const connection of this.bootstrapPeers.values()) {
      if (!connection.isConnected) return false
    }
    return true
  }

  /**
   * Re-register all capabilities with a peer
   */
  private async _reregisterCapabilities(peerId: string): Promise<void> {
    for (const capability of this.registeredCapabilities) {
      await this._registerCapabilityWithPeer(peerId, capability)
    }
  }

  /**
   * Query bootstrap peer for peer list
   *
   * Uses the bootstrap protocol to request peers with optional protocol filter
   */
  private async _queryBootstrapPeers(
    peerId: string,
    protocol?: string,
  ): Promise<BootstrapPeerInfo[]> {
    if (!this.node) return []

    try {
      const parsedPeerId = peerIdFromString(peerId)
      const stream = await this.node.dialProtocol(
        parsedPeerId,
        BOOTSTRAP_PROTOCOL,
      )

      try {
        // Send request
        const request = JSON.stringify({
          action: 'getPeers',
          protocol: protocol || undefined,
        })

        const encoder = new TextEncoder()
        stream.send(encoder.encode(request))

        // Note: Bootstrap protocol response handling would require
        // the bootstrap server to implement the response side.
        // For now, we return empty and rely on the event emission.
        return []
      } finally {
        await stream.close()
      }
    } catch (error) {
      console.debug(
        `[BootstrapManager] Bootstrap protocol not supported by ${peerId}:`,
        error,
      )
      return []
    }
  }

  /**
   * Register capability with a specific peer
   */
  private async _registerCapabilityWithPeer(
    peerId: string,
    capability: string,
  ): Promise<void> {
    if (!this.node) return

    try {
      const parsedPeerId = peerIdFromString(peerId)
      const stream = await this.node.dialProtocol(
        parsedPeerId,
        BOOTSTRAP_PROTOCOL,
      )

      try {
        const request = JSON.stringify({
          action: 'registerCapability',
          capability,
          peerId: this.node.peerId.toString(),
        })

        const encoder = new TextEncoder()
        stream.send(encoder.encode(request))
      } finally {
        await stream.close()
      }

      console.log(
        `[BootstrapManager] Registered capability '${capability}' with ${peerId}`,
      )
    } catch (error) {
      console.debug(
        `[BootstrapManager] Failed to register capability with ${peerId}:`,
        error,
      )
    }
  }

  /**
   * Unregister capability from a specific peer
   */
  private async _unregisterCapabilityWithPeer(
    peerId: string,
    capability: string,
  ): Promise<void> {
    if (!this.node) return

    try {
      const parsedPeerId = peerIdFromString(peerId)
      const stream = await this.node.dialProtocol(
        parsedPeerId,
        BOOTSTRAP_PROTOCOL,
      )

      try {
        const request = JSON.stringify({
          action: 'unregisterCapability',
          capability,
          peerId: this.node.peerId.toString(),
        })

        const encoder = new TextEncoder()
        stream.send(encoder.encode(request))
      } finally {
        await stream.close()
      }

      console.log(
        `[BootstrapManager] Unregistered capability '${capability}' from ${peerId}`,
      )
    } catch (error) {
      console.debug(
        `[BootstrapManager] Failed to unregister capability from ${peerId}:`,
        error,
      )
    }
  }
}
