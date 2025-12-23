# xpi-p2p-ts

TypeScript SDK providing peer-to-peer connectivity (libp2p) for Lotus (XPI) applications.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js->=22-green)](https://nodejs.org/)

A comprehensive TypeScript library providing P2P networking infrastructure, multi-signature coordination, and privacy protocols for the Lotus (XPI) blockchain ecosystem.

---

## Features

### P2P Networking

- **libp2p Infrastructure** - Industry-grade P2P networking
  - Kademlia DHT for distributed discovery
  - GossipSub for real-time messaging
  - Multiple transports (TCP, WebSocket)
  - NAT traversal (UPnP, AutoNAT, DCUTR)
  - Noise protocol encryption
- **Protocol Extension System** - Build custom P2P protocols
  - Clean `IProtocolHandler` interface
  - Event-driven architecture
  - Direct stream access

### MuSig2 Multi-Signature

- **Production-Ready Coordination** - P2P coordination for MuSig2 signing
  - 2-round non-interactive signing
  - Coordinator election with automatic failover
  - Privacy-preserving multisig (indistinguishable from single-sig)
  - Event-driven session management
  - Support for ν ≥ 2 nonces per MuSig2 specification
- **Discovery System** - DHT-based signer and signing request discovery
  - Signer advertisement and discovery
  - Signing request publication and matching
  - Criteria-based peer search

### SwapSig Privacy Protocol (PENDING)

- **CoinJoin-Equivalent Privacy** - Using MuSig2 for transaction mixing
  - Multi-party transaction coordination
  - Dynamic group sizing (2-of-2, 3-of-3, 5-of-5, 10-of-10)
  - XPI burn-based Sybil defense
  - Privacy-preserving coin mixing

### Security & Utilities

- **Core Security Manager** - Rate limiting, peer banning, validation
- **Blockchain Utilities** - Burn verification, transaction monitoring
- **Type-Safe** - Native TypeScript throughout with generic type support

---

## Installation

```bash
npm install xpi-p2p-ts
```

### Requirements

- Node.js >= 22.0.0 (required for libp2p 3.x)
- TypeScript >= 5.0 (for development)

---

## Quick Start

### Basic P2P Node

```typescript
import { P2PCoordinator } from 'xpi-p2p-ts'

// Create coordinator
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
  enableDHT: true,
  enableGossipSub: true,
})

// Start node
await coordinator.start()

console.log('Peer ID:', coordinator.peerId)
console.log('Listening on:', coordinator.getStats().multiaddrs)

// Connect to another peer
await coordinator.connectToPeer('/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...')

// Shutdown
await coordinator.stop()
```

### MuSig2 Multi-Signature Coordination

```typescript
import { MuSig2P2PCoordinator } from 'xpi-p2p-ts/lib/musig2'
import { PrivateKey, PublicKey } from 'xpi-ts'

// Create coordinator with P2P networking
const coordinator = new MuSig2P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/4001'],
  enableDHT: true,
  bootstrapPeers: ['/dns4/bootstrap.lotusia.org/tcp/4001/p2p/...'],
})

await coordinator.start()

// Create signing session
const signers = [
  PublicKey.fromString('02...'),
  PublicKey.fromString('03...'),
  PublicKey.fromString('02...'),
].sort((a, b) => a.toBuffer().compare(b.toBuffer()))

const myPrivateKey = PrivateKey.fromWIF('...')
const message = Buffer.from('transaction sighash')

const sessionId = await coordinator.createSession(
  signers,
  myPrivateKey,
  message,
)

// Announce session to network
await coordinator.announceSession(sessionId)

// Listen for events
coordinator.on('session:ready', async sessionId => {
  // All participants joined, share nonces
  await coordinator.shareNonces(sessionId, myPrivateKey)
})

coordinator.on('nonces:complete', async sessionId => {
  // All nonces collected, share partial signature
  await coordinator.sharePartialSignature(sessionId, myPrivateKey)
})

coordinator.on('session:complete', (sessionId, signature) => {
  console.log('Final signature:', signature.toString('hex'))
})

// Cleanup
await coordinator.stop()
```

### GossipSub Pub/Sub Messaging

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

### DHT Resource Discovery

```typescript
// Announce a resource
await coordinator.announceResource(
  'session',
  'session-123',
  { participants: ['alice', 'bob'] },
  { ttl: 3600 },
)

// Discover a specific resource
const resource = await coordinator.discoverResource('session', 'session-123')

// Get from local cache
const cachedResource = coordinator.getResource('session', 'session-123')

// Get all local resources of a type
const allLocal = coordinator.getLocalResources('session')
```

---

## Core Modules

### P2P Coordinator

libp2p-based P2P infrastructure with protocol extension system:

- **P2PCoordinator** - Main networking coordinator
- **DHT** - Kademlia distributed hash table
- **GossipSub** - Real-time pub/sub messaging
- **Protocol handlers** - Extend with custom protocols

See: `lib/README.md`

### MuSig2 Coordination

Multi-signature Schnorr signatures with P2P coordination:

- **2-round signing** - Non-interactive nonce exchange
- **Coordinator election** - Deterministic with automatic failover
- **Security** - Replay protection, rate limiting, Sybil resistance
- **Discovery** - DHT-based signer and signing request discovery

See: `lib/musig2/README.md`

### SwapSig Privacy Protocol

CoinJoin-equivalent privacy protocol using MuSig2:

- **Pool coordination** - Multi-party transaction mixing
- **Dynamic sizing** - 2-of-2, 3-of-3, 5-of-5, 10-of-10 groups
- **Sybil defense** - XPI burn mechanism
- **Privacy** - Breaks on-chain transaction graph

See: `lib/swapsig/` directory

---

## Configuration

### P2PConfig

```typescript
interface P2PConfig {
  // Fixed peer identity (optional)
  privateKey?: PrivateKey

  // Listen addresses (multiaddrs)
  listen?: string[]

  // Announce addresses (multiaddrs)
  announce?: string[]

  // Bootstrap peer addresses (multiaddrs with peer IDs)
  bootstrapPeers?: string[]

  // Enable Kad-DHT (default: true)
  enableDHT?: boolean

  // DHT protocol prefix
  dhtProtocol?: string

  // Enable DHT server mode (default: false for clients)
  enableDHTServer?: boolean

  // Enable GossipSub pub/sub (default: true)
  enableGossipSub?: boolean

  // Enable circuit relay v2 transport (default: true)
  enableRelay?: boolean

  // Enable relay server mode (default: false)
  enableRelayServer?: boolean

  // Enable AutoNAT (default: true)
  enableAutoNAT?: boolean

  // Enable DCUTR hole punching (default: true)
  enableDCUTR?: boolean

  // Enable UPnP/NAT-PMP (default: false - security risk)
  enableUPnP?: boolean

  // Connection manager options
  connectionManager?: {
    maxConnections?: number // Default: 50
  }

  // Security configuration
  securityConfig?: {
    disableRateLimiting?: boolean // WARNING: Never disable in production!
    customLimits?: Partial<typeof CORE_P2P_SECURITY_LIMITS>
  }
}
```

### Configuration Examples

**Minimal Client**

```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
})
```

**Production Client**

```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/4001'],
  bootstrapPeers: ['/dns4/bootstrap.lotusia.org/tcp/4001/p2p/12D3KooW...'],
  enableDHT: true,
  enableDHTServer: false,
  enableGossipSub: true,
  enableRelay: true,
  enableAutoNAT: true,
  enableDCUTR: true,
  connectionManager: {
    maxConnections: 50,
  },
})
```

**Bootstrap/Relay Node**

```typescript
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws'],
  announce: [
    '/dns4/my-node.example.com/tcp/4001',
    '/dns4/my-node.example.com/tcp/4002/ws',
  ],
  enableDHT: true,
  enableDHTServer: true,
  enableRelayServer: true,
  enableAutoNAT: false,
  connectionManager: {
    maxConnections: 500,
  },
})
```

---

## NAT Traversal

The P2P layer provides comprehensive NAT traversal support:

```
Layer 4: UPnP/NAT-PMP (opt-in, disabled by default)
Layer 3: DCUTR Hole Punching (automatic upgrade)
Layer 2: Circuit Relay v2 (fallback via bootstrap)
Layer 1: AutoNAT (detection and public address discovery)
```

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
import { IProtocolHandler, P2PMessage, PeerInfo } from 'xpi-p2p-ts'

class MyProtocol implements IProtocolHandler {
  readonly protocolName = 'my-protocol'
  readonly protocolId = '/lotus/my-protocol/1.0.0'

  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    console.log(`Message from ${from.peerId}:`, message.payload)
  }

  async onPeerConnected?(peerId: string): Promise<void> {
    console.log('Peer connected:', peerId)
  }

  async onPeerDisconnected?(peerId: string): Promise<void> {
    console.log('Peer disconnected:', peerId)
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
  validateResourceAnnouncement: async (
    resourceType,
    resourceId,
    data,
    peerId,
  ) => {
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

| Feature         | Default | Description                                         |
| --------------- | ------- | --------------------------------------------------- |
| Rate Limiting   | 30s     | Minimum interval between DHT announcements per peer |
| Resource Limits | 100/20  | Max 100 resources per peer, 20 per type             |
| Message Size    | 100KB   | Maximum message size                                |
| Peer Banning    | Auto    | Automatic banning for malicious behavior            |

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
  get connectionState(): P2PConnectionState

  // Protocol Management
  registerProtocol(handler: IProtocolHandler): void
  unregisterProtocol(protocolName: string): void

  // Peer Operations
  async connectToPeer(multiaddr: string | Multiaddr): Promise<void>
  async disconnectFromPeer(peerId: string): Promise<void>
  getConnectedPeers(): PeerInfo[]
  getPeer(peerId: string): PeerInfo | undefined
  isConnected(peerId: string): boolean

  // Messaging
  async sendTo(peerId: string, message: P2PMessage, protocolId?: string): Promise<void>
  async broadcast(message: P2PMessage, options?: BroadcastOptions): Promise<void>

  // GossipSub
  async subscribeToTopic(topic: string, handler: (data: Uint8Array) => void): Promise<void>
  async unsubscribeFromTopic(topic: string): Promise<void>
  async publishToTopic(topic: string, message: unknown): Promise<void>
  getTopicPeers(topic: string): string[]

  // Resource Management (DHT)
  async announceResource<T>(type: string, id: string, data: T, options?): Promise<void>
  async discoverResource(type: string, id: string, timeoutMs?: number): Promise<ResourceAnnouncement | null>
  getResource(type: string, id: string): ResourceAnnouncement | null
  getLocalResources(type: string, filters?): ResourceAnnouncement[]

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
  on('connection:state-changed', (data: ConnectionStateChangeData) => void)
}
```

---

## Testing

```bash
# All P2P tests (requires Node.js 22+)
npx tsx --test test/p2p/protocol.test.ts
npx tsx --test test/p2p/coordinator.test.ts
npx tsx --test test/p2p/circuit-relay-nat.test.ts
npx tsx --test test/p2p/dht.integration.test.ts
```

---

## File Structure

```
lib/
├── index.ts                    # Main exports
├── types.ts                    # Type definitions
├── coordinator.ts              # Main P2P coordinator
├── protocol.ts                 # Message protocol
├── security.ts                 # Core security manager
├── blockchain-utils.ts         # Burn verification, tx monitoring
├── utils.ts                    # Utility functions
├── README.md                   # P2P core documentation
├── HOWTO.md                    # Developer guide
├── musig2/                     # MuSig2 multi-signature coordination
│   ├── coordinator.ts
│   ├── protocol.ts
│   ├── security.ts
│   ├── discovery-extension.ts
│   ├── README.md
│   └── HOWTO.md
├── discovery/                  # Peer discovery utilities
├── swapsig/                    # SwapSig privacy protocol
└── test/                       # Test suite

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

## Documentation

Comprehensive documentation is available in the `lib/` directory:

- [P2P Core README](lib/README.md) - P2P networking overview
- [P2P HOWTO Guide](lib/HOWTO.md) - Developer guide for common tasks
- [MuSig2 README](lib/musig2/README.md) - MuSig2 coordination details
- [MuSig2 HOWTO](lib/musig2/HOWTO.md) - MuSig2 signing sessions guide

---

## Lotus Network Information

**Lotus (XPI)** is a Bitcoin-based cryptocurrency with several key differences:

- **Decimals**: 6 (1 XPI = 1,000,000 satoshis) vs Bitcoin's 8
- **Supply**: Inflationary with no hard cap
- **Consensus**: Proof-of-Work (SHA-256d)
- **Features**: OP_RETURN data, Taproot, RANK protocol

**Network Resources:**

- Official Website: https://lotusia.org
- Documentation: https://lotusia.org/docs
- Block Explorer: https://explorer.lotusia.org
- Full Node (lotusd): https://github.com/LotusiaStewardship/lotusd

---

## Community

**Discord:** [Lotusia](https://discord.gg/fZrFa3vf)
**Telegram:** [Lotusia Discourse](https://t.me/LotusiaDiscourse)
**GitHub:** [LotusiaStewardship](https://github.com/LotusiaStewardship)

---

## Contributing

Contributions are welcome! Please:

1. Read the relevant documentation thoroughly
2. Follow the existing code style (Prettier + ESLint)
3. Add tests for new features
4. Update documentation as needed
5. Submit a pull request

### Development Setup

```bash
# Clone repository
git clone https://github.com/LotusiaStewardship/xpi-p2p-ts.git
cd xpi-p2p-ts

# Install dependencies
npm install

# Build library
npm run build

# Run tests
npm test
```

---

## License

[MIT License](LICENSE) - Copyright (c) 2025 The Lotusia Stewardship

---

## Related Projects

- **xpi-ts** - Core Lotus cryptography and transaction library
  https://github.com/LotusiaStewardship/xpi-ts

- **lotusd** - Lotus full node implementation
  https://github.com/LotusiaStewardship/lotusd

- **lotus-explorer** - Lotus blockchain explorer
  https://github.com/LotusiaStewardship/lotus-explorer

- **lotus-sdk** - Comprehensive Lotus SDK (includes this P2P module)
  https://github.com/LotusiaStewardship/lotus-sdk

---

Built with libp2p 3.x for the Lotus Ecosystem
