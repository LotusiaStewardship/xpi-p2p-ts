# P2P Discovery Layer

**Status**: Production Ready ✅  
**Version**: 1.0.0  
**Updated**: November 28, 2025

---

## Overview

A **reusable, protocol-agnostic DHT advertising and discovery system** for the Lotus SDK P2P layer. This module provides the foundation for peer discovery, capability advertising, and resource lookup across any P2P protocol.

**Built for Extension**: The discovery layer is designed to be extended by protocol-specific implementations (e.g., MuSig2, SwapSig) while providing common functionality out of the box.

**Use Cases:**

- Signer discovery for MuSig2 multi-signature sessions
- Participant discovery for CoinJoin rounds
- Service advertisement and lookup
- Peer capability matching

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Protocol Extensions                                  │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │ MuSig2Discovery     │  │ SwapSigDiscovery    │  │ CustomDiscovery     │  │
│  │ (musig2/)           │  │ (swapsig/)          │  │ (your-protocol/)    │  │
│  └──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘  │
└─────────────┼────────────────────────┼────────────────────────┼─────────────┘
              │                        │                        │
              └────────────────────────┼────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Core Discovery Layer                                 │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │ DHTAdvertiser       │  │ DHTDiscoverer       │  │ SecurityValidator   │  │
│  │                     │  │                     │  │                     │  │
│  │ • advertise()       │  │ • discover()        │  │ • validateAd()      │  │
│  │ • withdraw()        │  │ • subscribe()       │  │ • verifySignature() │  │
│  │ • refresh()         │  │ • cache management  │  │ • reputation        │  │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           P2PCoordinator (Base)                              │
│                    Kad-DHT │ GossipSub │ Direct P2P                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

✅ **Protocol-Agnostic Design**

- Generic interfaces for any discovery use case
- Extensible criteria and advertisement types
- Custom metadata support

✅ **DHT-Based Discovery**

- Decentralized peer discovery via Kad-DHT
- Automatic advertisement refresh
- Configurable TTL and expiration

✅ **Security Layer**

- Schnorr signature verification
- Replay attack prevention
- Peer reputation tracking
- Rate limiting

✅ **Event-Driven Subscriptions (GossipSub)**

- Real-time discovery via GossipSub pub/sub
- Instant callback notifications when new advertisements are published
- No polling - true event-driven architecture
- Optional initial DHT fetch for existing advertisements

✅ **Caching**

- Local cache for discovered advertisements
- Cache hit/miss statistics
- Configurable cache size and TTL

---

## Quick Start

### Installation

```typescript
import {
  DHTAdvertiser,
  DHTDiscoverer,
  DiscoverySecurityValidator,
  createDiscoverySystem,
} from 'lotus-sdk/lib/p2p/discovery'
```

### Basic Usage

```typescript
import { P2PCoordinator } from 'lotus-sdk/lib/p2p'
import { createDiscoverySystem } from 'lotus-sdk/lib/p2p/discovery'

// Create P2P coordinator
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
  enableDHT: true,
})
await coordinator.start()

// Create discovery system
const discovery = createDiscoverySystem(coordinator, {
  defaultTTL: 30 * 60 * 1000, // 30 minutes
  enableAutoRefresh: true,
  refreshInterval: 20 * 60 * 1000, // 20 minutes
})

// Start discovery
await discovery.start()

// Advertise capabilities
const adId = await discovery.advertiser.advertise({
  protocol: 'my-protocol',
  peerId: coordinator.peerId,
  capabilities: ['signing', 'relay'],
  metadata: { version: '1.0.0' },
})

// Discover peers
const peers = await discovery.discoverer.discover({
  protocol: 'my-protocol',
  capabilities: ['signing'],
})

console.log(`Found ${peers.length} peers with signing capability`)

// Cleanup
await discovery.stop()
await coordinator.stop()
```

---

## Module Structure

```
lib/p2p/discovery/
├── index.ts           # Public exports and factory functions
├── types.ts           # Core interfaces and types
├── dht-advertiser.ts  # DHT advertising implementation
├── dht-discoverer.ts  # DHT discovery implementation
├── security.ts        # Security validation
└── README.md          # This file
```

---

## Core Components

### DHTAdvertiser

Handles advertising peer capabilities to the DHT.

