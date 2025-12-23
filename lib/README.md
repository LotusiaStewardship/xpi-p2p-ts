# P2P Coordination Layer (libp2p)

**Status**: Production Ready ✅  
**Version**: 2.0.0  
**Updated**: November 28, 2025  
**Node.js**: >= 22.0.0 (required for libp2p 3.x)

---

## Overview

This is a **generalized peer-to-peer (P2P) networking infrastructure** for the Lotus SDK built on **libp2p 3.x**. It provides core P2P primitives that can be extended by any protocol requiring decentralized coordination.

**Built on libp2p**: Industry-standard P2P networking stack used by IPFS, Filecoin, and Ethereum 2.0.

**Use Cases:**

- MuSig2 multi-signature session coordination
- Decentralized CoinJoin rounds (SwapSig)
- Any protocol requiring peer-to-peer communication

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    P2P Coordinator                          │
│  • Protocol registration                                    │
│  • Message routing                                          │
│  • Resource management                                      │
│  • GossipSub pub/sub                                        │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │       libp2p 3.x       │
            │  ┌──────────────────┐  │
            │  │ Connection Mgr   │  │
            │  │ Kad-DHT          │  │
            │  │ GossipSub        │  │
            │  │ Transports       │  │
            │  │ • TCP            │  │
            │  │ • WebSockets     │  │
            │  │ • Circuit Relay  │  │
            │  │ NAT Traversal    │  │
            │  │ • AutoNAT        │  │
            │  │ • DCUTR          │  │
            │  │ • UPnP           │  │
            │  │ Encryption       │  │
            │  └──────────────────┘  │
            └────────────────────────┘
```

---

## Key Features

✅ **Industry-Standard libp2p 3.x**

- Proven P2P stack
- Used by major blockchain projects
- Active development and support

✅ **Full Feature Set**

- Kad-DHT for decentralized discovery
- Multiple transports (TCP, WebSockets, Circuit Relay v2)
- Encrypted connections (Noise protocol)
- Stream multiplexing (Yamux)
- Complete NAT traversal (AutoNAT, DCUTR, UPnP)
- GossipSub pub/sub messaging

✅ **Protocol Extension**

- `IProtocolHandler` interface
- Custom protocol streams
- Message routing

✅ **Security**

- Rate limiting for DHT announcements
- Resource tracking per peer
- Peer ban management
- Protocol validators

✅ **Type-Safe**

- Native libp2p types
- TypeScript throughout
- Generic type support

---

## Quick Start

### Installation

```bash
npm install lotus-sdk
```

**Requirements:**
- Node.js >= 22.0.0 (required for libp2p 3.x)

### Basic Usage

```typescript
import { P2PCoordinator } from 'lotus-sdk/lib/p2p'

// Create coordinator
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'], // Listen on any available port
  enableDHT: true,
  enableGossipSub: true,
})

// Start node
await coordinator.start()

console.log('Peer ID:', coordinator.peerId)
console.log('Listening on:', coordinator.getStats().multiaddrs)

// Connect to another peer
await coordinator.connectToPeer('/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...')

// Announce resource via DHT
await coordinator.announceResource(
  'session',
  'session-123',
  { participants: ['alice', 'bob'] },
  { ttl: 3600 },
)

// Discover resources
const resources = await coordinator.discoverResources('session')

// Shutdown
await coordinator.stop()
```

### GossipSub Pub/Sub

```typescript
// Subscribe to a topic
await coordinator.subscribeToTopic('my-topic', (data: Uint8Array) => {
  const message = JSON.parse(new TextDecoder().decode(data))
  console.log('Received:', message)
})

// Publish to a topic
await coordinator.publishToTopic('my-topic', { hello: 'world' })

// Get peers subscribed to a topic
const peers = coordinator.getTopicPeers('my-topic')

// Unsubscribe
await coordinator.unsubscribeFromTopic('my-topic')
```

---

## Configuration

### P2PConfig

```typescript
interface P2PConfig {
  /** Fixed peer identity (optional) */
  privateKey?: PrivateKey

  /** Listen addresses (multiaddrs) */
  listen?: string[]

  /** Announce addresses (multiaddrs) */
  announce?: string[]

  /** Bootstrap peer addresses (multiaddrs with peer IDs) */
  bootstrapPeers?: string[]

