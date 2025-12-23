# MuSig2 Discovery System

MuSig2-specific extension of the core P2P discovery layer, enabling decentralized signer advertisement and signing request discovery.

## Overview

The MuSig2 Discovery System provides:

- **Signer Advertisement**: Advertise signing capabilities and availability
- **Signer Discovery**: Find available signers by transaction type, amount, and other criteria
- **Signing Request Creation**: Publish signing requests to the DHT
- **Signing Request Discovery**: Discover pending signing requests
- **Security Validation**: MuSig2-specific security checks and validation
- **Optional Integration**: Discovery is entirely optional and doesn't break existing code

## Architecture

```
musig2/
├── discovery-types.ts          # MuSig2-specific discovery types
├── discovery-extension.ts      # MuSig2Discovery class
├── discovery-security.ts       # Security validators
├── discovery-index.ts          # Public exports
└── coordinator.ts              # Integrated with MuSig2P2PCoordinator
```

### Hybrid DHT + GossipSub Model

The discovery system uses a hybrid approach:

- **DHT (Kad-DHT)**: Persistent storage for advertisements, used for one-time queries
- **GossipSub**: Real-time pub/sub for instant notifications when new advertisements are published

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Discovery Data Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ADVERTISING:                                                                │
│    advertiseSigner() → DHT PUT (persistence) + GossipSub PUBLISH (realtime) │
│                                                                              │
│  ONE-TIME DISCOVERY:                                                         │
│    discoverSigners() → DHT GET (queries stored advertisements)               │
│                                                                              │
│  REAL-TIME SUBSCRIPTIONS:                                                    │
│    subscribeToSigners() → GossipSub SUBSCRIBE (instant callbacks)            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Usage

### Initializing Discovery

Discovery is optional and initialized via the coordinator constructor:

```typescript
import { MuSig2P2PCoordinator } from './lib/p2p/musig2/index.js'

const coordinator = new MuSig2P2PCoordinator(
  p2pConfig,
  musig2Config,
  securityConfig,
  discoveryConfig, // Optional - enables discovery layer
)

await coordinator.start()
```

### Advertising as a Signer

```typescript
import { TransactionType } from './lib/p2p/musig2/index.js'

const discovery = coordinator.getDiscovery()

if (discovery) {
  const adId = await discovery.advertiseSigner(
    myPublicKey,
    [TransactionType.SPEND, TransactionType.SWAP],
    {
      amountRange: { min: 1000000, max: 100000000 },
      metadata: {
        nickname: 'My Signer',
        fee: 1000,
        averageResponseTime: 500,
      },
    },
  )

  console.log('Advertised as signer:', adId)
}
```

### Discovering Signers (One-Time Query)

```typescript
// One-time DHT query for current signers
const signers = await discovery.discoverSigners({
  transactionTypes: [TransactionType.SPEND],
  minAmount: 5000000,
  maxAmount: 50000000,
  minReputation: 70,
})

console.log(`Found ${signers.length} available signers`)
```

### Subscribing to Signers (Real-Time)

```typescript
// Subscribe for real-time notifications via GossipSub
// Callback is invoked INSTANTLY when new signers advertise
const subscriptionId = await discovery.subscribeToSigners(
  {
    transactionTypes: [TransactionType.SPEND],
    minReputation: 70,
  },
  signer => {
    // Called immediately when a new signer advertises
    console.log('New signer discovered:', signer.peerInfo.peerId)
    console.log('Transaction types:', signer.transactionTypes)
  },
)

// Later: unsubscribe when done
await discovery.unsubscribe(subscriptionId)
```

### Creating a Signing Request

```typescript
const requestId = await discovery.createSigningRequest(
  requiredPublicKeys,
  messageHash,
  {
    metadata: {
      transactionHex: txHex,
      amount: 10000000,
      transactionType: TransactionType.SPEND,
      purpose: 'Collaborative transaction',
    },
  },
)

console.log('Created signing request:', requestId)
```

### Discovering Signing Requests (One-Time Query)

```typescript
// One-time DHT query for current signing requests
const requests = await discovery.discoverSigningRequests({
  transactionType: TransactionType.SPEND,
  amountRange: { min: 1000000, max: 100000000 },
  includesPublicKeys: [myPublicKey.toString()],
})

console.log(`Found ${requests.length} signing requests`)
```

### Subscribing to Signing Requests (Real-Time)