```typescript
import { DHTAdvertiser } from 'lotus-sdk/lib/p2p/discovery'

const advertiser = new DHTAdvertiser(coordinator, securityValidator, options)

// Start the advertiser
await advertiser.start()

// Advertise capabilities
const adId = await advertiser.advertise({
  protocol: 'musig2',
  peerId: coordinator.peerId,
  capabilities: ['signer'],
  metadata: {
    publicKey: myPublicKey.toString(),
    transactionTypes: ['spend', 'coinjoin'],
  },
})

// Refresh advertisement (reset TTL)
await advertiser.refresh(adId)

// Withdraw advertisement
await advertiser.withdraw(adId)

// Check active advertisements
const activeAds = advertiser.getActiveAdvertisements()
console.log('Active advertisements:', activeAds)

// Stop advertiser
await advertiser.stop()
```

### DHTDiscoverer

Handles discovering peers using a hybrid DHT + GossipSub approach:

- **DHT**: For one-time queries and persistent storage lookup
- **GossipSub**: For real-time event-driven subscriptions

```typescript
import { DHTDiscoverer } from 'lotus-sdk/lib/p2p/discovery'

const discoverer = new DHTDiscoverer(coordinator)

// Start the discoverer
await discoverer.start()

// One-time discovery (queries DHT)
const peers = await discoverer.discover({
  protocol: 'musig2',
  capabilities: ['signer'],
  minReputation: 50,
})

// Subscribe for real-time updates (uses GossipSub)
// Callback is invoked immediately when new advertisements are published
const subscription = await discoverer.subscribe(
  {
    protocol: 'musig2',
    capabilities: ['signer'],
  },
  advertisement => {
    // Called instantly when a new signer advertises
    console.log('New signer discovered:', advertisement.peerInfo.peerId)
  },
  {
    fetchExisting: true, // Also fetch existing from DHT
    deduplicate: true, // Don't notify for same ad twice
  },
)

// Unsubscribe when done
await discoverer.unsubscribe(subscription.id)

// Cache statistics
const stats = discoverer.getCacheStats()
console.log('Cache hit rate:', stats.hitRate)

// Stop discoverer
await discoverer.stop()
```

### DiscoverySecurityValidator

Validates advertisements and manages peer reputation.

```typescript
import { DiscoverySecurityValidator } from 'lotus-sdk/lib/p2p/discovery'

const validator = new DiscoverySecurityValidator(options)

// Validate an advertisement
const result = await validator.validateAdvertisement(advertisement)

if (result.valid) {
  console.log('Valid advertisement, security score:', result.securityScore)
} else {
  console.log('Invalid advertisement:', result.reason)
}

// Check peer reputation
const reputation = validator.getPeerReputation(peerId)
console.log('Peer reputation:', reputation.score)

// Update reputation (after successful interaction)
validator.updateReputation(peerId, 10) // +10 points

// Check rate limiting
const canAdvertise = validator.checkRateLimit(peerId, 'advertise')
```

---

## Configuration

### DiscoveryOptions

```typescript
interface DiscoveryOptions {
  /** Default TTL for advertisements (ms) */
  defaultTTL?: number // Default: 30 minutes

  /** Number of DHT replicas */
  replicaCount?: number // Default: 3

  /** Enable auto-refresh of advertisements */
  enableAutoRefresh?: boolean // Default: true

  /** Refresh interval (ms) */
  refreshInterval?: number // Default: 20 minutes

  /** Enable local caching */
  enableCache?: boolean // Default: true

  /** Maximum cache size */
  maxCacheSize?: number // Default: 1000

  /** Cache TTL (ms) */
  cacheTTL?: number // Default: 5 minutes

  /** Enable rate limiting */
  enableRateLimiting?: boolean // Default: true

  /** Maximum advertisements per peer */
  maxAdsPerPeer?: number // Default: 10

  /** Minimum interval between advertisements (ms) */
  minAdvertiseInterval?: number // Default: 30 seconds
}
```

### SecurityPolicy

```typescript
interface SecurityPolicy {
  /** Require signature verification */
  requireSignature?: boolean // Default: true

  /** Minimum reputation score to accept */
  minReputation?: number // Default: 0

  /** Maximum timestamp skew (ms) */
  maxTimestampSkew?: number // Default: 5 minutes

  /** Enable replay attack prevention */
  enableReplayPrevention?: boolean // Default: true

  /** Rate limit: max advertisements per minute */
  maxAdvertisementsPerMinute?: number // Default: 10

  /** Rate limit: max discoveries per minute */
  maxDiscoveriesPerMinute?: number // Default: 60

  /** Custom validators */
  customValidators?: CustomValidator[]
}
```

