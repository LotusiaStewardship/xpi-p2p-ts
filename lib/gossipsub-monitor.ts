/**
 * GossipSub Monitor
 *
 * Monitors GossipSub mesh health and provides diagnostics for
 * topic connectivity and message propagation.
 *
 * Phase 1: SDK Connectivity (P1.3)
 */

import { EventEmitter } from 'events'
import type { Libp2p } from 'libp2p'
import type { GossipSub } from '@libp2p/gossipsub'

/**
 * Topic mesh health information
 */
export interface TopicMeshHealth {
  topic: string
  meshPeers: number
  fanoutPeers: number
  subscriberCount: number
  isHealthy: boolean
  lastChecked: number
}

/**
 * Overall GossipSub health
 */
export interface GossipSubHealth {
  isEnabled: boolean
  totalTopics: number
  healthyTopics: number
  unhealthyTopics: number
  totalMeshPeers: number
  topics: TopicMeshHealth[]
}

/**
 * GossipSub Monitor configuration
 */
export interface GossipSubMonitorConfig {
  /** Minimum mesh peers for healthy status (default: 2) */
  minMeshPeers: number
  /** Health check interval in ms (default: 30000) */
  healthCheckInterval: number
  /** Enable automatic health checks (default: true) */
  autoHealthCheck: boolean
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: GossipSubMonitorConfig = {
  minMeshPeers: 2,
  healthCheckInterval: 30000,
  autoHealthCheck: true,
}

/**
 * GossipSub Monitor Events
 */
export interface GossipSubMonitorEvents {
  'mesh:healthy': (data: { topic: string; meshPeers: number }) => void
  'mesh:unhealthy': (data: {
    topic: string
    meshPeers: number
    required: number
  }) => void
  'mesh:recovered': (data: { topic: string; meshPeers: number }) => void
  'health:check': (data: GossipSubHealth) => void
}

/**
 * GossipSub Monitor
 *
 * Provides:
 * - Real-time mesh health monitoring per topic
 * - Automatic health checks with configurable intervals
 * - Events for mesh state changes
 * - Diagnostics for debugging connectivity issues
 */
export class GossipSubMonitor extends EventEmitter {
  private node?: Libp2p
  private config: GossipSubMonitorConfig
  private healthCheckInterval?: NodeJS.Timeout
  private topicHealthCache: Map<string, TopicMeshHealth> = new Map()
  private isStarted = false

  constructor(config?: Partial<GossipSubMonitorConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Initialize with libp2p node
   */
  initialize(node: Libp2p): void {
    this.node = node
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (!this.node) {
      throw new Error(
        'GossipSubMonitor not initialized - call initialize() first',
      )
    }

    if (this.isStarted) {
      return
    }

    this.isStarted = true

    // Start automatic health checks if enabled
    if (this.config.autoHealthCheck) {
      this._startHealthChecks()
    }

    console.log('[GossipSubMonitor] Started')
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    this.isStarted = false

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = undefined
    }

    this.topicHealthCache.clear()

    console.log('[GossipSubMonitor] Stopped')
  }

  /**
   * Get mesh health for a specific topic
   */
  getTopicMeshHealth(topic: string): TopicMeshHealth {
    if (!this.node) {
      return {
        topic,
        meshPeers: 0,
        fanoutPeers: 0,
        subscriberCount: 0,
        isHealthy: false,
        lastChecked: Date.now(),
      }
    }

    const pubsub = this.node.services.pubsub as GossipSub | undefined
    if (!pubsub) {
      return {
        topic,
        meshPeers: 0,
        fanoutPeers: 0,
        subscriberCount: 0,
        isHealthy: false,
        lastChecked: Date.now(),
      }
    }

    // Get mesh peers for topic
    const meshPeers = this._getMeshPeersCount(pubsub, topic)
    const fanoutPeers = this._getFanoutPeersCount(pubsub, topic)
    const subscriberCount = pubsub.getSubscribers(topic).length

    const isHealthy = meshPeers >= this.config.minMeshPeers

    const health: TopicMeshHealth = {
      topic,
      meshPeers,
      fanoutPeers,
      subscriberCount,
      isHealthy,
      lastChecked: Date.now(),
    }

    // Check for state changes
    const previousHealth = this.topicHealthCache.get(topic)
    if (previousHealth) {
      if (!previousHealth.isHealthy && isHealthy) {
        this.emit('mesh:recovered', { topic, meshPeers })
      } else if (previousHealth.isHealthy && !isHealthy) {
        this.emit('mesh:unhealthy', {
          topic,
          meshPeers,
          required: this.config.minMeshPeers,
        })
      }
    }

    // Update cache
    this.topicHealthCache.set(topic, health)

    return health
  }