  /** Enable Kad-DHT (default: true) */
  enableDHT?: boolean

  /** DHT protocol prefix */
  dhtProtocol?: string

  /** Enable DHT server mode (default: false for clients) */
  enableDHTServer?: boolean

  /** Enable GossipSub pub/sub (default: true) */
  enableGossipSub?: boolean

  /** Enable circuit relay v2 transport (default: true) */
  enableRelay?: boolean

  /** Enable relay server mode (default: false) */
  enableRelayServer?: boolean

  /** Enable AutoNAT (default: true) */
  enableAutoNAT?: boolean

  /** Enable DCUTR hole punching (default: true) */
  enableDCUTR?: boolean

  /** Enable UPnP/NAT-PMP (default: false - security risk) */
  enableUPnP?: boolean

  /** Connection manager options */
  connectionManager?: {
    minConnections?: number  // Default: 10
    maxConnections?: number  // Default: 50
  }

  /** Security configuration */
  securityConfig?: {
    disableRateLimiting?: boolean  // WARNING: Never disable in production!
    customLimits?: Partial<typeof CORE_P2P_SECURITY_LIMITS>
  }
}
```

### Configuration Examples

**Minimal (Client)**
```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
})
```

**Production Client**
```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/4001'],
  bootstrapPeers: [
    '/dns4/bootstrap.lotusia.org/tcp/4001/p2p/12D3KooW...',
  ],
  enableDHT: true,
  enableDHTServer: false,  // Client mode
  enableGossipSub: true,
  enableRelay: true,       // NAT traversal
  enableAutoNAT: true,
  enableDCUTR: true,
  connectionManager: {
    minConnections: 10,
    maxConnections: 50,
  },
})
```

**Bootstrap/Relay Node**
```typescript
const coordinator = new P2PCoordinator({
  listen: [
    '/ip4/0.0.0.0/tcp/4001',
    '/ip4/0.0.0.0/tcp/4002/ws',
  ],
  announce: [
    '/dns4/my-node.example.com/tcp/4001',
    '/dns4/my-node.example.com/tcp/4002/ws',
  ],
  enableDHT: true,
  enableDHTServer: true,   // Full DHT server
  enableRelayServer: true, // Act as relay for NAT peers
  enableAutoNAT: false,    // Public nodes don't need this
  connectionManager: {
    minConnections: 50,
    maxConnections: 500,
  },
})
```

---

## NAT Traversal

The P2P layer provides comprehensive NAT traversal support:

### NAT Traversal Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    NAT Traversal Stack                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: UPnP/NAT-PMP (opt-in, disabled by default)        │
│  Layer 3: DCUTR Hole Punching (automatic upgrade)           │
│  Layer 2: Circuit Relay v2 (fallback via bootstrap)         │
│  Layer 1: AutoNAT (detection and public address discovery)  │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **AutoNAT** detects if you're behind NAT
2. **Circuit Relay v2** connects you via public relay nodes
3. **DCUTR** automatically upgrades relay connections to direct P2P
4. **UPnP** (optional) requests port forwarding from your router

### Checking NAT Status

```typescript
// Check if relay addresses are available
const hasRelay = await coordinator.hasRelayAddresses()

// Get relay addresses
const relayAddrs = await coordinator.getRelayAddresses()

// Get all reachable addresses (prioritizes relay for NAT)
const reachable = await coordinator.getReachableAddresses()
```

---

## Protocol Extension

Implement custom protocols using `IProtocolHandler`:

```typescript
import { IProtocolHandler, P2PMessage, PeerInfo } from 'lotus-sdk/lib/p2p'

class MyProtocol implements IProtocolHandler {
  readonly protocolName = 'my-protocol'
  readonly protocolId = '/lotus/my-protocol/1.0.0'

  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    console.log(`Message from ${from.peerId}:`, message.payload)
  }

  // Optional: Handle raw libp2p streams
  async handleStream?(stream: Stream, connection: Connection): Promise<void> {
    // Handle stream data
  }

  // Optional: Lifecycle hooks
  async onPeerConnected?(peerId: string): Promise<void> {
    console.log('Peer connected:', peerId)
  }

  async onPeerDisconnected?(peerId: string): Promise<void> {
    console.log('Peer disconnected:', peerId)
  }

  async onPeerDiscovered?(peerInfo: PeerInfo): Promise<void> {
    console.log('Peer discovered:', peerInfo.peerId)
  }
}