---

## Types

### DiscoveryCriteria

Criteria for discovering peers:

```typescript
interface DiscoveryCriteria {
  /** Protocol identifier (e.g., 'musig2', 'swapsig') */
  protocol: string

  /** Required capabilities */
  capabilities?: string[]

  /** Minimum reputation score */
  minReputation?: number

  /** Geographic location filter */
  location?: {
    latitude: number
    longitude: number
    radiusKm: number
  }

  /** Custom criteria (protocol-specific) */
  custom?: Record<string, unknown>
}
```

### DiscoveryAdvertisement

Advertisement published to DHT:

```typescript
interface DiscoveryAdvertisement {
  /** Unique advertisement ID */
  id: string

  /** Protocol identifier */
  protocol: string

  /** Advertiser's peer ID */
  peerId: string

  /** Advertiser's multiaddrs */
  multiaddrs?: string[]

  /** Advertised capabilities */
  capabilities: string[]

  /** Reputation score */
  reputation?: number

  /** Geographic location */
  location?: { latitude: number; longitude: number }

  /** Custom metadata */
  metadata?: Record<string, unknown>

  /** Schnorr signature */
  signature?: string

  /** Creation timestamp */
  timestamp: number

  /** Expiration timestamp */
  expiresAt: number
}
```

### SecurityValidationResult

Result of advertisement validation:

```typescript
interface SecurityValidationResult {
  /** Whether the advertisement is valid */
  valid: boolean

  /** Reason for rejection (if invalid) */
  reason?: string

  /** Security score (0-100) */
  securityScore: number

  /** Validation details */
  details?: {
    signatureValid?: boolean
    timestampValid?: boolean
    reputationValid?: boolean
    rateLimitPassed?: boolean
  }
}
```

---

## Factory Functions

### createDiscoverySystem

Creates a complete discovery system with advertiser, discoverer, and security validator:

```typescript
import { createDiscoverySystem } from 'lotus-sdk/lib/p2p/discovery'

const discovery = createDiscoverySystem(coordinator, {
  defaultTTL: 30 * 60 * 1000,
  enableAutoRefresh: true,
})

await discovery.start()

// Access components
discovery.advertiser // DHTAdvertiser
discovery.discoverer // DHTDiscoverer
discovery.securityValidator // DiscoverySecurityValidator

await discovery.stop()
```

### createAdvertiser / createDiscoverer / createSecurityValidator

Create individual components:

```typescript
import {
  createAdvertiser,
  createDiscoverer,
  createSecurityValidator,
} from 'lotus-sdk/lib/p2p/discovery'

const validator = createSecurityValidator(securityPolicy)
const advertiser = createAdvertiser(coordinator, validator, options)
const discoverer = createDiscoverer(coordinator, validator, options)
```

---

## Extending for Protocols

The discovery layer is designed to be extended. See `musig2/discovery-extension.ts` for a complete example.

### Basic Extension Pattern

```typescript
import {
  DHTAdvertiser,
  DHTDiscoverer,
  DiscoveryCriteria,
  DiscoveryAdvertisement,
} from 'lotus-sdk/lib/p2p/discovery'

// Define protocol-specific criteria
interface MyProtocolCriteria extends DiscoveryCriteria {
  protocol: 'my-protocol'
  myCustomField?: string
}

// Define protocol-specific advertisement
interface MyProtocolAdvertisement extends DiscoveryAdvertisement {
  protocol: 'my-protocol'
  myCustomData?: unknown
}

// Create extension class
class MyProtocolDiscovery {
  private advertiser: DHTAdvertiser
  private discoverer: DHTDiscoverer

  constructor(coordinator: P2PCoordinator) {
    const validator = new DiscoverySecurityValidator()
    this.advertiser = new DHTAdvertiser(coordinator, validator)
    this.discoverer = new DHTDiscoverer(coordinator, validator)
  }

  async advertiseService(data: MyServiceData): Promise<string> {
    return this.advertiser.advertise({
      protocol: 'my-protocol',
      peerId: this.coordinator.peerId,
      capabilities: ['my-service'],
      metadata: data,
    })
  }

  async discoverServices(
    criteria: MyProtocolCriteria,
  ): Promise<MyProtocolAdvertisement[]> {
    const ads = await this.discoverer.discover(criteria)
    return ads as MyProtocolAdvertisement[]
  }
}
```

