/**
 * Peer Discovery Example with Bootstrap Nodes
 *
 * Demonstrates how the P2P layer handles peer discovery through bootstrap nodes
 * and notifies protocol handlers universally (not specific to any protocol)
 */

import {
  P2PCoordinator,
  P2PMessage,
  PeerInfo,
  IProtocolHandler,
  ConnectionEvent,
} from '../lib/index.js'

/**
 * Example Protocol Handler that reacts to peer discovery
 * This could be any protocol (MuSig2, CoinJoin, etc.)
 */
class DiscoveryAwareProtocolHandler implements IProtocolHandler {
  readonly protocolName = 'discovery-demo'
  readonly protocolId = '/lotus/discovery-demo/1.0.0'

  private discoveredPeers: Set<string> = new Set()
  private connectedPeers: Set<string> = new Set()

  constructor(
    private coordinator: P2PCoordinator,
    private name: string,
  ) {}

  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    // Handle protocol messages
    console.log(
      `[${this.name}] Received message from ${from.peerId.substring(0, 12)}...`,
    )
  }

  /**
   * Peer Discovery Handler
   * Called when bootstrap nodes or DHT discover peers
   * This happens BEFORE connection is established
   */
  async onPeerDiscovered(peerInfo: PeerInfo): Promise<void> {
    this.discoveredPeers.add(peerInfo.peerId)

    console.log(`\n🔍 [${this.name}] PEER DISCOVERED:`)
    console.log(`   Peer ID: ${peerInfo.peerId.substring(0, 20)}...`)
    console.log(`   Multiaddrs: ${peerInfo.multiaddrs?.length || 0}`)
    if (peerInfo.multiaddrs && peerInfo.multiaddrs.length > 0) {
      peerInfo.multiaddrs.forEach(addr => {
        console.log(`      - ${addr}`)
      })
    }
    console.log(
      `   Total discovered: ${this.discoveredPeers.size} peers (not yet connected)`,
    )

    // Protocol-specific logic could be added here:
    // - Check if peer advertises required services
    // - Decide whether to attempt connection
    // - Store peer info for later use
  }

  /**
   * Peer Connection Handler
   * Called AFTER successful connection establishment
   */
  async onPeerConnected(peerId: string): Promise<void> {
    this.connectedPeers.add(peerId)

    console.log(`\n✅ [${this.name}] PEER CONNECTED:`)
    console.log(`   Peer ID: ${peerId.substring(0, 20)}...`)
    console.log(
      `   Total connected: ${this.connectedPeers.size} peers (ready for protocol operations)`,
    )

    // At this point, the peer is ready for protocol operations
    // - Can send messages
    // - Can open streams
    // - Can participate in protocol sessions
  }

  /**
   * Peer Disconnection Handler
   */
  async onPeerDisconnected(peerId: string): Promise<void> {
    this.connectedPeers.delete(peerId)

    console.log(`\n❌ [${this.name}] PEER DISCONNECTED:`)
    console.log(`   Peer ID: ${peerId.substring(0, 20)}...`)
    console.log(`   Remaining connected: ${this.connectedPeers.size} peers`)

    // Clean up protocol-specific state for this peer
  }

  getStats() {
    return {
      discovered: this.discoveredPeers.size,
      connected: this.connectedPeers.size,
    }
  }
}

/**
 * Main demonstration
 */
