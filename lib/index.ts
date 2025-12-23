/**
 * P2P Coordination Layer
 *
 * Generic peer-to-peer networking infrastructure using libp2p
 */

// Main coordinator
export { P2PCoordinator } from './coordinator.js'

// Core types (includes libp2p re-exports)
export * from './types.js'

// Event types for strongly-typed event handling
export * from './events.js'

// Protocol and messaging
export { P2PProtocol } from './protocol.js'

// Core security (protocol-agnostic)
export * from './security.js'

// Phase 1: Bootstrap Manager (automatic reconnection)
export { BootstrapManager, BOOTSTRAP_PROTOCOL } from './bootstrap-manager.js'

// Phase 1: DHT Announcement Queue (deferred propagation)
export {
  DHTAnnouncementQueue,
  type QueuedAnnouncement,
  type DHTQueueConfig,
} from './dht-queue.js'

// Phase 1: GossipSub Monitor (mesh health)
export {
  GossipSubMonitor,
  type TopicMeshHealth,
  type GossipSubHealth,
  type GossipSubMonitorConfig,
} from './gossipsub-monitor.js'

// Utilities
export {
  createPeerIdFromPrivateKey,
  createRandomPeerId,
  parsePeerId,
  serializePeerId,
  parseMultiaddrs,
  waitForEvent,
  // P2P Identity Management
  generateP2PPrivateKey,
  restoreP2PPrivateKey,
  getP2PPrivateKeyBytes,
} from './utils.js'

// Re-export DHT mapper functions for convenience
export {
  passthroughMapper,
  removePrivateAddressesMapper,
  removePublicAddressesMapper,
} from '@libp2p/kad-dht'

// MuSig2 P2P coordination
export * from './musig2/index.js'

// SwapSig protocol
//export * from './swapsig/index.js'
