# MuSig2 P2P Coordination Module

A production-ready, event-driven P2P coordination layer for MuSig2 multi-signature sessions over libp2p networks. Implements MuSig2 specification with ν ≥ 2 nonces.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Module Structure](#module-structure)
- [Core Components](#core-components)
- [Protocol Flow](#protocol-flow)
- [Security Model](#security-model)
- [Discovery System](#discovery-system)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Events](#events)
- [Error Handling](#error-handling)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MuSig2P2PCoordinator                                 │
│  Session Management │ Nonce Coordination │ Signature Aggregation            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────────────┐
│ MuSig2Protocol    │   │ MuSig2Security    │   │ MuSig2Discovery           │
│ Handler           │   │ Validator         │   │ (Optional)                │
│                   │   │                   │   │                           │
│ • Message routing │   │ • DoS protection  │   │ • DHT signer advertising  │
│ • Payload valid.  │   │ • Peer blocking   │   │ • Signing request publish │
│ • Event emission  │   │ • Timestamp skew  │   │ • Criteria-based search   │
└───────────────────┘   └───────────────────┘   └───────────────────────────┘
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           P2PCoordinator (Base)                             │
│  GossipSub (Announcements) │ Direct P2P (Coordination) │ DHT (Discovery)   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Event-Driven Architecture** - All coordination flows through typed events
2. **Separation of Concerns** - Clear boundaries between security, validation, and business logic
3. **MuSig2 Specification Compliance** - Supports ν ≥ 2 nonces per signer
4. **Deterministic Coordinator Election** - No additional communication required
5. **Automatic Failover** - Backup coordinator promotion on timeout

---

## Module Structure

```
lib/p2p/musig2/
├── index.ts                 # Public exports
├── coordinator.ts           # MuSig2P2PCoordinator - session management & egress validation
├── protocol.ts              # MuSig2ProtocolHandler - ingress validation (single point)
├── security.ts              # MuSig2SecurityValidator - security constraints only
├── validation.ts            # Pure payload validator functions
├── serialization.ts         # Point/BN/PublicKey serialization
├── election.ts              # Deterministic coordinator election
├── errors.ts                # Custom error classes
├── types.ts                 # TypeScript interfaces and enums
├── discovery-extension.ts   # MuSig2Discovery - DHT-based discovery
├── discovery-types.ts       # Discovery-specific types
├── discovery-security.ts    # Discovery security validation
└── discovery-index.ts       # Discovery module exports
```

---

## Core Components

### MuSig2P2PCoordinator

The main orchestrator managing MuSig2 signing sessions over P2P networks.

**Responsibilities:**

- Session lifecycle management (create, announce, abort, finalize)
- Nonce exchange coordination (MuSig2 Round 1)
- Partial signature collection (MuSig2 Round 2)
- Coordinator election and failover
- Participant tracking and timeout management

### MuSig2ProtocolHandler

Implements `IProtocolHandler` for MuSig2-specific message routing.

**Protocol ID:** `/lotus/musig2/1.0.0`

**Message Types:**

| Type                   | Direction  | Purpose                           |
| ---------------------- | ---------- | --------------------------------- |
| `SESSION_ANNOUNCEMENT` | GossipSub  | Announce new session              |
| `SESSION_JOIN`         | Direct P2P | Request to join session           |
| `SESSION_JOIN_ACK`     | Direct P2P | Accept/reject join request        |
| `NONCE_SHARE`          | Direct P2P | Share public nonces (Round 1)     |
| `PARTIAL_SIG_SHARE`    | Direct P2P | Share partial signature (Round 2) |
| `SESSION_ABORT`        | Direct P2P | Abort notification                |
| `SESSION_COMPLETE`     | Direct P2P | Completion notification           |

### MuSig2SecurityValidator

Protocol-specific security constraint enforcement implementing `IProtocolValidator`.

**Responsibilities (Security Constraints Only):**

- Message size limits (100KB default, DoS protection)
- Timestamp skew validation (5 minutes default)
- Peer violation tracking and automatic blocking
- Session announcement validation

**Note:** Payload structure validation is handled by `protocol.ts`, not `security.ts`.
This separation prevents double validation and maintains clear concerns.

### Coordinator Election

Deterministic election ensuring all participants agree on coordinator without communication.

| Method          | Description                            |
| --------------- | -------------------------------------- |
| `LEXICOGRAPHIC` | First signer in sorted order (default) |
| `HASH_BASED`    | SHA256-based pseudo-random selection   |
| `FIRST_SIGNER`  | First in sorted array                  |
| `LAST_SIGNER`   | Last in sorted array                   |

### Serialization Layer

Network-safe serialization for cryptographic objects.

| Object         | Format                              |
| -------------- | ----------------------------------- |
| `Point`        | 33-byte compressed hex              |
| `BN`           | 32-byte big-endian hex              |
| `PublicKey`    | 33-byte compressed hex              |
| `PublicNonces` | `{ r1: hex, r2: hex, ... rN: hex }` |

---

## Protocol Flow

### Session Phases

```typescript
enum MuSigSessionPhase {
  INIT                    // Session created, awaiting participants
  NONCE_EXCHANGE          // Round 1: Collecting nonces
  PARTIAL_SIG_EXCHANGE    // Round 2: Collecting partial signatures
  COMPLETE                // Signature aggregated successfully
  ABORTED                 // Session terminated
}
```

### Signing Flow

1. **Session Creation** - Coordinator creates session with sorted signers
2. **Announcement** - Session published to GossipSub topic
3. **Join** - Participants send join requests, receive acknowledgments
4. **Round 1** - All signers share ν ≥ 2 public nonces
5. **Round 2** - All signers share partial signatures
6. **Finalization** - Coordinator aggregates signatures, broadcasts transaction

### Complete Message Flow

```
┌─────────────────┐                              ┌─────────────────┐
│   Coordinator   │                              │   Participant   │
└────────┬────────┘                              └────────┬────────┘
         │                                                │
         │  1. createSession()                            │
         │  2. announceSession()                          │
         │         ─────────────────────────────────────► │
         │              SESSION_ANNOUNCEMENT (GossipSub)  │
         │                                                │
         │                                    3. joinSession()
         │         ◄───────────────────────────────────── │
         │              SESSION_JOIN (Direct P2P)         │
         │                                                │
         │  4. _handleSessionJoin()                       │
         │         ─────────────────────────────────────► │
         │              SESSION_JOIN_ACK (Direct P2P)     │
         │                                                │
         │  5. shareNonces()                  shareNonces()
         │         ◄──────────────────────────────────────┤
         │              NONCE_SHARE (Direct P2P)          │
         │         ────────────────────────────────────►  │
         │                                                │
         │  6. sharePartialSignature()  sharePartialSignature()
         │         ◄──────────────────────────────────────┤
         │              PARTIAL_SIG_SHARE (Direct P2P)    │
         │         ────────────────────────────────────►  │
         │                                                │
         │  7. finalizeSession()                          │
         │         ─────────────────────────────────────► │
         │              SESSION_COMPLETE (Direct P2P)     │
         │                                                │
```

---

## Security Model

### Architectural Separation of Concerns

Validation is organized into distinct layers with clear responsibilities:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INGRESS FLOW                                      │
│  (Receiving messages from peers)                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Layer 1: Security Validator (security.ts)                                  │
│  • DoS protection (message size limits)                                     │
│  • Timestamp skew validation                                                │
│  • Peer blocking (after violations)                                         │
│  • Rate limiting (TODO)                                                     │
│                                                                             │
│  NOTE: Does NOT validate payload structure                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Layer 2: Protocol Handler (protocol.ts) - SINGLE INGRESS VALIDATION POINT  │
│  • Message structure validation                                             │
│  • Type-specific payload validation (uses validation.ts)                    │
│  • Event emission to coordinator                                            │
│                                                                             │
│  Payloads are validated ONCE here, not again in coordinator                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Layer 3: Coordinator (coordinator.ts) - BUSINESS LOGIC ONLY                │
│  • Session state management                                                 │
│  • Nonce reuse prevention                                                   │
│  • Participant verification                                                 │
│                                                                             │
│  NOTE: Does NOT re-validate payloads (already validated by protocol.ts)     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           EGRESS FLOW                                       │
│  (Sending messages to peers)                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Coordinator (coordinator.ts) - EGRESS VALIDATION                           │
│  • Validates payloads before sending (uses validation.ts)                   │
│  • Ensures we never send malformed data                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

1. **No Double Validation** - Payloads are validated exactly once on ingress
2. **Clear Responsibilities** - Each module has a single, well-defined purpose
3. **Security First** - Security constraints are checked before payload parsing
4. **Maintainability** - Changes to validation logic happen in one place

### Nonce Security

- **Reuse Prevention:** Global tracking via SHA256 hash
- **ν ≥ 2 Compliance:** Minimum 2 nonces required per MuSig2 spec
- **Sequential Validation:** Keys must be sequential (r1, r2, r3...)

---

## Discovery System

Optional DHT-based signer and signing request discovery.

### Signer Advertisement

```typescript
const adId = await discovery.advertiseSigner(
  myPublicKey,
  [TransactionType.SPEND, TransactionType.COINJOIN],
  {
    amountRange: { min: 1000, max: 100000000 },
    metadata: { nickname: 'FastSigner', fee: 1000 },
    ttl: 30 * 60 * 1000,
  },
)
```

### Signer Discovery

```typescript
const signers = await discovery.discoverSigners({
  transactionTypes: [TransactionType.COINJOIN],
  minAmount: 10000,
})
```

### Signing Request

```typescript
const requestId = await discovery.createSigningRequest(
  requiredPublicKeys,
  messageHash,
  { metadata: { purpose: 'CoinJoin round' } },
)
```

---

## API Reference

### Quick Start

#### 1. Create Coordinator

```typescript
import { MuSig2P2PCoordinator } from 'lotus-sdk/lib/p2p/musig2'
import { P2PConfig } from 'lotus-sdk/lib/p2p'

// Configure P2P layer
const p2pConfig: P2PConfig = {
  listen: ['/ip4/0.0.0.0/tcp/0'],
  bootstrapPeers: ['/dns4/bootstrap.lotusia.org/tcp/4001/p2p/12D3KooW...'],
  enableDHT: true,
  enableGossipSub: true,
}

// Create coordinator
const coordinator = new MuSig2P2PCoordinator(p2pConfig)
await coordinator.start()
```

#### 2. Create and Announce Session

```typescript
import { PublicKey } from 'lotus-sdk/lib/bitcore/publickey'
import { PrivateKey } from 'lotus-sdk/lib/bitcore/privatekey'

// Define signers (sorted)
const signers = [
  PublicKey.fromString('02...'),
  PublicKey.fromString('03...'),
  PublicKey.fromString('02...'),
].sort((a, b) => a.toBuffer().compare(b.toBuffer()))

const myPrivateKey = PrivateKey.fromWIF('...')
const message = Buffer.from('transaction hash', 'hex')

// Create session
const sessionId = await coordinator.createSession(
  signers,
  myPrivateKey,
  message,
)

// Announce to network
await coordinator.announceSession(sessionId)
```

#### 3. Listen for Sessions and Join

```typescript
import { MuSig2Event } from 'lotus-sdk/lib/p2p/musig2'

coordinator.on(MuSig2Event.SESSION_DISCOVERED, async announcement => {
  console.log('New session:', announcement.sessionId)
  console.log('Coordinator:', announcement.coordinatorPeerId)
  console.log('Required signers:', announcement.requiredSigners)

  // Check if our public key is in the signers list
  const myPubKeyHex = myPrivateKey.publicKey.toString()
  if (announcement.signers?.includes(myPubKeyHex)) {
    // Join the session
    const sessionId = await coordinator.joinSession(announcement, myPrivateKey)
    console.log('Joined session:', sessionId)
  }
})

// Handle join acceptance
coordinator.on('session:join-accepted', ({ sessionId, signerIndex }) => {
  console.log(`Join accepted! Session: ${sessionId}, Index: ${signerIndex}`)
})

// Handle join rejection
coordinator.on('session:join-rejected', ({ sessionId, reason }) => {
  console.error(`Join rejected for ${sessionId}: ${reason}`)
})
```

#### 4. Coordinate Signing (3-Phase Process)

**Phase 1: Nonce Exchange**

```typescript
// Wait for all participants to join
coordinator.on(MuSig2Event.SESSION_READY, async sessionId => {
  // Share nonces
  await coordinator.shareNonces(sessionId, myPrivateKey)
})

// Wait for all nonces
coordinator.on(MuSig2Event.NONCES_COMPLETE, sessionId => {
  console.log('All nonces collected!')
  // Ready for partial signatures
})
```

**Phase 2: Partial Signature Exchange**

```typescript
// Share partial signature
await coordinator.sharePartialSignature(sessionId, myPrivateKey)

// Wait for all partial signatures
coordinator.on(MuSig2Event.PARTIAL_SIGS_COMPLETE, sessionId => {
  console.log('All partial signatures collected!')
  // Ready to finalize
})
```

**Phase 3: Finalization**

```typescript
// Finalize and get signature
if (coordinator.canFinalizeSession(sessionId)) {
  const signature = coordinator.finalizeSession(sessionId)
  console.log('Final signature:', signature.toString('hex'))
}
```

### Event-Driven API

All coordination happens through events:

```typescript
import { MuSig2Event } from 'lotus-sdk/lib/p2p/musig2'

// Session lifecycle
coordinator.on(MuSig2Event.SESSION_CREATED, sessionId => {})
coordinator.on(MuSig2Event.SESSION_DISCOVERED, announcement => {})
coordinator.on(MuSig2Event.SESSION_READY, sessionId => {})

// Round 1
coordinator.on(MuSig2Event.NONCE_RECEIVED, (sessionId, signerIndex) => {})
coordinator.on(MuSig2Event.NONCES_COMPLETE, sessionId => {})

// Round 2
coordinator.on(MuSig2Event.PARTIAL_SIG_RECEIVED, (sessionId, signerIndex) => {})
coordinator.on(MuSig2Event.PARTIAL_SIGS_COMPLETE, sessionId => {})

// Completion
coordinator.on(MuSig2Event.SESSION_COMPLETE, (sessionId, signature) => {})
coordinator.on(MuSig2Event.SESSION_ABORTED, (sessionId, reason) => {})
coordinator.on(MuSig2Event.SESSION_ERROR, (sessionId, error) => {})
```

### Security Features

**Built-in Validation:**

- Session announcement validation
- Public key format verification
- Nonce and signature format validation
- Timestamp validation (prevents replay)
- Signer count limits (2-15 signers)

**Rate Limiting:**

- Inherits core P2P rate limiting
- DHT announcement throttling
- DoS protection

**Protocol Isolation:**

- MuSig2 uses dedicated protocol handler
- Message routing isolated from other protocols
- Security validator registered with core

### Configuration

```typescript
import { MuSig2P2PConfig, MuSig2SecurityConfig } from 'lotus-sdk/lib/p2p/musig2'

const musig2Config: MuSig2P2PConfig = {
  announcementTopic: 'lotus/musig2/sessions',
  announcementTTL: 5 * 60 * 1000, // 5 minutes
  nonceTimeout: 60 * 1000, // 1 minute
  partialSigTimeout: 60 * 1000, // 1 minute
  maxConcurrentSessions: 10,
  enableAutoCleanup: true,
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
}

const securityConfig: MuSig2SecurityConfig = {
  minSigners: 2,
  maxSigners: 15,
  maxSessionDuration: 10 * 60 * 1000, // 10 minutes
  requireValidPublicKeys: true,
}

const coordinator = new MuSig2P2PCoordinator(
  p2pConfig,
  musig2Config,
  securityConfig,
)
```

### Session Management

**Get Session Info:**

```typescript
const session = coordinator.getSession(sessionId)

console.log('Phase:', session.session.phase)
console.log('Participants:', session.participants.size)
console.log('Is Coordinator:', session.isCoordinator)
console.log('Last Activity:', session.lastActivity)
```

**List All Sessions:**

```typescript
const allSessions = coordinator.getAllSessions()

for (const session of allSessions) {
  console.log(`${session.session.sessionId}: ${session.session.phase}`)
}
```

**Abort Session:**

```typescript
await coordinator.abortSession(sessionId, 'Timeout waiting for signatures')
```

### Production Considerations

**1. Participant Management**

In production, you'll need to:

- Track which peers correspond to which signer indices
- Handle peer disconnections gracefully
- Implement timeouts for each phase

**2. Error Handling**

```typescript
coordinator.on(MuSig2Event.SESSION_ERROR, (sessionId, error) => {
  console.error(`Session ${sessionId} error:`, error)

  // Abort and notify participants
  coordinator.abortSession(sessionId, error.message).catch(console.error)
})
```

**3. Cleanup**

Sessions auto-cleanup after 10 minutes of inactivity. Manually cleanup:

```typescript
// On shutdown
await coordinator.stop()
```

---

## Configuration

### MuSig2P2PConfig

```typescript
interface MuSig2P2PConfig {
  announcementTopic?: string // Default: 'lotus/musig2/sessions'
  announcementTTL?: number // Default: 5 minutes
  nonceTimeout?: number // Default: 60 seconds
  partialSigTimeout?: number // Default: 60 seconds
  broadcastTimeout?: number // Default: 5 minutes
  maxConcurrentSessions?: number // Default: 10
  enableAutoCleanup?: boolean // Default: true
  cleanupInterval?: number // Default: 5 minutes
  enableCoordinatorElection?: boolean // Default: true
  electionMethod?: string // Default: 'lexicographic'
  enableCoordinatorFailover?: boolean // Default: true
  maxMessageSize?: number // Default: 100KB
  maxTimestampSkew?: number // Default: 5 minutes
  maxInvalidMessagesPerPeer?: number // Default: 10
  maxNonceCount?: number // Default: 10
}
```

### MuSig2SecurityConfig

```typescript
interface MuSig2SecurityConfig {
  minSigners?: number // Default: 2
  maxSigners?: number // Default: 15
  maxSessionDuration?: number // Default: 10 minutes
  requireValidPublicKeys?: boolean // Default: true
  maxMessageSize?: number // Default: 100KB
  maxTimestampSkew?: number // Default: 5 minutes
  maxInvalidMessagesPerPeer?: number // Default: 10
  enableValidationSecurity?: boolean // Default: true
  trackValidationViolations?: boolean // Default: true
}
```

### MuSig2DiscoveryConfig

```typescript
interface MuSig2DiscoveryConfig {
  signerKeyPrefix?: string // Default: 'musig2:signer:'
  requestKeyPrefix?: string // Default: 'musig2:request:'
  signerTTL?: number // Default: 30 minutes
  requestTTL?: number // Default: 10 minutes
  enableBurnValidation?: boolean // Default: false
  minBurnAmount?: number // Default: 50,000,000 (50 XPI)
  chronikUrl?: string | string[] // Default: 'https://chronik.lotusia.org'
  enableAutoRefresh?: boolean // Default: true
  signerRefreshInterval?: number // Default: 20 minutes
  maxConcurrentRequests?: number // Default: 5
}
```

---

## Events

### MuSig2Event Enum

```typescript
enum MuSig2Event {
  // Session Lifecycle
  SESSION_DISCOVERED        // New session found on network
  SESSION_CREATED           // Session created locally
  PARTICIPANT_JOINED        // Participant joined session
  SESSION_READY             // All participants joined

  // Round 1: Nonce Exchange
  NONCE_RECEIVED            // Nonce received from participant
  NONCES_COMPLETE           // All nonces collected

  // Round 2: Partial Signatures
  PARTIAL_SIG_RECEIVED      // Partial signature received
  PARTIAL_SIGS_COMPLETE     // All partial signatures collected

  // Completion
  SESSION_COMPLETE          // Signing complete
  SESSION_ABORTED           // Session aborted
  SESSION_TIMEOUT           // Session timed out
  SESSION_ERROR             // Error occurred

  // Coordinator Election
  COORDINATOR_ELECTED       // Coordinator determined
  SHOULD_BROADCAST          // You should broadcast (you're coordinator)
  COORDINATOR_FAILED        // Coordinator failover initiated
  FAILOVER_EXHAUSTED        // All coordinators failed
  BROADCAST_CONFIRMED       // Transaction broadcast confirmed

  // Discovery
  SIGNER_ADVERTISED         // Signer advertisement published
  SIGNER_DISCOVERED         // Signer found via DHT
  SIGNER_WITHDRAWN          // Signer advertisement removed
  SIGNING_REQUEST_CREATED   // Signing request published
  SIGNING_REQUEST_RECEIVED  // Signing request discovered
  SIGNING_REQUEST_JOINED    // Joined a signing request
}
```

---

## Error Handling

### Error Classes

```typescript
// Base error
class MuSig2P2PError extends Error

// Malformed data from peer (triggers reputation penalty)
class DeserializationError extends MuSig2P2PError {
  fieldName: string
  receivedValue?: unknown
}

// Well-formed but invalid data (triggers reputation penalty)
class ValidationError extends MuSig2P2PError {
  reason: string
}

// Incorrect protocol usage
class ProtocolError extends MuSig2P2PError

// Security violations or attacks
class SecurityError extends MuSig2P2PError {
  violationType: string
  peerId?: string
}

// Serialization failures
class SerializationError extends MuSig2P2PError {
  objectType: string
  reason?: string
}
```

### Error Codes

```typescript
enum ErrorCode {
  // Validation
  INVALID_PAYLOAD, MISSING_FIELD, INVALID_TYPE,
  INVALID_FORMAT, SIZE_LIMIT_EXCEEDED, TIMESTAMP_SKEW

  // Deserialization
  MALFORMED_DATA, INVALID_HEX, INVALID_LENGTH,
  INVALID_PREFIX, BUFFER_ERROR

  // Serialization
  SERIALIZATION_FAILED, INVALID_OBJECT, ENCODING_ERROR

  // Protocol
  INVALID_MESSAGE_TYPE, INVALID_PHASE,
  INVALID_STATE, PROTOCOL_VIOLATION

  // Security
  RATE_LIMIT_EXCEEDED, REPLAY_ATTACK,
  NONCE_REUSE, MALICIOUS_PEER, DOS_ATTEMPT
}
```

---

## Transaction Types

```typescript
enum TransactionType {
  SPEND     // Standard spend transaction
  SWAP      // Atomic swap transaction
  COINJOIN  // CoinJoin privacy transaction
  CUSTODY   // Custody/multisig wallet transaction
  ESCROW    // Escrow transaction
  CHANNEL   // Payment channel transaction
}
```

---

## Public Exports

```typescript
// Main coordinator
export { MuSig2P2PCoordinator } from './coordinator.js'
export { MuSig2ProtocolHandler } from './protocol.js'
export { MuSig2SecurityValidator, DEFAULT_MUSIG2_SECURITY } from './security.js'

// Coordinator election
export {
  electCoordinator,
  verifyElectionResult,
  isCoordinator,
  getCoordinatorPublicKey,
  getBackupCoordinator,
  getCoordinatorPriorityList,
  ElectionMethod,
} from './election.js'

// Discovery system
export {
  MuSig2Discovery,
  MuSig2DiscoverySecurityValidator,
  createMuSig2SecurityPolicy,
  DEFAULT_MUSIG2_DISCOVERY_CONFIG,
  isValidSignerAdvertisement,
  isValidSigningRequestAdvertisement,
  isValidSignerCriteria,
  isValidSigningRequestCriteria,
  publicKeyToHex,
  hexToPublicKey,
} from './discovery-index.js'

// Types
export * from './types.js'
```

---

## License

MIT License - Copyright 2025 The Lotusia Stewardship