// Register protocol
coordinator.registerProtocol(new MyProtocol())

// Unregister when done
coordinator.unregisterProtocol('my-protocol')
```

---

## Security

### Core Security Manager

```typescript
// Access core security manager
const security = coordinator.getCoreSecurityManager()

// Register protocol validators
security.registerValidator({
  validateResourceAnnouncement: async (resourceType, resourceId, data, peerId) => {
    // Custom validation logic
    return true // Accept or reject
  },

  validateMessage: async (message, from) => {
    return message.payload !== null
  },

  canAnnounceResource: async (resourceType, peerId) => {
    return true
  },
})

// Get security metrics
const metrics = security.getMetrics()
console.log('Security metrics:', metrics)
```

### Built-in Security Features

| Feature | Default | Description |
|---------|---------|-------------|
| Rate Limiting | 30s | Minimum interval between DHT announcements per peer |
| Resource Limits | 100/20 | Max 100 resources per peer, 20 per type |
| Message Size | 100KB | Maximum message size |
| Peer Banning | Auto | Automatic banning for malicious behavior |

### Security Configuration

```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
  securityConfig: {
    // WARNING: Never disable in production!
    disableRateLimiting: false,

    // Override default limits
    customLimits: {
      MAX_P2P_MESSAGE_SIZE: 200_000,        // 200KB
      MIN_DHT_ANNOUNCEMENT_INTERVAL: 60_000, // 1 minute
    },
  },
})
```

---

## Blockchain Utilities

### Burn Verifier

Generic burn transaction verification:

```typescript
import { BurnVerifier } from 'lotus-sdk/lib/p2p'

const verifier = new BurnVerifier('https://chronik.lotusia.org')

const result = await verifier.verifyBurn(
  'txid...',  // Transaction ID
  0,          // Output index
  6,          // Minimum confirmations
  0,          // Maturation period (0 = none)
)

if (result) {
  console.log('Burn verified:', {
    txId: result.txId,
    burnAmount: result.burnAmount,
    confirmations: result.confirmations,
    isMatured: result.isMatured,
    lokadPrefix: result.lokadPrefix,
  })
}
```

### Transaction Monitor

```typescript
import { TransactionMonitor } from 'lotus-sdk/lib/p2p'

const monitor = new TransactionMonitor('https://chronik.lotusia.org')

// Wait for confirmation
monitor.waitForConfirmation(
  'txid...',
  6,  // Required confirmations
  (tx) => console.log('Confirmed:', tx.txid),
  (error) => console.error('Error:', error),
)
```

---

## API Reference

### P2PCoordinator

```typescript
class P2PCoordinator extends EventEmitter {
  constructor(config: P2PConfig)

  // Lifecycle
  async start(): Promise<void>
  async stop(): Promise<void>
  async shutdown(): Promise<void>

  // Properties
  get peerId(): string
  get libp2pNode(): Libp2p

  // Protocol Management
  registerProtocol(handler: IProtocolHandler): void
  unregisterProtocol(protocolName: string): void

  // Peer Operations
  async connectToPeer(multiaddr: string): Promise<void>
  async disconnectFromPeer(peerId: string): Promise<void>
  getConnectedPeers(): PeerInfo[]
  getPeer(peerId: string): PeerInfo | undefined
  isConnected(peerId: string): boolean

  // Messaging
  async sendTo(peerId: string, message: P2PMessage): Promise<void>
  async broadcast(message: P2PMessage, options?: BroadcastOptions): Promise<void>

  // GossipSub
  async subscribeToTopic(topic: string, handler: (data: Uint8Array) => void): Promise<void>
  async unsubscribeFromTopic(topic: string): Promise<void>
  async publishToTopic(topic: string, message: unknown): Promise<void>
  getTopicPeers(topic: string): string[]

  // Resource Management (DHT)
  async announceResource<T>(type: string, id: string, data: T, options?): Promise<void>
  async discoverResources(type: string, filters?): Promise<ResourceAnnouncement[]>
  getResource(type: string, id: string): ResourceAnnouncement | null
  getLocalResources(type: string, filter?): ResourceAnnouncement[]

  // NAT Traversal
  async getReachableAddresses(): Promise<string[]>
  async hasRelayAddresses(): Promise<boolean>
  async getRelayAddresses(): Promise<string[]>