---

## Security

### Signature Verification

All advertisements are signed using Schnorr signatures:

```typescript
// Advertisements are automatically signed when created
const adId = await advertiser.advertise({
  protocol: 'musig2',
  peerId: coordinator.peerId,
  // ... signature is added automatically
})

// Signatures are verified during discovery
const peers = await discoverer.discover({ protocol: 'musig2' })
// Only valid, signed advertisements are returned
```

### Replay Attack Prevention

The security validator tracks seen advertisements to prevent replay attacks:

```typescript
const validator = new DiscoverySecurityValidator({
  enableReplayPrevention: true,
})

// First time: valid
const result1 = await validator.validateAdvertisement(ad)
// result1.valid === true

// Replay attempt: rejected
const result2 = await validator.validateAdvertisement(ad)
// result2.valid === false
// result2.reason === 'Replay attack detected'
```

### Reputation System

Peer reputation is tracked and used for filtering:

```typescript
// Discover only reputable peers
const peers = await discoverer.discover({
  protocol: 'musig2',
  minReputation: 70,
})

// Update reputation after interaction
validator.updateReputation(peerId, 10) // Success: +10
validator.updateReputation(peerId, -20) // Failure: -20
```

### Rate Limiting

Rate limiting prevents spam and DoS attacks:

```typescript
const validator = new DiscoverySecurityValidator({
  maxAdvertisementsPerMinute: 10,
  maxDiscoveriesPerMinute: 60,
})

// Check before advertising
if (validator.checkRateLimit(peerId, 'advertise')) {
  await advertiser.advertise(ad)
} else {
  console.log('Rate limited, try again later')
}
```

---

## API Reference

### DHTAdvertiser

```typescript
class DHTAdvertiser implements IDiscoveryAdvertiser {
  constructor(
    coordinator: P2PCoordinator,
    securityValidator: DiscoverySecurityValidator,
    options?: DiscoveryOptions,
  )

  // Lifecycle
  async start(): Promise<void>
  async stop(): Promise<void>

  // Advertising
  async advertise(
    advertisement: Partial<DiscoveryAdvertisement>,
  ): Promise<string>
  async withdraw(advertisementId: string): Promise<void>
  async refresh(advertisementId: string): Promise<void>

  // Status
  getActiveAdvertisements(): string[]
  isAdvertisementActive(advertisementId: string): boolean
}
```

### DHTDiscoverer

```typescript
class DHTDiscoverer implements IDiscoveryDiscoverer {
  constructor(
    coordinator: P2PCoordinator,
    securityValidator: DiscoverySecurityValidator,
    options?: DiscoveryOptions,
  )

  // Lifecycle
  async start(): Promise<void>
  async stop(): Promise<void>

  // Discovery
  async discover(criteria: DiscoveryCriteria): Promise<DiscoveryAdvertisement[]>

  // Subscriptions
  async subscribe(
    criteria: DiscoveryCriteria,
    callback: (advertisements: DiscoveryAdvertisement[]) => void,
    options?: SubscriptionOptions,
  ): Promise<string>
  async unsubscribe(subscriptionId: string): Promise<void>
  getActiveSubscriptions(): string[]

  // Cache
  clearCache(protocol?: string): void
  getCacheStats(): CacheStats
}
```

### DiscoverySecurityValidator

```typescript
class DiscoverySecurityValidator {
  constructor(policy?: SecurityPolicy)

  // Validation
  async validateAdvertisement(
    advertisement: DiscoveryAdvertisement,
  ): Promise<SecurityValidationResult>

  // Reputation
  getPeerReputation(peerId: string): ReputationData
  updateReputation(peerId: string, delta: number): void

  // Rate Limiting
  checkRateLimit(peerId: string, action: 'advertise' | 'discover'): boolean

  // Statistics
  getSecurityStats(): SecurityStats
}
```

---

## Related Documentation

- [P2P Core README](../README.md) - Core P2P infrastructure
- [P2P Core HOWTO](../HOWTO.md) - Developer guide for P2P
- [MuSig2 Discovery](../musig2/DISCOVERY_README.md) - MuSig2-specific discovery
- [DHT Discovery Implementation Status](../../docs/DHT_DISCOVERY_IMPLEMENTATION_STATUS.md) - Implementation status

---

**Built for the Lotus Ecosystem** 🌸
