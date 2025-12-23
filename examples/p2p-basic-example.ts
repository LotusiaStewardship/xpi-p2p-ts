/**
 * Basic P2P Example with libp2p
 *
 * Demonstrates core P2P functionality using libp2p
 */

import {
  P2PCoordinator,
  P2PProtocol,
  P2PConfig,
  PeerInfo,
  ConnectionEvent,
  waitForEvent,
} from '../lib/index.js'

async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  Basic P2P Example (libp2p)')
  console.log('═══════════════════════════════════════════════════\n')

  // Setup Alice
  const aliceConfig: P2PConfig = {
    listen: ['/ip4/127.0.0.1/tcp/0'], // Random port
    enableDHT: true,
    enableDHTServer: true, // Server mode to announce and serve DHT data
  }

  const alice = new P2PCoordinator(aliceConfig)

  // Setup Bob
  const bobConfig: P2PConfig = {
    listen: ['/ip4/127.0.0.1/tcp/0'], // Random port
    enableDHT: true,
    enableDHTServer: true, // Server mode to query DHT network
  }

  const bob = new P2PCoordinator(bobConfig)

  console.log('Starting peers...')
  await alice.start()
  await bob.start()

  console.log('\nPeers initialized:')
  console.log('  Alice:', alice.peerId)
  console.log('  Bob:', bob.peerId)
  console.log()

  // Setup event listeners
  alice.on(ConnectionEvent.CONNECTED, data => {
    console.log(`Alice: Connected to ${data.peerId}`)
  })

  alice.on(ConnectionEvent.MESSAGE, data => {
    const msg = data.message as Record<string, unknown>
    console.log(`Alice received from ${data.from.peerId}:`, msg.payload)
  })

  bob.on(ConnectionEvent.CONNECTED, data => {
    console.log(`Bob: Connected to ${data.peerId}`)
  })

  bob.on(ConnectionEvent.MESSAGE, data => {
    const msg = data.message as Record<string, unknown>
    console.log(`Bob received from ${data.from.peerId}:`, msg.payload)
  })

  // Connect Alice to Bob
  console.log('Connecting Alice to Bob...')
  const bobAddrs = bob.libp2pNode.getMultiaddrs()
  if (bobAddrs.length > 0) {
    // Wait for both sides to acknowledge connection
    const aliceConnectPromise = waitForEvent<PeerInfo>(
      alice,
      ConnectionEvent.CONNECTED,
    )
    const bobConnectPromise = waitForEvent<PeerInfo>(
      bob,
      ConnectionEvent.CONNECTED,
    )

    await alice.connectToPeer(bobAddrs[0].toString())
    await Promise.all([aliceConnectPromise, bobConnectPromise])

    console.log('✓ Alice and Bob connected (bidirectional)')

    // Wait for DHT routing tables to auto-populate via TopologyListener
    // The identify service exchanges protocols, then TopologyListener adds peers to DHT
    await new Promise(resolve => setTimeout(resolve, 1000))

    console.log('Alice DHT:', alice.getDHTStats())
    console.log('Bob DHT:', bob.getDHTStats())
    console.log()
  }

  // Example 1: Direct messaging
  console.log('Example 1: Direct Messaging')
  console.log('──────────────────────────────────────────────────')
  const protocol = new P2PProtocol()
  const message = protocol.createMessage(
    'greeting',
    { text: 'Hello Bob!' },
    alice.peerId,
  )
  await alice.sendTo(bob.peerId, message)
  console.log('  ✓ Alice sent message to Bob')
  console.log('  ✓ Bob received message (check console output above)\n')

  // Example 2: Resource announcement
  console.log('Example 2: Resource Announcement')
  console.log('──────────────────────────────────────────────────')
  await alice.announceResource(
    'example-resource',
    'resource-123',
    {
      name: 'Example Resource',
      data: 'Some important data',
    },
    {
      ttl: 3600, // 1 hour
    },
  )
  console.log('  ✓ Alice announced resource to DHT\n')

  // Example 3: Resource discovery from DHT network
  console.log('Example 3: Resource Discovery from DHT')
  console.log('──────────────────────────────────────────────────')
  console.log('  Querying DHT network for resource...')
  const resource = await bob.discoverResource(
    'example-resource',
    'resource-123',
    3000,
  )
  console.log('  Query completed')
  if (resource) {
    console.log('  ✓ Bob discovered resource from DHT')
    console.log('    Resource ID:', resource.resourceId)
    console.log('    Creator:', resource.creatorPeerId)
    console.log('    Data:', resource.data)
  } else {
    console.log(
      '  ℹ Resource not found (DHT propagation takes time in small networks)',
    )
  }
  console.log()

  // Example 4: Check connection stats
  console.log('Example 4: Connection Statistics for Alice')
  console.log('──────────────────────────────────────────────────')
  const aliceStats = alice.getStats()
  console.log('    Peer ID:', aliceStats.peerId.substring(0, 20) + '...')
  console.log('    Connected peers:', aliceStats.peers.connected)
  console.log('    DHT enabled:', aliceStats.dht.enabled)
  console.log('    DHT records:', aliceStats.dht.localRecords)
  console.log('    Listening on:', aliceStats.multiaddrs.length, 'addresses')
  console.log()

  // Example 5: Bob Connection Statistics
  console.log('Example 5: Connection Statistics for Bob')
  console.log('──────────────────────────────────────────────────')
  const bobStats = bob.getStats()
  console.log('    Peer ID:', bobStats.peerId.substring(0, 20) + '...')
  console.log('    Connected peers:', bobStats.peers.connected)
  console.log('    DHT enabled:', bobStats.dht.enabled)
  console.log('    DHT records:', bobStats.dht.localRecords)
  console.log('    Listening on:', bobStats.multiaddrs.length, 'addresses')
  console.log()

  // Cleanup
  console.log('Cleaning up...')
  await alice.stop()
  await bob.stop()
  console.log('Done!\n')

  console.log('═══════════════════════════════════════════════════')
  console.log('  libp2p Integration Complete!')
  console.log('═══════════════════════════════════════════════════')
}

main().catch(console.error)
