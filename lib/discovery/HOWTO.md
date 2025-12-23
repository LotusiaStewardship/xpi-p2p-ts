# P2P Discovery Layer Developer Guide

A comprehensive guide for building applications with the P2P discovery layer.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Understanding the Architecture](#understanding-the-architecture)
3. [Advertising Capabilities](#advertising-capabilities)
4. [Discovering Peers](#discovering-peers)
5. [Subscriptions](#subscriptions)
6. [Security and Validation](#security-and-validation)
7. [Building Protocol Extensions](#building-protocol-extensions)
8. [Advanced Patterns](#advanced-patterns)
9. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Prerequisites

- Node.js >= 22.0.0
- A running `P2PCoordinator` with DHT enabled
- Understanding of the core P2P layer (see `lib/p2p/HOWTO.md`)

### Installation

The discovery module is part of the Lotus SDK:

```typescript
import {
  DHTAdvertiser,
  DHTDiscoverer,
  DiscoverySecurityValidator,
  createDiscoverySystem,
  DiscoveryCriteria,
  DiscoveryAdvertisement,
} from 'lotus-sdk/lib/p2p/discovery'
```

### Basic Setup

```typescript
import { P2PCoordinator } from 'lotus-sdk/lib/p2p'
import { createDiscoverySystem } from 'lotus-sdk/lib/p2p/discovery'

// 1. Create and start P2P coordinator with DHT
const coordinator = new P2PCoordinator({
  listen: ['/ip4/0.0.0.0/tcp/0'],
  enableDHT: true,
  bootstrapPeers: ['/dns4/bootstrap.lotusia.org/tcp/4001/p2p/12D3KooW...'],
})
await coordinator.start()

// 2. Create discovery system
const discovery = createDiscoverySystem(coordinator, {
  defaultTTL: 30 * 60 * 1000, // 30 minutes
  enableAutoRefresh: true,
  refreshInterval: 20 * 60 * 1000, // 20 minutes
})

// 3. Start discovery
await discovery.start()

console.log('Discovery system ready!')

// 4. Cleanup on shutdown
process.on('SIGINT', async () => {
  await discovery.stop()
  await coordinator.stop()
  process.exit(0)
})
```

---

## Understanding the Architecture

### Component Relationships

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Application                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Discovery System                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Advertiser  │  │ Discoverer  │  │ Security Validator  │  │
│  │             │  │             │  │                     │  │
│  │ Publishes   │  │ Queries     │  │ Validates all       │  │
│  │ to DHT      │  │ from DHT    │  │ advertisements      │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    P2PCoordinator                            │
│                         │                                    │
│                    Kad-DHT                                   │
│              (Distributed Hash Table)                        │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Advertising**: Your app → Advertiser → DHT (persistence) + GossipSub (real-time) → Network
2. **One-time Discovery**: Your app → Discoverer → DHT → Security Validator → Your app
3. **Subscriptions**: GossipSub → Security Validator → Callback (event-driven, no polling)

### Key Concepts

| Concept           | Description                                      |
| ----------------- | ------------------------------------------------ |
| **Advertisement** | A signed record describing a peer's capabilities |
| **Criteria**      | Filters used to find matching advertisements     |
| **Subscription**  | Continuous discovery with callback notifications |
| **Reputation**    | Score tracking peer reliability                  |
| **TTL**           | Time-to-live before advertisement expires        |

---

## Advertising Capabilities

### Creating an Advertisement

```typescript
const { advertiser } = discovery

// Advertise your capabilities
const adId = await advertiser.advertise({
  protocol: 'my-protocol',
  peerId: coordinator.peerId,
  capabilities: ['signing', 'relay', 'storage'],
  metadata: {
    version: '1.0.0',
    maxConnections: 100,
    supportedFormats: ['json', 'protobuf'],
  },
})

console.log('Advertisement ID:', adId)
```

### Advertisement with Location

```typescript
const adId = await advertiser.advertise({
  protocol: 'my-protocol',
  peerId: coordinator.peerId,
  capabilities: ['signing'],
  location: {
    latitude: 37.7749,
    longitude: -122.4194,
  },
  metadata: {
    region: 'us-west',
  },
})
```

### Managing Advertisements

```typescript
// Check active advertisements
const activeAds = advertiser.getActiveAdvertisements()
console.log('Active advertisements:', activeAds)

// Check if specific advertisement is active
if (advertiser.isAdvertisementActive(adId)) {
  console.log('Advertisement is still active')
}

// Refresh advertisement (reset TTL)
await advertiser.refresh(adId)

// Withdraw advertisement
await advertiser.withdraw(adId)
```

### Auto-Refresh

When `enableAutoRefresh` is true, advertisements are automatically refreshed before expiration:

```typescript
const discovery = createDiscoverySystem(coordinator, {
  enableAutoRefresh: true,
  refreshInterval: 20 * 60 * 1000, // Refresh every 20 minutes
  defaultTTL: 30 * 60 * 1000, // TTL is 30 minutes
})

// Advertisement will be refreshed automatically
const adId = await discovery.advertiser.advertise({
  protocol: 'my-protocol',
  peerId: coordinator.peerId,
  capabilities: ['signing'],
})

// No need to manually refresh - it's automatic!
```

---

## Discovering Peers

### Basic Discovery

```typescript
const { discoverer } = discovery

// Find all peers with a specific protocol
const peers = await discoverer.discover({
  protocol: 'my-protocol',
})

console.log(`Found ${peers.length} peers`)
for (const peer of peers) {
  console.log(`  - ${peer.peerId}: ${peer.capabilities.join(', ')}`)
}
```

### Discovery with Filters

```typescript
// Find peers with specific capabilities
const signers = await discoverer.discover({
  protocol: 'musig2',
  capabilities: ['signer'],
})

// Find peers with minimum reputation
const reputablePeers = await discoverer.discover({
  protocol: 'my-protocol',
  minReputation: 70,
})

// Find peers near a location
const nearbyPeers = await discoverer.discover({
  protocol: 'my-protocol',
  location: {
    latitude: 37.7749,
    longitude: -122.4194,
    radiusKm: 100,
  },
})

// Custom criteria (protocol-specific)
const customPeers = await discoverer.discover({
  protocol: 'musig2',
  custom: {
    transactionTypes: ['spend', 'coinjoin'],
    minAmount: 1000000,
    maxAmount: 100000000,
  },
})
```

### Processing Discovery Results

```typescript
const peers = await discoverer.discover({
  protocol: 'musig2',
  capabilities: ['signer'],
})

for (const peer of peers) {
  console.log('Peer ID:', peer.peerId)
  console.log('Capabilities:', peer.capabilities)
  console.log('Reputation:', peer.reputation)
  console.log('Expires at:', new Date(peer.expiresAt))
  console.log('Metadata:', peer.metadata)
  console.log('---')
}
```

### Cache Management

```typescript
// Get cache statistics
const stats = discoverer.getCacheStats()
console.log('Cache size:', stats.size)
console.log('Cache hits:', stats.hits)
console.log('Cache misses:', stats.misses)
console.log('Hit rate:', (stats.hitRate * 100).toFixed(1) + '%')

// Clear cache for a specific protocol
discoverer.clearCache('musig2')

// Clear entire cache
discoverer.clearCache()
```

---

## Subscriptions

Subscriptions provide **real-time, event-driven** discovery using GossipSub pub/sub.
Unlike polling-based approaches, callbacks are invoked **immediately** when new advertisements are published.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GossipSub Subscription Flow                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. subscribe() → Subscribe to GossipSub topic (lotus/discovery/{protocol}) │
│  2. Optionally fetch existing advertisements from DHT                       │
│  3. When any peer advertises → GossipSub delivers message instantly         │
│  4. Callback invoked immediately (no polling delay)                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Creating a Subscription

```typescript
const { discoverer } = discovery

// Subscribe to signer discoveries (real-time via GossipSub)
const subscription = await discoverer.subscribe(
  {
    protocol: 'musig2',
    capabilities: ['signer'],
    minReputation: 50,
  },
  advertisement => {
    // Called INSTANTLY when a new signer advertises
    console.log('New signer discovered:', advertisement.peerInfo.peerId)
    console.log('Capabilities:', advertisement.capabilities)
  },
  {
    fetchExisting: true, // Also get existing from DHT on subscribe
    deduplicate: true, // Don't notify for same ad twice
  },
)

console.log('Subscription ID:', subscription.id)
console.log('GossipSub topic:', subscription.topic)
```

### Managing Subscriptions

```typescript
// Get active subscriptions
const activeSubscriptions = discoverer.getActiveSubscriptions()
console.log('Active subscriptions:', activeSubscriptions)

// Unsubscribe (also unsubscribes from GossipSub topic)
await discoverer.unsubscribe(subscription.id)
```

### Subscription Patterns

**Pattern 1: Maintain a Peer List**

```typescript
const knownPeers = new Map<string, DiscoveryAdvertisement>()

await discoverer.subscribe(
  { protocol: 'my-protocol' },
  advertisement => {
    // Called for each new advertisement
    knownPeers.set(advertisement.peerInfo.peerId, advertisement)
    console.log(`Known peers: ${knownPeers.size}`)
  },
  { fetchExisting: true, deduplicate: true },
)
```

**Pattern 2: React to New Peers**

```typescript
// With deduplicate: true, you only get notified once per advertisement
await discoverer.subscribe(
  { protocol: 'my-protocol' },
  advertisement => {
    // This is called exactly once per unique advertisement
    console.log('New peer discovered:', advertisement.peerInfo.peerId)
    handleNewPeer(advertisement)
  },
  { fetchExisting: true, deduplicate: true },
)
```

**Pattern 3: Filter by Metadata**

```typescript
await discoverer.subscribe(
  {
    protocol: 'musig2',
    capabilities: ['signer'],
  },
  advertisement => {
    // Filter by additional metadata criteria
    const meta = advertisement.metadata as any
    if (meta.fee <= 1000 && meta.averageResponseTime < 500) {
      console.log('Found eligible signer:', advertisement.peerInfo.peerId)
      handleEligibleSigner(advertisement)
    }
  },
  { fetchExisting: true, deduplicate: true },
)
```

### Why GossipSub Instead of Polling?

| Aspect       | Polling (Old)                   | GossipSub (New)            |
| ------------ | ------------------------------- | -------------------------- |
| Latency      | Poll interval (seconds/minutes) | Near-instant               |
| Efficiency   | Wastes resources on empty polls | Only processes new data    |
| Scalability  | O(n) queries per interval       | O(1) per new advertisement |
| Architecture | Anti-pattern for libp2p         | Native libp2p pattern      |

---

## Security and Validation

### Understanding the Security Layer

The security validator performs several checks on every advertisement:

1. **Signature Verification**: Ensures the advertisement was signed by the claimed peer
2. **Timestamp Validation**: Rejects stale or future-dated advertisements
3. **Replay Prevention**: Tracks seen advertisements to prevent replay attacks
4. **Reputation Check**: Filters by minimum reputation score
5. **Rate Limiting**: Prevents spam from any single peer

### Configuring Security

```typescript
import { DiscoverySecurityValidator } from 'lotus-sdk/lib/p2p/discovery'

const validator = new DiscoverySecurityValidator({
  requireSignature: true,
  minReputation: 0,
  maxTimestampSkew: 5 * 60 * 1000, // 5 minutes
  enableReplayPrevention: true,
  maxAdvertisementsPerMinute: 10,
  maxDiscoveriesPerMinute: 60,
})
```

### Manual Validation

```typescript
const { securityValidator } = discovery

// Validate an advertisement manually
const result = await securityValidator.validateAdvertisement(advertisement)

if (result.valid) {
  console.log('Valid advertisement')
  console.log('Security score:', result.securityScore)
  console.log('Details:', result.details)
} else {
  console.log('Invalid advertisement:', result.reason)
}
```

### Managing Reputation

```typescript
const { securityValidator } = discovery

// Get peer reputation
const reputation = securityValidator.getPeerReputation(peerId)
console.log('Score:', reputation.score)
console.log('Total interactions:', reputation.totalInteractions)
console.log('Successful:', reputation.successfulInteractions)
console.log('Failed:', reputation.failedInteractions)

// Update reputation after interaction
securityValidator.updateReputation(peerId, 10) // Success: +10
securityValidator.updateReputation(peerId, -20) // Failure: -20
```

### Rate Limiting

```typescript
const { securityValidator } = discovery

// Check if action is allowed
if (securityValidator.checkRateLimit(peerId, 'advertise')) {
  await advertiser.advertise(ad)
} else {
  console.log('Rate limited, try again later')
}

// Get security statistics
const stats = securityValidator.getSecurityStats()
console.log('Total validations:', stats.totalValidations)
console.log('Rejected:', stats.rejected)
console.log('Rate limited:', stats.rateLimited)
```

### Custom Validators

```typescript
import { createSecurityPolicy } from 'lotus-sdk/lib/p2p/discovery'

const policy = createSecurityPolicy('musig2', {
  customValidators: [
    {
      name: 'amount-range',
      validate: async ad => {
        const meta = ad.metadata as any
        if (meta.minAmount && meta.maxAmount) {
          return meta.minAmount < meta.maxAmount
        }
        return true
      },
    },
    {
      name: 'public-key-format',
      validate: async ad => {
        const meta = ad.metadata as any
        if (meta.publicKey) {
          return /^0[23][0-9a-fA-F]{64}$/.test(meta.publicKey)
        }
        return true
      },
    },
  ],
})

const validator = new DiscoverySecurityValidator(policy)
```

---

## Building Protocol Extensions

The discovery layer is designed to be extended for protocol-specific use cases.

### Step 1: Define Types

```typescript
import {
  DiscoveryCriteria,
  DiscoveryAdvertisement,
} from 'lotus-sdk/lib/p2p/discovery'

// Protocol-specific criteria
interface MyProtocolCriteria extends DiscoveryCriteria {
  protocol: 'my-protocol'
  serviceType?: 'compute' | 'storage' | 'relay'
  minCapacity?: number
  maxLatency?: number
}

// Protocol-specific advertisement
interface MyProtocolAdvertisement extends DiscoveryAdvertisement {
  protocol: 'my-protocol'
  metadata: {
    serviceType: 'compute' | 'storage' | 'relay'
    capacity: number
    latency: number
    price: number
  }
}
```

### Step 2: Create Extension Class

```typescript
import { EventEmitter } from 'events'
import {
  DHTAdvertiser,
  DHTDiscoverer,
  DiscoverySecurityValidator,
} from 'lotus-sdk/lib/p2p/discovery'
import { P2PCoordinator } from 'lotus-sdk/lib/p2p'

interface MyProtocolConfig {
  defaultTTL?: number
  enableAutoRefresh?: boolean
}

class MyProtocolDiscovery extends EventEmitter {
  private advertiser: DHTAdvertiser
  private discoverer: DHTDiscoverer
  private validator: DiscoverySecurityValidator
  private coordinator: P2PCoordinator
  private config: MyProtocolConfig

  constructor(coordinator: P2PCoordinator, config: MyProtocolConfig = {}) {
    super()
    this.coordinator = coordinator
    this.config = config
    this.validator = new DiscoverySecurityValidator()
    this.advertiser = new DHTAdvertiser(coordinator, this.validator, {
      defaultTTL: config.defaultTTL ?? 30 * 60 * 1000,
      enableAutoRefresh: config.enableAutoRefresh ?? true,
    })
    this.discoverer = new DHTDiscoverer(coordinator, this.validator)
  }

  async start(): Promise<void> {
    await this.advertiser.start()
    await this.discoverer.start()
  }

  async stop(): Promise<void> {
    await this.advertiser.stop()
    await this.discoverer.stop()
  }

  async advertiseService(
    serviceType: 'compute' | 'storage' | 'relay',
    options: {
      capacity: number
      latency: number
      price: number
    },
  ): Promise<string> {
    const adId = await this.advertiser.advertise({
      protocol: 'my-protocol',
      peerId: this.coordinator.peerId,
      capabilities: [serviceType],
      metadata: {
        serviceType,
        ...options,
      },
    })

    this.emit('service:advertised', { adId, serviceType })
    return adId
  }

  async discoverServices(
    criteria: Partial<MyProtocolCriteria>,
  ): Promise<MyProtocolAdvertisement[]> {
    const ads = await this.discoverer.discover({
      protocol: 'my-protocol',
      ...criteria,
    })

    // Filter by protocol-specific criteria
    return ads.filter(ad => {
      const meta = ad.metadata as MyProtocolAdvertisement['metadata']

      if (criteria.serviceType && meta.serviceType !== criteria.serviceType) {
        return false
      }
      if (criteria.minCapacity && meta.capacity < criteria.minCapacity) {
        return false
      }
      if (criteria.maxLatency && meta.latency > criteria.maxLatency) {
        return false
      }

      return true
    }) as MyProtocolAdvertisement[]
  }

  async subscribeToServices(
    criteria: Partial<MyProtocolCriteria>,
    callback: (services: MyProtocolAdvertisement[]) => void,
  ): Promise<string> {
    return this.discoverer.subscribe(
      { protocol: 'my-protocol', ...criteria },
      ads => {
        const filtered = this.filterByCriteria(ads, criteria)
        callback(filtered as MyProtocolAdvertisement[])
      },
      { pollInterval: 60000 },
    )
  }

  private filterByCriteria(
    ads: DiscoveryAdvertisement[],
    criteria: Partial<MyProtocolCriteria>,
  ): DiscoveryAdvertisement[] {
    return ads.filter(ad => {
      const meta = ad.metadata as MyProtocolAdvertisement['metadata']
      if (criteria.serviceType && meta.serviceType !== criteria.serviceType) {
        return false
      }
      if (criteria.minCapacity && meta.capacity < criteria.minCapacity) {
        return false
      }
      if (criteria.maxLatency && meta.latency > criteria.maxLatency) {
        return false
      }
      return true
    })
  }
}
```

### Step 3: Use the Extension

```typescript
const myDiscovery = new MyProtocolDiscovery(coordinator, {
  defaultTTL: 60 * 60 * 1000, // 1 hour
  enableAutoRefresh: true,
})

await myDiscovery.start()

// Advertise a service
const adId = await myDiscovery.advertiseService('compute', {
  capacity: 1000,
  latency: 50,
  price: 100,
})

// Discover services
const services = await myDiscovery.discoverServices({
  serviceType: 'compute',
  minCapacity: 500,
  maxLatency: 100,
})

// Subscribe to services
await myDiscovery.subscribeToServices({ serviceType: 'storage' }, services => {
  console.log(`Found ${services.length} storage services`)
})
```

---

## Advanced Patterns

### Pattern 1: Discovery with Fallback

```typescript
async function discoverWithFallback(
  discoverer: DHTDiscoverer,
  criteria: DiscoveryCriteria,
  fallbackPeers: string[],
): Promise<DiscoveryAdvertisement[]> {
  try {
    const peers = await discoverer.discover(criteria)
    if (peers.length > 0) {
      return peers
    }
  } catch (error) {
    console.warn('DHT discovery failed:', error)
  }

  // Fallback to known peers
  console.log('Using fallback peers')
  return fallbackPeers.map(peerId => ({
    id: `fallback-${peerId}`,
    protocol: criteria.protocol,
    peerId,
    capabilities: [],
    timestamp: Date.now(),
    expiresAt: Date.now() + 60000,
  }))
}
```

### Pattern 2: Load-Balanced Discovery

```typescript
async function discoverWithLoadBalancing(
  discoverer: DHTDiscoverer,
  criteria: DiscoveryCriteria,
  count: number,
): Promise<DiscoveryAdvertisement[]> {
  const allPeers = await discoverer.discover(criteria)

  // Sort by reputation and latency (if available)
  const sorted = allPeers.sort((a, b) => {
    const repA = a.reputation ?? 50
    const repB = b.reputation ?? 50
    const latA = (a.metadata as any)?.latency ?? 100
    const latB = (b.metadata as any)?.latency ?? 100

    // Higher reputation and lower latency is better
    return repB - repA + (latA - latB) / 10
  })

  // Return top N peers
  return sorted.slice(0, count)
}
```

### Pattern 3: Retry with Exponential Backoff

```typescript
async function discoverWithRetry(
  discoverer: DHTDiscoverer,
  criteria: DiscoveryCriteria,
  maxRetries: number = 3,
): Promise<DiscoveryAdvertisement[]> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const peers = await discoverer.discover(criteria)
      if (peers.length > 0) {
        return peers
      }

      // No peers found, wait and retry
      const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, delay))
    } catch (error) {
      lastError = error as Error
      const delay = Math.pow(2, attempt) * 1000
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  if (lastError) {
    throw lastError
  }

  return []
}
```

### Pattern 4: Peer Health Monitoring

```typescript
class PeerHealthMonitor {
  private healthScores = new Map<string, number>()
  private lastCheck = new Map<string, number>()

  constructor(
    private discoverer: DHTDiscoverer,
    private validator: DiscoverySecurityValidator,
  ) {}

  async checkHealth(peerId: string): Promise<number> {
    const now = Date.now()
    const lastCheckTime = this.lastCheck.get(peerId) ?? 0

    // Don't check too frequently
    if (now - lastCheckTime < 60000) {
      return this.healthScores.get(peerId) ?? 50
    }

    this.lastCheck.set(peerId, now)

    // Get reputation from validator
    const reputation = this.validator.getPeerReputation(peerId)

    // Calculate health score
    const successRate =
      reputation.totalInteractions > 0
        ? reputation.successfulInteractions / reputation.totalInteractions
        : 0.5

    const healthScore = Math.round(successRate * 100)
    this.healthScores.set(peerId, healthScore)

    return healthScore
  }

  async getHealthyPeers(
    criteria: DiscoveryCriteria,
    minHealth: number = 70,
  ): Promise<DiscoveryAdvertisement[]> {
    const peers = await this.discoverer.discover(criteria)

    const healthyPeers: DiscoveryAdvertisement[] = []
    for (const peer of peers) {
      const health = await this.checkHealth(peer.peerId)
      if (health >= minHealth) {
        healthyPeers.push(peer)
      }
    }

    return healthyPeers
  }
}
```

---

## Troubleshooting

### DHT Not Finding Peers

**Issue**: `discover()` returns empty array

**Checklist**:

1. Ensure DHT is enabled: `enableDHT: true`
2. Connect to bootstrap peers
3. Wait for DHT to propagate (~5-10 seconds)
4. Check if peers are actually advertising

```typescript
// Debug DHT status
const dhtStats = coordinator.getDHTStats()
console.log('DHT mode:', dhtStats.mode)
console.log('Routing table size:', dhtStats.routingTableSize)
console.log('Is ready:', dhtStats.isReady)

// Check cache
const cacheStats = discoverer.getCacheStats()
console.log('Cache size:', cacheStats.size)
```

### Advertisements Not Persisting

**Issue**: Advertisements disappear quickly

**Checklist**:

1. Check TTL configuration
2. Ensure auto-refresh is enabled
3. Verify advertiser is still running

```typescript
// Check active advertisements
const activeAds = advertiser.getActiveAdvertisements()
console.log('Active advertisements:', activeAds)

// Manually refresh
await advertiser.refresh(adId)
```

### Signature Validation Failing

**Issue**: Advertisements rejected with "Invalid signature"

**Checklist**:

1. Ensure the signing key matches the peer ID
2. Check timestamp is within allowed skew
3. Verify the advertisement hasn't been modified

```typescript
// Validate manually
const result = await validator.validateAdvertisement(ad)
console.log('Valid:', result.valid)
console.log('Reason:', result.reason)
console.log('Details:', result.details)
```

### Rate Limiting Issues

**Issue**: "Rate limited" errors

**Solution**: Reduce advertisement frequency or increase limits

```typescript
const validator = new DiscoverySecurityValidator({
  maxAdvertisementsPerMinute: 20, // Increase from default 10
})
```

### Memory Usage Growing

**Issue**: Memory usage increases over time

**Solution**: Clear cache periodically and check for subscription leaks

```typescript
// Clear cache
discoverer.clearCache()

// Check active subscriptions
const subs = discoverer.getActiveSubscriptions()
console.log('Active subscriptions:', subs.length)

// Unsubscribe from unused subscriptions
for (const subId of unusedSubscriptions) {
  await discoverer.unsubscribe(subId)
}
```

---

## Next Steps

- Review the [README.md](./README.md) for API reference
- Check [MuSig2 Discovery](../musig2/DISCOVERY_README.md) for a complete extension example
- See [DHT Discovery Implementation Status](../../docs/DHT_DISCOVERY_IMPLEMENTATION_STATUS.md) for roadmap
- Run the test files for more examples

---

## License

MIT License - Copyright 2025 The Lotusia Stewardship