  /**
   * Get overall GossipSub health
   */
  getOverallHealth(): GossipSubHealth {
    if (!this.node) {
      return {
        isEnabled: false,
        totalTopics: 0,
        healthyTopics: 0,
        unhealthyTopics: 0,
        totalMeshPeers: 0,
        topics: [],
      }
    }

    const pubsub = this.node.services.pubsub as GossipSub | undefined
    if (!pubsub) {
      return {
        isEnabled: false,
        totalTopics: 0,
        healthyTopics: 0,
        unhealthyTopics: 0,
        totalMeshPeers: 0,
        topics: [],
      }
    }

    // Get all subscribed topics
    const topics = pubsub.getTopics()
    const topicHealths: TopicMeshHealth[] = []

    let healthyCount = 0
    let unhealthyCount = 0
    let totalMeshPeers = 0

    for (const topic of topics) {
      const health = this.getTopicMeshHealth(topic)
      topicHealths.push(health)

      if (health.isHealthy) {
        healthyCount++
      } else {
        unhealthyCount++
      }

      totalMeshPeers += health.meshPeers
    }

    const overallHealth: GossipSubHealth = {
      isEnabled: true,
      totalTopics: topics.length,
      healthyTopics: healthyCount,
      unhealthyTopics: unhealthyCount,
      totalMeshPeers,
      topics: topicHealths,
    }

    this.emit('health:check', overallHealth)

    return overallHealth
  }

  /**
   * Check if a topic has healthy mesh connectivity
   */
  isTopicHealthy(topic: string): boolean {
    const health = this.getTopicMeshHealth(topic)
    return health.isHealthy
  }

  /**
   * Get list of all monitored topics
   */
  getMonitoredTopics(): string[] {
    return Array.from(this.topicHealthCache.keys())
  }

  /**
   * Get peers in mesh for a topic
   */
  getMeshPeers(topic: string): string[] {
    if (!this.node) {
      return []
    }

    const pubsub = this.node.services.pubsub as GossipSub | undefined
    if (!pubsub) {
      return []
    }

    // GossipSub mesh peers can be accessed via getPeers for the topic
    // or through internal mesh structure if available
    try {
      // Use getSubscribers as a proxy for mesh peers
      // In GossipSub, subscribers are the peers we know about for a topic
      const subscribers = pubsub.getSubscribers(topic)
      return subscribers.map(p => p.toString())
    } catch {
      return []
    }
  }

  /**
   * Get all subscribers for a topic
   */
  getTopicSubscribers(topic: string): string[] {
    if (!this.node) {
      return []
    }

    const pubsub = this.node.services.pubsub as GossipSub | undefined
    if (!pubsub) {
      return []
    }

    const subscribers = pubsub.getSubscribers(topic)
    return subscribers.map(p => p.toString())
  }

  /**
   * Force a health check for all topics
   */
  forceHealthCheck(): GossipSubHealth {
    return this.getOverallHealth()
  }

  /**
   * Get diagnostic information for debugging
   */
  getDiagnostics(): {
    isEnabled: boolean
    nodeStarted: boolean
    subscribedTopics: string[]
    connectedPeers: number
    meshHealth: GossipSubHealth
  } {
    const isEnabled = !!this.node?.services.pubsub
    const nodeStarted = !!this.node

    let subscribedTopics: string[] = []
    let connectedPeers = 0

    if (this.node) {
      const pubsub = this.node.services.pubsub as GossipSub | undefined
      if (pubsub) {
        subscribedTopics = pubsub.getTopics()
      }
      connectedPeers = this.node.getPeers().length
    }

    return {
      isEnabled,
      nodeStarted,
      subscribedTopics,
      connectedPeers,
      meshHealth: this.getOverallHealth(),
    }
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Start periodic health checks
   */
  private _startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.getOverallHealth()
    }, this.config.healthCheckInterval)
  }

  /**
   * Get mesh peers count for a topic
   */
  private _getMeshPeersCount(pubsub: GossipSub, topic: string): number {
    try {
      // GossipSub mesh is a subset of subscribers
      // Use subscribers as an approximation since getMeshPeers is internal
      const subscribers = pubsub.getSubscribers(topic)
      return subscribers.length
    } catch {
      return 0
    }
  }

  /**
   * Get fanout peers count for a topic
   *
   * Fanout peers are used when we're not subscribed to a topic
   * but still want to publish to it
   */
  private _getFanoutPeersCount(pubsub: GossipSub, topic: string): number {
    // GossipSub doesn't expose fanout directly in the public API
    // Fanout is used for topics we publish to but aren't subscribed to
    // Return 0 as we can't accurately measure this
    try {
      // Fanout is internal to GossipSub implementation
      return 0
    } catch {
      return 0
    }
  }
}