async function main() {
  console.log('═════════════════════════════════════════════════════════')
  console.log('  Peer Discovery Example with Bootstrap Nodes')
  console.log('═════════════════════════════════════════════════════════\n')

  console.log('This example demonstrates:')
  console.log('  1. Bootstrap node discovery (libp2p built-in)')
  console.log('  2. Universal peer discovery event handling')
  console.log('  3. Protocol handler notifications')
  console.log('  4. Discovery → Connection → Protocol Operations flow\n')

  // Create a bootstrap node (acts as discovery hub)
  console.log('📡 Setting up bootstrap node...')
  const bootstrap = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/9000'],
    enableDHT: true,
    enableDHTServer: true, // Server mode for bootstrap
    enableRelayServer: true, // Act as relay for NAT peers
  })

  await bootstrap.start()
  const bootstrapAddr = bootstrap.libp2pNode.getMultiaddrs()[0].toString()
  console.log('✓ Bootstrap node started')
  console.log(`  Peer ID: ${bootstrap.peerId.substring(0, 20)}...`)
  console.log(`  Address: ${bootstrapAddr}\n`)

  // Create client nodes that will discover each other via bootstrap
  console.log('👤 Setting up client nodes...')

  const alice = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    bootstrapPeers: [bootstrapAddr], // Connect to bootstrap
    enableDHT: true,
    enableDHTServer: false, // Client mode
  })

  const bob = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    bootstrapPeers: [bootstrapAddr], // Connect to bootstrap
    enableDHT: true,
    enableDHTServer: false, // Client mode
  })

  // Register protocol handlers (will receive discovery events)
  const aliceProtocol = new DiscoveryAwareProtocolHandler(alice, 'Alice')
  const bobProtocol = new DiscoveryAwareProtocolHandler(bob, 'Bob')

  alice.registerProtocol(aliceProtocol)
  bob.registerProtocol(bobProtocol)

  await alice.start()
  await bob.start()

  console.log('✓ Client nodes started')
  console.log(`  Alice: ${alice.peerId.substring(0, 20)}...`)
  console.log(`  Bob: ${bob.peerId.substring(0, 20)}...\n`)

  console.log('🔗 Discovery Process:')
  console.log('─────────────────────────────────────────────────────────')
  console.log('Alice and Bob will:')
  console.log('  1. Connect to bootstrap node (automatic)')
  console.log('  2. Discover each other via bootstrap (automatic)')
  console.log('  3. Receive onPeerDiscovered notifications')
  console.log('  4. Bootstrap attempts to establish connections')
  console.log('  5. Receive onPeerConnected notifications')
  console.log('  6. Ready for protocol operations\n')

  // Wait for discovery and connections to happen
  console.log('⏳ Waiting for peer discovery and connections...\n')

  // Listen to coordinator-level events
  alice.on(ConnectionEvent.DISCOVERED, data => {
    console.log(
      `[Coordinator] Alice discovered peer: ${data.peerInfo.peerId.substring(0, 12)}...`,
    )
  })

  bob.on(ConnectionEvent.DISCOVERED, data => {
    console.log(
      `[Coordinator] Bob discovered peer: ${data.peerInfo.peerId.substring(0, 12)}...`,
    )
  })

  // Wait for connections to establish
  await new Promise(resolve => setTimeout(resolve, 3000))

  // Show final stats
  console.log('\n═════════════════════════════════════════════════════════')
  console.log('  Final Statistics')
  console.log('═════════════════════════════════════════════════════════\n')

  const aliceStats = alice.getStats()
  const bobStats = bob.getStats()
  const aliceProtocolStats = aliceProtocol.getStats()
  const bobProtocolStats = bobProtocol.getStats()

  console.log('Alice:')
  console.log(`  Coordinator: ${aliceStats.peers.connected} connected peers`)
  console.log(
    `  Protocol: ${aliceProtocolStats.discovered} discovered, ${aliceProtocolStats.connected} connected`,
  )
  console.log()

  console.log('Bob:')
  console.log(`  Coordinator: ${bobStats.peers.connected} connected peers`)
  console.log(
    `  Protocol: ${bobProtocolStats.discovered} discovered, ${bobProtocolStats.connected} connected`,
  )
  console.log()

  console.log('Key Insights:')
  console.log('─────────────────────────────────────────────────────────')
  console.log('✓ Peer discovery events are handled universally at P2P layer')
  console.log('✓ Protocol handlers are notified automatically')
  console.log('✓ Works with any protocol (MuSig2, CoinJoin, etc.)')
  console.log('✓ Bootstrap nodes enable decentralized peer discovery')
  console.log('✓ Clients can find each other without hardcoded addresses\n')

  console.log('Real-world Usage:')
  console.log('  • Wallet UX discovers MuSig2 signers via bootstrap')
  console.log('  • CoinJoin clients discover round coordinators')
  console.log('  • Protocol handlers react to discovery events')
  console.log('  • Bootstrap network enables decentralized discovery\n')

  // Cleanup
  await alice.stop()
  await bob.stop()
  await bootstrap.stop()

  console.log('═════════════════════════════════════════════════════════')
  console.log('  Example Complete!')
  console.log('═════════════════════════════════════════════════════════')
}

main().catch(console.error)