```typescript
// Subscribe for real-time notifications via GossipSub
const subscriptionId = await discovery.subscribeToSigningRequests(
  {
    includesPublicKeys: [myPublicKey.toString()],
  },
  request => {
    // Called immediately when a new signing request is created
    console.log('New signing request:', request.requestId)
    console.log('Required signers:', request.requiredPublicKeys.length)

    // Auto-join if we're a required signer
    discovery.joinSigningRequest(request.requestId, myPublicKey)
  },
)
```

### Joining a Signing Request

```typescript
for (const request of requests) {
  if (request.requiredPublicKeys.includes(myPublicKey.toString())) {
    await discovery.joinSigningRequest(request.requestId, myPublicKey)
    console.log('Joined signing request:', request.requestId)
  }
}
```

## Features

### Type Safety

All discovery types are fully typed with TypeScript:

```typescript
interface MuSig2SignerCriteria extends DiscoveryCriteria {
  protocol: 'musig2'
  transactionTypes?: TransactionType[]
  minAmount?: number
  maxAmount?: number
  requiredPublicKeys?: string[]
  minMaturation?: number
  minTotalBurned?: number
}
```

### Security Validation

MuSig2-specific security checks:

- Advertisement structure validation
- Signature verification
- Amount range validation
- Transaction type compatibility
- Burn-based identity validation (optional)

```typescript
import { MuSig2DiscoverySecurityValidator } from './lib/p2p/musig2/index.js'

const validator = new MuSig2DiscoverySecurityValidator()
const result = await validator.validateAdvertisement(advertisement)

if (result.valid) {
  console.log('Valid advertisement, security score:', result.securityScore)
}
```

### Event System

Discovery emits events for monitoring:

```typescript
discovery.on(MuSig2Event.SIGNER_ADVERTISED, ad => {
  console.log('Signer advertised:', ad)
})

discovery.on(MuSig2Event.SIGNER_DISCOVERED, ad => {
  console.log('Signer discovered:', ad)
})

discovery.on(MuSig2Event.SIGNING_REQUEST_RECEIVED, req => {
  console.log('Signing request received:', req)
})
```

### Automatic Refresh

Auto-refresh keeps advertisements alive:

```typescript
const discoveryConfig = {
  enableAutoRefresh: true,
  signerRefreshInterval: 20 * 60 * 1000, // 20 minutes
}
```

## Configuration

### Default Configuration

```typescript
const DEFAULT_MUSIG2_DISCOVERY_CONFIG = {
  signerKeyPrefix: 'musig2:signer:',
  requestKeyPrefix: 'musig2:request:',
  signerTTL: 30 * 60 * 1000, // 30 minutes
  requestTTL: 10 * 60 * 1000, // 10 minutes
  enableBurnValidation: false,
  minBurnAmount: 50_000_000, // 50 XPI
  chronikUrl: 'https://chronik.lotusia.org',
  enableAutoRefresh: true,
  signerRefreshInterval: 20 * 60 * 1000, // 20 minutes
  maxConcurrentRequests: 5,
}
```

### Custom Configuration

```typescript
const customConfig: Partial<MuSig2DiscoveryConfig> = {
  signerTTL: 60 * 60 * 1000, // 1 hour
  enableBurnValidation: true,
  minBurnAmount: 100_000_000, // 100 XPI
  maxConcurrentRequests: 10,
}
```

## Backwards Compatibility

The discovery system is **entirely optional**:

- Existing code continues to work without any changes
- Discovery is only active if `discoveryConfig` is provided to the coordinator
- All existing coordinator methods remain unchanged
- No breaking changes to the MuSig2 API

```typescript
// Without discovery (existing code works as before)
const coordinator = new MuSig2P2PCoordinator(p2pConfig, musig2Config)

// With discovery (new functionality)
const coordinator = new MuSig2P2PCoordinator(
  p2pConfig,
  musig2Config,
  securityConfig,
  discoveryConfig,
)
```

## Testing

While core functionality is complete, comprehensive tests are pending:

- Unit tests for type validation
- Integration tests for discovery flow
- Security tests for validation
- Performance tests under load

## Subscription vs Polling

| Aspect    | discoverSigners() | subscribeToSigners()   |
| --------- | ----------------- | ---------------------- |
| Mechanism | DHT query         | GossipSub subscription |
| Latency   | On-demand         | Near-instant           |
| Use Case  | Get current state | React to new signers   |
| Resources | Per-call overhead | Persistent connection  |

**Recommendation**: Use subscriptions for real-time applications (e.g., waiting for signers to join). Use one-time discovery for initial state or periodic checks.

## Next Steps

See `docs/DHT_DISCOVERY_IMPLEMENTATION_STATUS.md` for:

- Current implementation status
- Pending features
- Testing requirements