  // Statistics
  getStats(): P2PStats
  getDHTStats(): DHTStats

  // Security
  getCoreSecurityManager(): CoreSecurityManager

  // Utility
  cleanup(): void

  // Events
  on('peer:connect', (peer: PeerInfo) => void)
  on('peer:disconnect', (peer: PeerInfo) => void)
  on('peer:discovery', (peer: PeerInfo) => void)
  on('message', (message: P2PMessage, from: PeerInfo) => void)
  on('relay:addresses-changed', (data: RelayAddressChangeData) => void)
}
```

### P2PProtocol

```typescript
class P2PProtocol {
  // Create messages
  createMessage<T>(type: string, payload: T, from: string, options?): P2PMessage<T>

  // Serialization
  serialize(message: P2PMessage): Buffer
  deserialize(data: Buffer): P2PMessage

  // Validation
  validateMessage(message: P2PMessage): boolean
  validateMessageSize(message: P2PMessage, maxSize?: number): boolean

  // Hashing
  computeMessageHash(message: P2PMessage): string

  // Utility messages
  createHandshake(peerId: string, metadata?): P2PMessage
  createHeartbeat(peerId: string): P2PMessage
  createDisconnect(peerId: string, reason?: string): P2PMessage
  createError(peerId: string, error: string, context?): P2PMessage
}
```

---

## Testing

### Run Tests

```bash
# All P2P tests (requires Node.js 22+)
npx tsx --test test/p2p/protocol.test.ts
npx tsx --test test/p2p/coordinator.test.ts
npx tsx --test test/p2p/circuit-relay-nat.test.ts
npx tsx --test test/p2p/dht.integration.test.ts
```

### Test Coverage

| Test File | Tests | Description |
|-----------|-------|-------------|
| `protocol.test.ts` | 13 | Message creation, serialization, validation |
| `coordinator.test.ts` | 23 | Connection, messaging, DHT, GossipSub |
| `circuit-relay-nat.test.ts` | 7 | NAT traversal, relay, DCUTR |
| `dht.integration.test.ts` | 11 | DHT discovery and resource management |

---

## File Structure

```
lib/p2p/
├── index.ts           # Main exports
├── types.ts           # Type definitions
├── coordinator.ts     # Main P2P coordinator
├── protocol.ts        # Message protocol
├── security.ts        # Core security manager
├── blockchain-utils.ts # Burn verification, tx monitoring
├── utils.ts           # Utility functions
├── HOWTO.md           # Developer guide
└── README.md          # This file

# Protocol Implementations
├── musig2/            # MuSig2 multi-signature coordination
└── swapsig/           # SwapSig protocol (CoinJoin with MuSig2)

test/p2p/
├── protocol.test.ts
├── coordinator.test.ts
├── circuit-relay-nat.test.ts
└── dht.integration.test.ts
```

---

## Troubleshooting

### Node.js Version Error

**Issue**: `Promise.withResolvers is not a function`

**Solution**: Upgrade to Node.js 22+
```bash
nvm install 22
nvm use 22
```

### Peer Connection Fails

**Issue**: Cannot connect to peer

**Solution**:
1. Check multiaddr format: `/ip4/HOST/tcp/PORT/p2p/PEERID`
2. Verify peer is running and reachable
3. Check firewall settings
4. For NAT peers, ensure relay is available

### DHT Not Finding Resources

**Issue**: Resources not discovered

**Solution**:
1. Ensure DHT is enabled: `enableDHT: true`
2. Connect to bootstrap peers for DHT routing
3. Wait for DHT to propagate (~few seconds)
4. Check local cache with `getResource()` first

### GossipSub Messages Not Received

**Issue**: Published messages not arriving

**Solution**:
1. Ensure both peers are subscribed to the same topic
2. Wait for subscription propagation (~500ms)
3. Verify peers are connected
4. Check `getTopicPeers()` to see subscribed peers

---

## Related Documentation

- [P2P HOWTO Guide](./HOWTO.md) - Developer guide for common tasks
- [MuSig2 HOWTO](./musig2/HOWTO.md) - MuSig2 signing sessions
- [libp2p Documentation](https://docs.libp2p.io/)
- [libp2p GitHub](https://github.com/libp2p/js-libp2p)

---

**Built with libp2p 3.x for the Lotus Ecosystem** 🌸
