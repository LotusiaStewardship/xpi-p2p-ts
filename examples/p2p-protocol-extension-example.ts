/**
 * Protocol Extension Example with libp2p
 *
 * Shows how to extend the P2P infrastructure for custom protocols
 */

import {
  P2PCoordinator,
  P2PMessage,
  PeerInfo,
  IProtocolHandler,
  ConnectionEvent,
  Stream,
  Connection,
  waitForEvent,
} from '../lib/index.js'

/**
 * Example: Custom Chat Protocol
 *
 * This demonstrates how any protocol can extend the P2P infrastructure
 * The same pattern would be used for MuSig2, CoinJoin, etc.
 */
class ChatProtocolHandler implements IProtocolHandler {
  readonly protocolName = 'chat'
  readonly protocolId = '/lotus/chat/1.0.0'

  private chatRooms: Map<string, Set<string>> = new Map()

  constructor(private coordinator: P2PCoordinator) {}

  /**
   * Handle incoming messages
   */
  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    console.log(`[Chat] Message from ${from.peerId}:`, message.payload)

    switch (message.type) {
      case 'chat-message':
        this._handleChatMessage(message, from)
        break

      case 'chat-join-room':
        this._handleJoinRoom(message, from)
        break

      case 'chat-leave-room':
        this._handleLeaveRoom(message, from)
        break

      default:
        console.warn(`Unknown chat message type: ${message.type}`)
    }
  }

  /**
   * Handle incoming stream (libp2p native)
   */
  async handleStream(stream: Stream, connection: Connection): Promise<void> {
    console.log(`[Chat] Stream from ${connection.remotePeer.toString()}`)

    try {
      const data: Uint8Array[] = []

      // Stream is AsyncIterable - iterate directly
      for await (const chunk of stream) {
        if (chunk instanceof Uint8Array) {
          data.push(chunk.subarray())
        } else {
          // Handle Uint8ArrayList
          data.push(chunk.subarray())
        }
      }

      const combined = Buffer.concat(data.map(d => Buffer.from(d)))
      const messageStr = combined.toString('utf8')
      const message = JSON.parse(messageStr) as P2PMessage

      await this.handleMessage(message, {
        peerId: connection.remotePeer.toString(),
        lastSeen: Date.now(),
      })
    } catch (error) {
      console.error('[Chat] Error handling stream:', error)
    }
  }

  /**
   * Handle peer discovery (before connection)
   * Called when bootstrap nodes discover peers
   */
  async onPeerDiscovered(peerInfo: PeerInfo): Promise<void> {
    console.log(
      `[Chat] Peer discovered: ${peerInfo.peerId.substring(0, 12)}...`,
    )
    console.log(
      `       Multiaddrs: ${peerInfo.multiaddrs?.length || 0} addresses`,
    )
    // Protocol can react to discovery (e.g., check if peer supports chat)
    // Bootstrap module will automatically attempt to connect
  }

  /**
   * Handle peer connection (after successful connection)
   */
  async onPeerConnected(peerId: string): Promise<void> {
    console.log(`[Chat] New peer connected: ${peerId.substring(0, 12)}...`)
    console.log(`       Ready for chat protocol operations`)
  }

  /**
   * Handle peer disconnection
   */
  async onPeerDisconnected(peerId: string): Promise<void> {
    console.log(`[Chat] Peer disconnected: ${peerId.substring(0, 12)}...`)
    // Remove from all chat rooms
    for (const members of this.chatRooms.values()) {
      members.delete(peerId)
    }
  }

  /**
   * Send chat message
   */
  async sendMessage(roomId: string, text: string): Promise<void> {
    const message: P2PMessage = {
      type: 'chat-message',
      from: this.coordinator.peerId,
      payload: {
        roomId,
        text,
      },
      timestamp: Date.now(),
      messageId: this._generateId(),
      protocol: 'chat',
    }

    await this.coordinator.broadcast(message)
  }

  /**
   * Join chat room
   */
  async joinRoom(roomId: string): Promise<void> {
    const message: P2PMessage = {
      type: 'chat-join-room',
      from: this.coordinator.peerId,
      payload: { roomId },
      timestamp: Date.now(),
      messageId: this._generateId(),
      protocol: 'chat',
    }

    await this.coordinator.broadcast(message)
  }

  private _handleChatMessage(message: P2PMessage, from: PeerInfo): void {
    const payload = message.payload as Record<string, string>
    const { roomId, text } = payload
    console.log(`[Room ${roomId}] ${from.peerId.substring(0, 12)}...: ${text}`)
  }

  private _handleJoinRoom(message: P2PMessage, from: PeerInfo): void {
    const payload = message.payload as Record<string, string>
    const { roomId } = payload
    if (!this.chatRooms.has(roomId)) {
      this.chatRooms.set(roomId, new Set())
    }
    this.chatRooms.get(roomId)!.add(from.peerId)
    console.log(
      `[Chat] ${from.peerId.substring(0, 12)}... joined room ${roomId}`,
    )
  }

  private _handleLeaveRoom(message: P2PMessage, from: PeerInfo): void {
    const payload = message.payload as Record<string, string>
    const { roomId } = payload
    const room = this.chatRooms.get(roomId)
    if (room) {
      room.delete(from.peerId)
    }
    console.log(`[Chat] ${from.peerId.substring(0, 12)}... left room ${roomId}`)
  }

  private _generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2)
  }
}

