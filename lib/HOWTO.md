# P2P Core Layer Developer Guide

A comprehensive guide for building applications with the P2P coordination layer.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Understanding the Architecture](#understanding-the-architecture)
3. [Connecting to Peers](#connecting-to-peers)
4. [Sending and Receiving Messages](#sending-and-receiving-messages)
5. [Using GossipSub Pub/Sub](#using-gossipsub-pubsub)
6. [DHT Resource Management](#dht-resource-management)
7. [NAT Traversal](#nat-traversal)
8. [Building Custom Protocols](#building-custom-protocols)
9. [Security Best Practices](#security-best-practices)
10. [Error Handling](#error-handling)
11. [Advanced Patterns](#advanced-patterns)

---

## Getting Started

### Installation

The P2P module is part of the Lotus SDK:

```typescript
import {
  P2PCoordinator,
  P2PProtocol,
  ConnectionEvent,
  PeerInfo,
  P2PMessage,
} from 'lotus-sdk/lib/p2p'
```

### Requirements

- **Node.js >= 22.0.0** (required for libp2p 3.x)
- Network access for P2P communication

### Basic Setup

```typescript
import { P2PCoordinator } from 'lotus-sdk/lib/p2p'

// 1. Create the coordinator with minimal config
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'], // Listen on any available port
  enableDHT: true,
  enableGossipSub: true,
})

// 2. Start the coordinator
await coordinator.start()
console.log('P2P node started!')
console.log('Peer ID:', coordinator.peerId)
console.log('Addresses:', coordinator.getStats().multiaddrs)

// 3. When done, stop gracefully
await coordinator.stop()
```

---

## Understanding the Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  Your Application                           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   P2PCoordinator                            │
│  • Manages libp2p node lifecycle                            │
│  • Routes messages to protocol handlers                     │
│  • Provides GossipSub pub/sub                               │
│  • Manages DHT resources                                    │
│  • Handles NAT traversal                                    │
└─────────────────────────────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Protocol        │ │ Security        │ │ Blockchain      │
│ Handlers        │ │ Manager         │ │ Utilities       │
│                 │ │                 │ │                 │
│ Custom protocol │ │ Rate limiting   │ │ Burn verifier   │
│ implementations │ │ Peer banning    │ │ TX monitor      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Message Flow

1. **Direct P2P** - Point-to-point messages via `sendTo()`
2. **Broadcast** - Send to all connected peers via `broadcast()`
3. **GossipSub** - Pub/sub messaging via `publishToTopic()`
4. **DHT** - Resource discovery via `announceResource()` / `discoverResources()`

### Event System

The coordinator emits events for peer lifecycle and messages:

```typescript
// Peer events
coordinator.on(ConnectionEvent.CONNECTED, (peer: PeerInfo) => {
  console.log('Peer connected:', peer.peerId)
})

coordinator.on(ConnectionEvent.DISCONNECTED, (peer: PeerInfo) => {
  console.log('Peer disconnected:', peer.peerId)
})

coordinator.on(ConnectionEvent.DISCOVERED, (peer: PeerInfo) => {
  console.log('Peer discovered:', peer.peerId)
})

// Message events
coordinator.on(
  ConnectionEvent.MESSAGE,
  (message: P2PMessage, from: PeerInfo) => {
    console.log(`Message from ${from.peerId}:`, message.type)
  },
)
```

---

## Connecting to Peers

### Connect to a Known Peer

```typescript
// Connect using multiaddr (includes peer ID)
await coordinator.connectToPeer(
  '/ip4/192.168.1.100/tcp/4001/p2p/12D3KooWExample...',
)

// Connect to DNS address
await coordinator.connectToPeer(
  '/dns4/peer.example.com/tcp/4001/p2p/12D3KooWExample...',
)

// Connect via WebSocket
await coordinator.connectToPeer(
  '/ip4/192.168.1.100/tcp/4002/ws/p2p/12D3KooWExample...',
)
```

### Using Bootstrap Peers

Bootstrap peers are automatically connected on startup:

```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
  bootstrapPeers: [
    '/dns4/bootstrap1.lotusia.org/tcp/4001/p2p/12D3KooW...',
    '/dns4/bootstrap2.lotusia.org/tcp/4001/p2p/12D3KooW...',
  ],
})

await coordinator.start()
// Bootstrap peers are automatically connected
```

### Managing Connections

```typescript
// Check if connected to a peer
const isConnected = coordinator.isConnected('12D3KooWExample...')

// Get all connected peers
const peers = coordinator.getConnectedPeers()
console.log(`Connected to ${peers.length} peers`)

// Get info about a specific peer
const peerInfo = coordinator.getPeer('12D3KooWExample...')
if (peerInfo) {
  console.log('Last seen:', peerInfo.lastSeen)
}

// Disconnect from a peer
await coordinator.disconnectFromPeer('12D3KooWExample...')
```

### Waiting for Connection Events

```typescript
import { waitForEvent } from 'lotus-sdk/lib/p2p'

// Wait for a specific peer to connect
const connectedPeer = await waitForEvent<PeerInfo>(
  coordinator,
  ConnectionEvent.CONNECTED,
  10000, // 10 second timeout
)
console.log('Connected to:', connectedPeer.peerId)
```

---

## Sending and Receiving Messages

### Creating Messages

```typescript
import { P2PProtocol } from 'lotus-sdk/lib/p2p'

const protocol = new P2PProtocol()

// Create a message
const message = protocol.createMessage(
  'my-message-type', // Message type
  { data: 'Hello, World!' }, // Payload (any serializable object)
  coordinator.peerId, // From (your peer ID)
)

console.log('Message ID:', message.messageId)
console.log('Timestamp:', message.timestamp)
```

### Sending to a Specific Peer

```typescript
// Send to a specific peer
await coordinator.sendTo('12D3KooWTargetPeer...', message)
```

### Broadcasting to All Peers

```typescript
// Broadcast to all connected peers
await coordinator.broadcast(message)

// Broadcast with exclusions
await coordinator.broadcast(message, {
  exclude: ['12D3KooWExcludedPeer...'],
})

// Broadcast to specific peers only
await coordinator.broadcast(message, {
  includedOnly: ['12D3KooWPeer1...', '12D3KooWPeer2...'],
})
```

### Receiving Messages

```typescript
// Listen for all messages
coordinator.on(ConnectionEvent.MESSAGE, (message, from) => {
  console.log(`Received ${message.type} from ${from.peerId}`)
  console.log('Payload:', message.payload)

  // Handle different message types
  switch (message.type) {
    case 'greeting':
      handleGreeting(message.payload, from)
      break
    case 'data-request':
      handleDataRequest(message.payload, from)
      break
  }
})
```

---

## Using GossipSub Pub/Sub

GossipSub provides efficient pub/sub messaging across the network.

### Subscribing to Topics

```typescript
// Subscribe to a topic
await coordinator.subscribeToTopic('my-topic', (data: Uint8Array) => {
  // Decode the message
  const message = JSON.parse(new TextDecoder().decode(data))
  console.log('Received on my-topic:', message)
})

// Subscribe to multiple topics
await coordinator.subscribeToTopic('announcements', handleAnnouncement)
await coordinator.subscribeToTopic('updates', handleUpdate)
```

### Publishing to Topics

```typescript
// Publish a message to a topic
await coordinator.publishToTopic('my-topic', {
  type: 'announcement',
  content: 'Hello, subscribers!',
  timestamp: Date.now(),
})

// Publish complex data
await coordinator.publishToTopic('data-feed', {
  prices: [100, 200, 300],
  source: 'my-node',
})
```

### Managing Subscriptions

```typescript
// Get peers subscribed to a topic
const subscribers = coordinator.getTopicPeers('my-topic')
console.log(`${subscribers.length} peers subscribed to my-topic`)

// Unsubscribe from a topic
await coordinator.unsubscribeFromTopic('my-topic')
```

### GossipSub Best Practices

1. **Wait for subscription propagation** (~500ms) before publishing
2. **Use unique topic names** to avoid collisions
3. **Keep messages small** - GossipSub is for coordination, not bulk data
4. **Unsubscribe when done** to prevent memory leaks

```typescript
// Example: Proper subscription lifecycle
async function setupTopicSubscription(topic: string) {
  await coordinator.subscribeToTopic(topic, handleMessage)

  // Wait for subscription to propagate
  await new Promise(resolve => setTimeout(resolve, 500))

  // Now safe to publish
  await coordinator.publishToTopic(topic, { ready: true })
}

// Cleanup when done
async function cleanup(topic: string) {
  await coordinator.unsubscribeFromTopic(topic)
}
```

---

## DHT Resource Management

The DHT (Distributed Hash Table) enables decentralized resource discovery.

### Announcing Resources

```typescript
// Announce a resource to the network
await coordinator.announceResource(
  'session', // Resource type
  'session-123', // Resource ID
  {
    // Resource data
    creator: coordinator.peerId,
    participants: ['alice', 'bob'],
    status: 'active',
  },
  {
    ttl: 3600, // Time-to-live in seconds
    expiresAt: Date.now() + 3600000, // Explicit expiration
  },
)
```

### Discovering Resources

```typescript
// Discover all resources of a type
const sessions = await coordinator.discoverResources('session')
console.log(`Found ${sessions.length} sessions`)

// Discover with filters
const activeSessions = await coordinator.discoverResources('session', {
  status: 'active',
})
```

### Local Resource Cache

```typescript
// Get a specific resource from local cache
const resource = coordinator.getResource('session', 'session-123')
if (resource) {
  console.log('Found locally:', resource.data)
}

// Get all local resources of a type
const localSessions = coordinator.getLocalResources('session')

// Get with filter
const myLocalSessions = coordinator.getLocalResources('session', {
  creator: coordinator.peerId,
})
```

### Resource Lifecycle

```typescript
// Resources automatically expire based on TTL
// Run cleanup to remove expired resources
coordinator.cleanup()

// Check DHT statistics
const dhtStats = coordinator.getDHTStats()
console.log('DHT mode:', dhtStats.mode)
console.log('Routing table size:', dhtStats.routingTableSize)
console.log('Is ready:', dhtStats.isReady)
```

---

## NAT Traversal

The P2P layer handles NAT traversal automatically, but you can monitor and control it.

### Understanding NAT Traversal

```
┌─────────────────────────────────────────────────────────────┐
│                    NAT Traversal Flow                        │
├─────────────────────────────────────────────────────────────┤
│  1. AutoNAT detects if you're behind NAT                    │
│  2. Connect to relay nodes (bootstrap peers)                │
│  3. Advertise relay addresses to other peers                │
│  4. DCUTR attempts to upgrade relay → direct connection     │
│  5. If DCUTR succeeds, relay connection is dropped          │
└─────────────────────────────────────────────────────────────┘
```

### Checking NAT Status

```typescript
// Check if relay addresses are available
const hasRelay = await coordinator.hasRelayAddresses()
console.log('Has relay addresses:', hasRelay)

// Get relay addresses
const relayAddrs = await coordinator.getRelayAddresses()
console.log('Relay addresses:', relayAddrs)

// Get all reachable addresses (prioritizes relay for NAT)
const reachable = await coordinator.getReachableAddresses()
console.log('Reachable addresses:', reachable)
```

### Listening for Relay Changes

```typescript
coordinator.on('relay:addresses-changed', data => {
  console.log('Relay addresses changed!')
  console.log('Peer ID:', data.peerId)
  console.log('Reachable:', data.reachableAddresses)
  console.log('Relay:', data.relayAddresses)
})
```

### NAT Configuration

```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],

  // NAT traversal options
  enableRelay: true, // Enable circuit relay transport
  enableAutoNAT: true, // Enable NAT detection
  enableDCUTR: true, // Enable hole punching
  enableUPnP: false, // UPnP disabled by default (security)

  // For relay servers only
  enableRelayServer: false,
})
```

---

## Building Custom Protocols

### Implementing IProtocolHandler

```typescript
import {
  IProtocolHandler,
  P2PMessage,
  PeerInfo,
  Stream,
  Connection,
} from 'lotus-sdk/lib/p2p'

class MyCustomProtocol implements IProtocolHandler {
  readonly protocolName = 'my-protocol'
  readonly protocolId = '/lotus/my-protocol/1.0.0'

  private coordinator: P2PCoordinator

  constructor(coordinator: P2PCoordinator) {
    this.coordinator = coordinator
  }

  // Required: Handle incoming messages
  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    console.log(`[${this.protocolName}] Message from ${from.peerId}`)

    switch (message.type) {
      case 'request':
        await this.handleRequest(message.payload, from)
        break
      case 'response':
        await this.handleResponse(message.payload, from)
        break
      default:
        console.warn('Unknown message type:', message.type)
    }
  }

  // Optional: Handle raw libp2p streams
  async handleStream(stream: Stream, connection: Connection): Promise<void> {
    // For advanced use cases requiring raw stream access
  }

  // Optional: Lifecycle hooks
  async onPeerConnected(peerId: string): Promise<void> {
    console.log(`[${this.protocolName}] Peer connected: ${peerId}`)
  }

  async onPeerDisconnected(peerId: string): Promise<void> {
    console.log(`[${this.protocolName}] Peer disconnected: ${peerId}`)
  }

  async onPeerDiscovered(peerInfo: PeerInfo): Promise<void> {
    console.log(`[${this.protocolName}] Peer discovered: ${peerInfo.peerId}`)
  }

  // Custom protocol methods
  private async handleRequest(payload: unknown, from: PeerInfo) {
    // Process request and send response
    const response = { result: 'success', data: payload }

    await this.coordinator.sendTo(from.peerId, {
      type: 'response',
      from: this.coordinator.peerId,
      payload: response,
      timestamp: Date.now(),
      messageId: crypto.randomUUID(),
      protocol: this.protocolName,
    })
  }

  private async handleResponse(payload: unknown, from: PeerInfo) {
    console.log('Received response:', payload)
  }
}

// Register the protocol
const myProtocol = new MyCustomProtocol(coordinator)
coordinator.registerProtocol(myProtocol)
```

### Protocol with State Management

```typescript
class StatefulProtocol implements IProtocolHandler {
  readonly protocolName = 'stateful-protocol'
  readonly protocolId = '/lotus/stateful/1.0.0'

  private sessions = new Map<string, SessionState>()
  private peerSessions = new Map<string, Set<string>>()

  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    switch (message.type) {
      case 'session:create':
        this.createSession(message.payload, from)
        break
      case 'session:join':
        this.joinSession(message.payload, from)
        break
      case 'session:leave':
        this.leaveSession(message.payload, from)
        break
    }
  }

  async onPeerDisconnected(peerId: string): Promise<void> {
    // Clean up sessions when peer disconnects
    const sessions = this.peerSessions.get(peerId)
    if (sessions) {
      for (const sessionId of sessions) {
        this.handlePeerLeft(sessionId, peerId)
      }
      this.peerSessions.delete(peerId)
    }
  }

  private createSession(payload: any, from: PeerInfo) {
    const sessionId = payload.sessionId
    this.sessions.set(sessionId, {
      id: sessionId,
      creator: from.peerId,
      participants: new Set([from.peerId]),
      createdAt: Date.now(),
    })
  }

  private joinSession(payload: any, from: PeerInfo) {
    const session = this.sessions.get(payload.sessionId)
    if (session) {
      session.participants.add(from.peerId)

      // Track peer's sessions
      if (!this.peerSessions.has(from.peerId)) {
        this.peerSessions.set(from.peerId, new Set())
      }
      this.peerSessions.get(from.peerId)!.add(payload.sessionId)
    }
  }

  private leaveSession(payload: any, from: PeerInfo) {
    this.handlePeerLeft(payload.sessionId, from.peerId)
  }

  private handlePeerLeft(sessionId: string, peerId: string) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.participants.delete(peerId)
      if (session.participants.size === 0) {
        this.sessions.delete(sessionId)
      }
    }
  }
}
```

---

## Security Best Practices

### 1. Use the Security Manager

```typescript
// Access the security manager
const security = coordinator.getCoreSecurityManager()

// Register custom validators
security.registerValidator({
  validateResourceAnnouncement: async (type, id, data, peerId) => {
    // Validate resource announcements
    if (type === 'session' && !data.creator) {
      return false // Reject invalid sessions
    }
    return true
  },

  validateMessage: async (message, from) => {
    // Validate incoming messages
    if (!message.timestamp || Date.now() - message.timestamp > 300000) {
      return false // Reject messages older than 5 minutes
    }
    return true
  },

  canAnnounceResource: async (type, peerId) => {
    // Check if peer can announce this resource type
    return true
  },
})
```

### 2. Monitor Security Metrics

```typescript
// Get security metrics
const metrics = security.getMetrics()
console.log('Total messages:', metrics.totalMessages)
console.log('Valid messages:', metrics.validMessages)
console.log('Invalid messages:', metrics.invalidMessages)
console.log('Oversized messages:', metrics.oversizedMessages)
console.log('Blocked peers:', metrics.blockedPeers)
```

### 3. Handle Peer Banning

```typescript
// Check if a peer is banned
if (security.isPeerBanned('12D3KooWBadPeer...')) {
  console.log('Peer is banned')
}

// Manually ban a peer
security.banPeer('12D3KooWBadPeer...', 'Malicious behavior')

// Unban a peer (use with caution)
security.unbanPeer('12D3KooWBadPeer...')
```

### 4. Rate Limiting

Rate limiting is enabled by default. Never disable in production:

```typescript
// BAD - Don't do this in production!
const coordinator = new P2PCoordinator({
  securityConfig: {
    disableRateLimiting: true, // DANGEROUS!
  },
})

// GOOD - Use custom limits if needed
const coordinator = new P2PCoordinator({
  securityConfig: {
    customLimits: {
      MIN_DHT_ANNOUNCEMENT_INTERVAL: 60000, // 1 minute
      MAX_DHT_RESOURCES_PER_PEER: 50,
    },
  },
})
```

### 5. Message Validation

```typescript
import { P2PProtocol } from 'lotus-sdk/lib/p2p'

const protocol = new P2PProtocol()

// Validate incoming messages
function handleIncomingMessage(data: Buffer) {
  try {
    const message = protocol.deserialize(data)

    // Validate message structure
    if (!protocol.validateMessage(message)) {
      console.warn('Invalid message structure')
      return
    }

    // Validate message size
    if (!protocol.validateMessageSize(message, 100000)) {
      console.warn('Message too large')
      return
    }

    // Process valid message
    processMessage(message)
  } catch (error) {
    console.error('Failed to deserialize message:', error)
  }
}
```

---

## Error Handling

### Common Errors

```typescript
try {
  await coordinator.connectToPeer(multiaddr)
} catch (error) {
  if (error.message.includes('dial')) {
    console.error('Connection failed - peer unreachable')
  } else if (error.message.includes('timeout')) {
    console.error('Connection timed out')
  } else {
    console.error('Unknown error:', error)
  }
}
```

### Graceful Shutdown

```typescript
// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down...')
  await coordinator.shutdown()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await coordinator.shutdown()
  process.exit(0)
})
```

### Error Events

```typescript
coordinator.on('error', error => {
  console.error('P2P error:', error)
})
```

---

## Advanced Patterns

### Pattern 1: Request-Response

```typescript
class RequestResponseProtocol {
  private pendingRequests = new Map<
    string,
    {
      resolve: (response: any) => void
      reject: (error: Error) => void
      timeout: NodeJS.Timeout
    }
  >()

  async request(peerId: string, data: any, timeoutMs = 30000): Promise<any> {
    const requestId = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Request timeout'))
      }, timeoutMs)

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject, timeout })

      // Send request
      coordinator.sendTo(peerId, {
        type: 'request',
        from: coordinator.peerId,
        payload: { requestId, data },
        timestamp: Date.now(),
        messageId: requestId,
      })
    })
  }

  handleResponse(message: P2PMessage) {
    const { requestId, data } = message.payload as any
    const pending = this.pendingRequests.get(requestId)

    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(requestId)
      pending.resolve(data)
    }
  }
}
```

### Pattern 2: Peer Discovery Service

```typescript
class PeerDiscoveryService {
  private knownPeers = new Map<string, PeerInfo>()

  constructor(private coordinator: P2PCoordinator) {
    this.setupListeners()
  }

  private setupListeners() {
    this.coordinator.on(ConnectionEvent.CONNECTED, peer => {
      this.knownPeers.set(peer.peerId, peer)
      this.announcePresence()
    })

    this.coordinator.on(ConnectionEvent.DISCONNECTED, peer => {
      this.knownPeers.delete(peer.peerId)
    })
  }

  private async announcePresence() {
    await this.coordinator.announceResource(
      'peer',
      this.coordinator.peerId,
      {
        peerId: this.coordinator.peerId,
        capabilities: ['musig2', 'coinjoin'],
        lastSeen: Date.now(),
      },
      { ttl: 300 }, // 5 minutes
    )
  }

  async findPeersWithCapability(capability: string): Promise<PeerInfo[]> {
    const resources = await this.coordinator.discoverResources('peer')
    return resources
      .filter(r => r.data.capabilities?.includes(capability))
      .map(r => ({
        peerId: r.data.peerId,
        lastSeen: r.data.lastSeen,
      }))
  }
}
```

### Pattern 3: Connection Pool Manager

```typescript
class ConnectionPoolManager {
  private targetConnections = 20
  private checkInterval: NodeJS.Timeout | null = null

  constructor(private coordinator: P2PCoordinator) {}

  start() {
    this.checkInterval = setInterval(() => {
      this.maintainConnections()
    }, 30000) // Check every 30 seconds
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
    }
  }

  private async maintainConnections() {
    const currentPeers = this.coordinator.getConnectedPeers()

    if (currentPeers.length < this.targetConnections) {
      // Discover and connect to more peers
      const resources = await this.coordinator.discoverResources('peer')
      const unconnectedPeers = resources.filter(
        r => !currentPeers.some(p => p.peerId === r.data.peerId),
      )

      for (const peer of unconnectedPeers.slice(0, 5)) {
        try {
          // Would need multiaddr from resource data
          // await this.coordinator.connectToPeer(peer.multiaddr)
        } catch (error) {
          console.warn('Failed to connect to peer:', error)
        }
      }
    }
  }
}
```

### Pattern 4: Message Deduplication

```typescript
class MessageDeduplicator {
  private seenMessages = new Set<string>()
  private maxSize = 10000

  isDuplicate(message: P2PMessage): boolean {
    const hash = this.computeHash(message)

    if (this.seenMessages.has(hash)) {
      return true
    }

    this.seenMessages.add(hash)

    // Cleanup old entries
    if (this.seenMessages.size > this.maxSize) {
      const toRemove = Array.from(this.seenMessages).slice(0, 1000)
      toRemove.forEach(h => this.seenMessages.delete(h))
    }

    return false
  }

  private computeHash(message: P2PMessage): string {
    const protocol = new P2PProtocol()
    return protocol.computeMessageHash(message)
  }
}
```

---

## Troubleshooting

### Node.js Version Error

**Issue**: `Promise.withResolvers is not a function`

**Solution**: Upgrade to Node.js 22+

```bash
nvm install 22
nvm use 22
node --version  # Should show v22.x.x
```

### Connection Issues

**Issue**: Cannot connect to peers

**Checklist**:

1. Verify multiaddr format: `/ip4/HOST/tcp/PORT/p2p/PEERID`
2. Check if peer is running
3. Verify firewall allows the port
4. For NAT peers, ensure relay is available

```typescript
// Debug connection
console.log('My addresses:', coordinator.getStats().multiaddrs)
console.log('Connected peers:', coordinator.getConnectedPeers().length)
console.log('Has relay:', await coordinator.hasRelayAddresses())
```

### GossipSub Issues

**Issue**: Messages not being received

**Checklist**:

1. Both peers subscribed to same topic
2. Wait for subscription propagation (~500ms)
3. Peers are connected

```typescript
// Debug GossipSub
const peers = coordinator.getTopicPeers('my-topic')
console.log('Peers on topic:', peers.length)
```

### DHT Issues

**Issue**: Resources not found

**Checklist**:

1. DHT is enabled: `enableDHT: true`
2. Connected to bootstrap peers
3. Wait for DHT propagation

```typescript
// Debug DHT
const stats = coordinator.getDHTStats()
console.log('DHT mode:', stats.mode)
console.log('Routing table:', stats.routingTableSize)
console.log('Is ready:', stats.isReady)
```

---

## Next Steps

- Review the [README.md](./README.md) for API reference
- Check [MuSig2 HOWTO](./musig2/HOWTO.md) for signing sessions
- Run the test files for more examples
- Join the Lotusia community for support

---

## License

MIT License - Copyright 2025 The Lotusia Stewardship
