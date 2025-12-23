/**
 * P2P Event Type Definitions
 *
 * Provides strongly-typed event maps for P2P coordinators.
 * These types ensure event handlers receive correctly typed data.
 *
 * Usage in consumers (e.g., wallet UI):
 * ```typescript
 * import { P2PEventMap, ConnectionEvent } from 'lotus-sdk/p2p'
 *
 * coordinator.on(ConnectionEvent.CONNECTED, (data: P2PEventMap[ConnectionEvent.CONNECTED]) => {
 *   console.log('Peer connected:', data.peerId)
 * })
 * ```
 */

import type {
  PeerInfo,
  ConnectionStateChangeData,
  ResourceAnnouncement,
} from './types.js'
import { ConnectionEvent, RelayEvent, BootstrapEvent } from './types.js'

// ============================================================================
// Core P2P Events
// ============================================================================

/**
 * Data emitted when a peer connects
 */
export interface PeerConnectedEventData {
  /** The peer ID that connected */
  peerId: string
  /** Multiaddresses of the peer */
  multiaddrs: string[]
  /** Timestamp of connection */
  timestamp: number
}

/**
 * Data emitted when a peer disconnects
 */
export interface PeerDisconnectedEventData {
  /** The peer ID that disconnected */
  peerId: string
  /** Timestamp of disconnection */
  timestamp: number
}

/**
 * Data emitted when a peer is discovered
 */
export interface PeerDiscoveredEventData {
  /** Peer information */
  peerInfo: PeerInfo
  /** Timestamp of discovery */
  timestamp: number
}

/**
 * Data emitted when relay addresses become available
 */
export interface RelayAddressesEventData {
  /** The local peer ID */
  peerId: string
  /** All reachable addresses (including relay) */
  reachableAddresses: string[]
  /** Relay-specific addresses */
  relayAddresses: string[]
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted on P2P errors
 */
export interface P2PErrorEventData {
  /** Error message */
  message: string
  /** Error code (if available) */
  code?: string
  /** Original error */
  error?: Error
  /** Timestamp */
  timestamp: number
}

/**
 * Bootstrap event data types
 */
export interface BootstrapConnectedEventData {
  peerId: string
  multiaddr: string
}

export interface BootstrapDisconnectedEventData {
  peerId: string
  reason?: string
}

export interface BootstrapReconnectingEventData {
  peerId: string
  attempt: number
  delay: number
}

export interface BootstrapFailedEventData {
  peerId: string
  error: string
  attempts: number
}

/**
 * Core P2P Event Map
 * Maps event names to their argument tuples (for Node.js EventEmitter compatibility)
 */
export type P2PEventMap = {
  'peer:connect': [PeerConnectedEventData]
  'peer:disconnect': [PeerDisconnectedEventData]
  'peer:discovery': [PeerDiscoveredEventData]
  'peer:update': [PeerInfo]
  'error': [P2PErrorEventData]
  'message': [{ message: unknown; from: PeerInfo }]
  'connection:state-changed': [ConnectionStateChangeData]
  'relay:addresses-available': [RelayAddressesEventData]
  'relay:connected': [{ peerId: string; timestamp: number }]
  'relay:disconnected': [{ peerId: string; timestamp: number }]
  'resource:announced': [ResourceAnnouncement]
  // Phase 1: Bootstrap Manager events
  'bootstrap:connected': [BootstrapConnectedEventData]
  'bootstrap:disconnected': [BootstrapDisconnectedEventData]
  'bootstrap:reconnecting': [BootstrapReconnectingEventData]
  'bootstrap:failed': [BootstrapFailedEventData]
  'bootstrap:all-connected': [undefined]
  'bootstrap:all-disconnected': [undefined]
}

// ============================================================================
// DHT Events
// ============================================================================

/**
 * Data emitted when DHT becomes ready
 */
export interface DHTReadyEventData {
  /** Number of peers in routing table */
  routingTableSize: number
  /** DHT mode */
  mode: 'client' | 'server'
  /** Timestamp */
  timestamp: number
}

/**
 * DHT Event Map
 * Maps event names to their argument tuples (for Node.js EventEmitter compatibility)
 */
export interface DHTEventMap {
  'dht:ready': [DHTReadyEventData]
  'dht:peer-added': [{ peerId: string; timestamp: number }]
  'dht:peer-removed': [{ peerId: string; timestamp: number }]
}