/**
 * Main demo
 */
async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  P2P Protocol Extension Example (libp2p)')
  console.log('  (Custom Chat Protocol)')
  console.log('═══════════════════════════════════════════════════\n')

  // Initialize coordinators
  const alice = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    enableDHT: true,
    enableDHTServer: false, // Client mode for clean exit
  })

  const bob = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    enableDHT: true,
    enableDHTServer: false, // Client mode for clean exit
  })

  console.log('Starting nodes...')
  await alice.start()
  await bob.start()

  console.log('✓ Initialized P2P coordinators')
  console.log('  Alice:', alice.peerId.substring(0, 20) + '...')
  console.log('  Bob:', bob.peerId.substring(0, 20) + '...')
  console.log()

  // Create and register chat protocol handlers
  const aliceChat = new ChatProtocolHandler(alice)
  const bobChat = new ChatProtocolHandler(bob)

  alice.registerProtocol(aliceChat)
  bob.registerProtocol(bobChat)

  console.log('✓ Registered chat protocol handlers\n')

  // Connect peers - wait for bidirectional connection
  const bobAddrs = bob.libp2pNode.getMultiaddrs()
  if (bobAddrs.length > 0) {
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

    console.log('✓ Peers connected (bidirectional)\n')
  }

  console.log('Protocol Extension Pattern:')
  console.log('──────────────────────────────────────────────────')
  console.log('1. Implement IProtocolHandler with protocolId')
  console.log('2. Register with P2PCoordinator')
  console.log('3. libp2p handles transport, DHT, discovery')
  console.log('4. Your protocol focuses on business logic\n')

  console.log('This same pattern would be used for:')
  console.log('  • MuSig2 session coordination')
  console.log('  • CoinJoin round management')
  console.log('  • Any other P2P protocol\n')

  // Show stats
  const stats = alice.getStats()
  console.log('P2P Stats (Alice):')
  console.log('  Peer ID:', stats.peerId.substring(0, 30) + '...')
  console.log('  Connected peers:', stats.peers.connected)
  console.log('  DHT enabled:', stats.dht.enabled)
  console.log('  Local DHT records:', stats.dht.localRecords)
  console.log('  Multiaddrs:', stats.multiaddrs.length)
  console.log()

  // Cleanup
  await alice.stop()
  await bob.stop()

  console.log('═══════════════════════════════════════════════════')
  console.log('  Example Complete!')
  console.log('═══════════════════════════════════════════════════')
}

main().catch(console.error)
