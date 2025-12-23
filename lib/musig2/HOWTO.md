# MuSig2 P2P Developer Guide

A comprehensive guide for building applications with the MuSig2 P2P coordination module.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Understanding the Architecture](#understanding-the-architecture)
3. [Creating a Signing Session](#creating-a-signing-session)
4. [Joining an Existing Session](#joining-an-existing-session)
5. [The Signing Protocol](#the-signing-protocol)
6. [Coordinator Election](#coordinator-election)
7. [Using the Discovery System](#using-the-discovery-system)
8. [Security Best Practices](#security-best-practices)
9. [Error Handling](#error-handling)
10. [Advanced Patterns](#advanced-patterns)

---

## Getting Started

### Installation

The MuSig2 P2P module is part of the Lotus SDK:

```typescript
import {
  MuSig2P2PCoordinator,
  MuSig2Event,
  MuSig2MessageType,
  TransactionType,
} from 'lotus-sdk/lib/p2p/musig2'

import { PublicKey } from 'lotus-sdk/lib/bitcore/publickey'
import { PrivateKey } from 'lotus-sdk/lib/bitcore/privatekey'
```

### Basic Setup

```typescript
import { MuSig2P2PCoordinator } from 'lotus-sdk/lib/p2p/musig2'
import type { P2PConfig } from 'lotus-sdk/lib/p2p'

// 1. Configure the P2P layer
const p2pConfig: P2PConfig = {
  listen: ['/ip4/0.0.0.0/tcp/0'],
  bootstrapPeers: ['/dns4/bootstrap.lotusia.org/tcp/4001/p2p/12D3KooW...'],
  enableDHT: true,
  enableGossipSub: true,
}

// 2. Create the coordinator
const coordinator = new MuSig2P2PCoordinator(p2pConfig)

// 3. Start the coordinator
await coordinator.start()
console.log('MuSig2 coordinator started with peer ID:', coordinator.peerId)

// 4. When done, stop gracefully
// await coordinator.stop()
```

---

## Understanding the Architecture

### Component Overview

The MuSig2 P2P module consists of several interconnected components with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                  Your Application                           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              MuSig2P2PCoordinator                           │
│  • Creates and manages signing sessions                     │
│  • Coordinates nonce and signature exchange                 │
│  • Handles coordinator election and failover                │
│  • Emits events for application consumption                 │
│  • Validates EGRESS payloads (before sending)               │
└─────────────────────────────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Protocol Handler│ │ Security Valid. │ │ Discovery       │
│                 │ │                 │ │ (Optional)      │
│ INGRESS valid.  │ │ DoS protection  │ │ DHT-based       │
│ Routes messages │ │ Peer blocking   │ │ signer finding  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Validation Architecture

The module uses a clear separation of concerns for validation:

| Module             | Responsibility                                       |
| ------------------ | ---------------------------------------------------- |
| **validation.ts**  | Pure validator functions (no side effects)           |
| **security.ts**    | Security constraints only (DoS, blocking, timestamp) |
| **protocol.ts**    | Single ingress validation point (uses validation.ts) |
| **coordinator.ts** | Business logic + egress validation                   |

### Message Flow

1. **GossipSub** - Used for session announcements (discovery)
2. **Direct P2P** - Used for nonce and signature exchange (coordination)
3. **DHT** - Used for signer discovery (optional)

### Session Lifecycle

```
INIT → NONCE_EXCHANGE → PARTIAL_SIG_EXCHANGE → COMPLETE
  │                                               │
  └──────────────── ABORTED ◄─────────────────────┘
```

---

## Creating a Signing Session

### Step 1: Prepare Signers

All signers must be known upfront. Public keys should be sorted lexicographically:

```typescript
import { PublicKey } from 'lotus-sdk/lib/bitcore/publickey'

// Collect all signer public keys
const signerPubKeys = [
  PublicKey.fromString('02abc...'),
  PublicKey.fromString('03def...'),
  PublicKey.fromString('02ghi...'),
]

// Sort lexicographically (required for MuSig2)
const sortedSigners = signerPubKeys.sort((a, b) =>
  a.toBuffer().compare(b.toBuffer()),
)
```

### Step 2: Create the Session

```typescript
import { PrivateKey } from 'lotus-sdk/lib/bitcore/privatekey'

// Your private key (must correspond to one of the public keys)
const myPrivateKey = PrivateKey.fromWIF('L...')

// The message to sign (typically a transaction hash)
const messageToSign = Buffer.from('transaction_hash_here', 'hex')

// Optional metadata
const metadata = {
  purpose: 'CoinJoin round 42',
  amount: 1000000,
}

// Create the session
const sessionId = await coordinator.createSession(
  sortedSigners,
  myPrivateKey,
  messageToSign,
  metadata,
)

console.log('Session created:', sessionId)
```

### Step 3: Announce the Session

```typescript
// Publish to GossipSub for other participants to discover
await coordinator.announceSession(sessionId)
console.log('Session announced to network')
```

### Step 4: Wait for Participants

```typescript
import { MuSig2Event } from 'lotus-sdk/lib/p2p/musig2'

coordinator.on(MuSig2Event.PARTICIPANT_JOINED, (sessionId, participant) => {
  console.log(`Participant joined: ${participant.peerId}`)
  console.log(`  Signer index: ${participant.signerIndex}`)
})

coordinator.on(MuSig2Event.SESSION_READY, sessionId => {
  console.log('All participants joined! Ready to sign.')
  // Proceed to nonce exchange
})
```

---

## Joining an Existing Session

### Step 1: Listen for Announcements

```typescript
coordinator.on(MuSig2Event.SESSION_DISCOVERED, announcement => {
  console.log('Discovered session:', announcement.sessionId)
  console.log('  Coordinator:', announcement.coordinatorPeerId)
  console.log('  Required signers:', announcement.requiredSigners)
  console.log('  Message hash:', announcement.messageHash)
  console.log('  Expires at:', new Date(announcement.expiresAt))

  // Check if we should join this session
  if (shouldJoinSession(announcement)) {
    handleJoinSession(announcement)
  }
})

function shouldJoinSession(announcement) {
  // Check if our public key is in the signers list
  const myPubKeyHex = myPrivateKey.publicKey.toString()
  return announcement.signers?.includes(myPubKeyHex)
}
```

### Step 2: Join the Session

Use the `joinSession()` method to send a join request to the coordinator:

```typescript
async function handleJoinSession(announcement) {
  try {
    // joinSession() does the following:
    // 1. Validates your public key is in the signers list
    // 2. Creates a local session state
    // 3. Sends a SESSION_JOIN message to the coordinator
    const sessionId = await coordinator.joinSession(announcement, myPrivateKey)
    console.log(`Join request sent for session: ${sessionId}`)
  } catch (error) {
    console.error('Failed to join session:', error.message)
  }
}
```

### Step 3: Handle Join Response

The coordinator will respond with a `SESSION_JOIN_ACK` message:

```typescript
// Handle successful join
coordinator.on(
  'session:join-accepted',
  ({ sessionId, signerIndex, coordinatorPeerId }) => {
    console.log(`Successfully joined session ${sessionId}`)
    console.log(`  My signer index: ${signerIndex}`)
    console.log(`  Coordinator: ${coordinatorPeerId}`)

    // Session is now ready for nonce exchange
    // Wait for SESSION_READY event before sharing nonces
  },
)

// Handle join rejection
coordinator.on(
  'session:join-rejected',
  ({ sessionId, reason, coordinatorPeerId }) => {
    console.error(`Join rejected for session ${sessionId}`)
    console.error(`  Reason: ${reason}`)
    console.error(`  Coordinator: ${coordinatorPeerId}`)

    // The session has been automatically removed from local state
  },
)
```

### Complete Join Flow Diagram

```
Participant                                    Coordinator
    │                                              │
    │  1. Receive SESSION_DISCOVERED event         │
    │     (via GossipSub)                          │
    │                                              │
    │  2. Call joinSession(announcement, privateKey)
    │         ─────────────────────────────────►   │
    │              SESSION_JOIN                    │
    │                                              │
    │                              3. Validate:    │
    │                                 - Session exists
    │                                 - Is coordinator
    │                                 - Public key valid
    │                                 - Not already joined
    │                                              │
    │         ◄─────────────────────────────────   │
    │              SESSION_JOIN_ACK                │
    │                                              │
    │  4. Receive 'session:join-accepted' or       │
    │     'session:join-rejected' event            │
    │                                              │
```

---

## The Signing Protocol

### Round 1: Nonce Exchange

After all participants have joined, each signer generates and shares nonces:

```typescript
coordinator.on(MuSig2Event.SESSION_READY, async sessionId => {
  // Generate and share nonces (ν ≥ 2 nonces per MuSig2 spec)
  await coordinator.shareNonces(sessionId, myPrivateKey)
  console.log('Nonces shared')
})

// Track nonce reception
coordinator.on(MuSig2Event.NONCE_RECEIVED, (sessionId, signerIndex) => {
  console.log(`Received nonce from signer ${signerIndex}`)
})

// All nonces collected
coordinator.on(MuSig2Event.NONCES_COMPLETE, sessionId => {
  console.log('All nonces collected! Ready for partial signatures.')
})
```

### Round 2: Partial Signature Exchange

Once all nonces are collected, each signer creates and shares their partial signature:

```typescript
coordinator.on(MuSig2Event.NONCES_COMPLETE, async sessionId => {
  // Create and share partial signature
  await coordinator.sharePartialSignature(sessionId, myPrivateKey)
  console.log('Partial signature shared')
})

// Track partial signature reception
coordinator.on(MuSig2Event.PARTIAL_SIG_RECEIVED, (sessionId, signerIndex) => {
  console.log(`Received partial signature from signer ${signerIndex}`)
})

// All partial signatures collected
coordinator.on(MuSig2Event.PARTIAL_SIGS_COMPLETE, sessionId => {
  console.log('All partial signatures collected!')
})
```

### Finalization

The coordinator aggregates all partial signatures into the final signature:

```typescript
coordinator.on(MuSig2Event.PARTIAL_SIGS_COMPLETE, async sessionId => {
  // Check if we can finalize
  if (coordinator.canFinalizeSession(sessionId)) {
    // Aggregate signatures
    const finalSignature = await coordinator.finalizeSession(sessionId)
    console.log('Final signature:', finalSignature.toString('hex'))

    // The signature is now ready to be used in a transaction
    // broadcastTransaction(finalSignature)
  }
})

// Session complete event
coordinator.on(MuSig2Event.SESSION_COMPLETE, (sessionId, signature) => {
  console.log(`Session ${sessionId} completed successfully!`)
})
```

---

## Coordinator Election

### How Election Works

The coordinator is deterministically elected based on public keys. No additional communication is needed - all participants compute the same result.

```typescript
import {
  electCoordinator,
  ElectionMethod,
  isCoordinator,
  getCoordinatorPriorityList,
} from 'lotus-sdk/lib/p2p/musig2'

// Elect coordinator
const election = electCoordinator(sortedSigners, ElectionMethod.LEXICOGRAPHIC)

console.log('Coordinator index:', election.coordinatorIndex)
console.log('Coordinator pubkey:', election.coordinatorPublicKey.toString())
console.log('Election proof:', election.electionProof)

// Check if you are the coordinator
const myIndex = sortedSigners.findIndex(
  pk => pk.toString() === myPrivateKey.publicKey.toString(),
)
const amICoordinator = isCoordinator(sortedSigners, myIndex)
console.log('Am I coordinator?', amICoordinator)
```

### Election Methods

```typescript
// Lexicographic (default) - first in sorted order
electCoordinator(signers, ElectionMethod.LEXICOGRAPHIC)

// Hash-based - pseudo-random but deterministic
electCoordinator(signers, ElectionMethod.HASH_BASED)

// First signer in sorted array
electCoordinator(signers, ElectionMethod.FIRST_SIGNER)

// Last signer in sorted array
electCoordinator(signers, ElectionMethod.LAST_SIGNER)
```

### Coordinator Failover

If the coordinator fails to broadcast, backup coordinators take over:

```typescript
// Get the priority list for failover
const priorityList = getCoordinatorPriorityList(sortedSigners)
console.log('Coordinator priority:', priorityList)
// e.g., [2, 0, 1] means signer 2 is primary, 0 is first backup, etc.

// Listen for failover events
coordinator.on(MuSig2Event.COORDINATOR_FAILED, (sessionId, oldIndex) => {
  console.log(`Coordinator ${oldIndex} failed, failover initiated`)
})

coordinator.on(MuSig2Event.SHOULD_BROADCAST, (sessionId, myIndex) => {
  console.log('I am now responsible for broadcasting!')
  // broadcastTransaction(...)
})

coordinator.on(MuSig2Event.FAILOVER_EXHAUSTED, sessionId => {
  console.error('All coordinators failed!')
})

// Notify when broadcast is complete to cancel failover timer
coordinator.notifyBroadcastComplete(sessionId)
```

---

## Using the Discovery System

The discovery system allows signers to advertise their availability and find each other via DHT.

### Enable Discovery

```typescript
import type { MuSig2DiscoveryConfig } from 'lotus-sdk/lib/p2p/musig2'

const discoveryConfig: MuSig2DiscoveryConfig = {
  signerTTL: 30 * 60 * 1000, // 30 minutes
  requestTTL: 10 * 60 * 1000, // 10 minutes
  enableAutoRefresh: true,
  signerRefreshInterval: 20 * 60 * 1000,
  maxConcurrentRequests: 5,
}

const coordinator = new MuSig2P2PCoordinator(
  p2pConfig,
  musig2Config,
  securityConfig,
  discoveryConfig, // Enable discovery
)

await coordinator.start()

// Get the discovery instance
const discovery = coordinator.getDiscovery()
if (discovery) {
  console.log('Discovery enabled')
}
```

### Advertise as a Signer

```typescript
import { TransactionType } from 'lotus-sdk/lib/p2p/musig2'

const discovery = coordinator.getDiscovery()

// Advertise your availability
const adId = await discovery.advertiseSigner(
  myPrivateKey.publicKey,
  [TransactionType.SPEND, TransactionType.COINJOIN],
  {
    amountRange: {
      min: 10000, // Minimum 10,000 satoshis
      max: 100000000, // Maximum 1 XPI
    },
    metadata: {
      nickname: 'AliceSigner',
      description: 'Fast and reliable signer',
      fee: 1000, // Fee in satoshis
      averageResponseTime: 5000, // 5 seconds
    },
    ttl: 30 * 60 * 1000, // 30 minutes
  },
)

console.log('Advertised as signer:', adId)

// Listen for advertisement events
coordinator.on(MuSig2Event.SIGNER_ADVERTISED, ad => {
  console.log('Successfully advertised')
})

// Withdraw advertisement when done
await discovery.withdrawSigner()
```

### Discover Available Signers

```typescript
// Find signers matching criteria
const signers = await discovery.discoverSigners({
  transactionTypes: [TransactionType.COINJOIN],
  minAmount: 50000,
  maxAmount: 10000000,
})

console.log(`Found ${signers.length} available signers:`)
for (const signer of signers) {
  console.log(`  - ${signer.signerMetadata?.nickname || 'Anonymous'}`)
  console.log(`    Public key: ${signer.publicKey.toString().slice(0, 20)}...`)
  console.log(`    Fee: ${signer.signerMetadata?.fee || 0} sats`)
}

// Listen for discovered signers
coordinator.on(MuSig2Event.SIGNER_DISCOVERED, signer => {
  console.log('Discovered signer:', signer.id)
})
```

### Create a Signing Request

```typescript
// Create a signing request for specific public keys
const requestId = await discovery.createSigningRequest(
  requiredPublicKeys,
  messageHash,
  {
    metadata: {
      transactionType: TransactionType.COINJOIN,
      amount: 1000000,
      purpose: 'CoinJoin round',
    },
    ttl: 10 * 60 * 1000, // 10 minutes
  },
)

console.log('Created signing request:', requestId)

// Discover signing requests
const requests = await discovery.discoverSigningRequests({
  includesPublicKeys: [myPubKeyHex],
  transactionType: TransactionType.COINJOIN,
})

// Join a signing request
await discovery.joinSigningRequest(requestId, myPrivateKey.publicKey)
```

---

## Security Best Practices

### 1. Understanding the Validation Architecture

The MuSig2 module uses a layered validation architecture:

```typescript
// INGRESS: Messages from peers are validated automatically:
// 1. security.ts checks DoS protection, timestamp skew, peer blocking
// 2. protocol.ts validates payload structure (single validation point)
// 3. coordinator.ts receives pre-validated payloads (no re-validation)

// EGRESS: Messages you send are validated before transmission:
// coordinator.ts validates payloads before broadcasting

// You can also validate manually if needed:
import {
  validateSessionAnnouncementPayload,
  validateNonceSharePayload,
} from 'lotus-sdk/lib/p2p/musig2'

try {
  validateSessionAnnouncementPayload(announcement)
} catch (error) {
  console.error('Invalid announcement:', error.message)
}
```

### 2. Monitor Security Status

```typescript
// Check security status
const status = coordinator.getSecurityStatus()
console.log('Blocked peers:', status.blockedPeers)
console.log('Total violations:', status.totalViolations)

// Check if a specific peer is blocked
if (coordinator.isPeerBlocked(peerId)) {
  console.warn('Peer is blocked due to violations')
}

// Manually unblock a peer (use with caution)
coordinator.unblockPeer(peerId)
```

### 3. Handle Timeouts

```typescript
// Configure appropriate timeouts
const musig2Config = {
  nonceTimeout: 60 * 1000, // 1 minute for nonce collection
  partialSigTimeout: 60 * 1000, // 1 minute for partial sig collection
  broadcastTimeout: 5 * 60 * 1000, // 5 minutes for broadcast
}

// Handle timeout events
coordinator.on(MuSig2Event.SESSION_TIMEOUT, (sessionId, phase) => {
  console.error(`Session ${sessionId} timed out during ${phase}`)
})
```

### 4. Nonce Security

The coordinator automatically prevents nonce reuse, but be aware:

```typescript
// NEVER reuse nonces across sessions
// NEVER share private nonces
// The coordinator tracks used nonces via SHA256 hash

// If you need to abort and retry, create a NEW session
await coordinator.abortSession(sessionId, 'Retry needed')
const newSessionId = await coordinator.createSession(...)
```

### 5. Limit Concurrent Sessions

```typescript
const musig2Config = {
  maxConcurrentSessions: 10, // Prevent resource exhaustion
}

// Check current session count
const count = coordinator.getSessionCount()
if (count >= 10) {
  console.warn('Maximum concurrent sessions reached')
}
```

---

## Error Handling

### Listen for Errors

```typescript
// Session errors
coordinator.on(MuSig2Event.SESSION_ERROR, (sessionId, error) => {
  console.error(`Session ${sessionId} error:`, error)

  // Decide whether to abort
  if (error.message.includes('timeout')) {
    coordinator.abortSession(sessionId, 'Timeout').catch(console.error)
  }
})

// Validation errors
coordinator.on('validation:error', ({ error, message, from }) => {
  console.warn(`Validation error from ${from.peerId}:`, error.message)
})

// Deserialization errors
coordinator.on('deserialization:error', ({ error, message, from }) => {
  console.warn(`Deserialization error from ${from.peerId}:`, error.message)
})

// Security rejections
coordinator.on('security:rejected', ({ message, from, reason }) => {
  console.warn(
    `Security rejected ${message.type} from ${from.peerId}: ${reason}`,
  )
})
```

### Error Types

```typescript
import {
  MuSig2P2PError,
  ValidationError,
  DeserializationError,
  SecurityError,
  ProtocolError,
  SerializationError,
} from 'lotus-sdk/lib/p2p/musig2'

try {
  await coordinator.shareNonces(sessionId, privateKey)
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Validation failed:', error.reason)
  } else if (error instanceof SecurityError) {
    console.error('Security violation:', error.violationType)
  } else if (error instanceof ProtocolError) {
    console.error('Protocol error:', error.message)
  } else {
    console.error('Unknown error:', error)
  }
}
```

### Graceful Abort

```typescript
// Abort with reason
await coordinator.abortSession(sessionId, 'User cancelled')

// Handle abort events
coordinator.on(MuSig2Event.SESSION_ABORTED, (sessionId, reason) => {
  console.log(`Session ${sessionId} aborted: ${reason}`)
})
```

---

## Advanced Patterns

### Pattern 1: Automatic Session Management

```typescript
class MuSig2SessionManager {
  private coordinator: MuSig2P2PCoordinator
  private activeSessions = new Map<string, SessionState>()

  constructor(coordinator: MuSig2P2PCoordinator) {
    this.coordinator = coordinator
    this.setupEventHandlers()
  }

  private setupEventHandlers() {
    this.coordinator.on(MuSig2Event.SESSION_READY, async sessionId => {
      await this.handleSessionReady(sessionId)
    })

    this.coordinator.on(MuSig2Event.NONCES_COMPLETE, async sessionId => {
      await this.handleNoncesComplete(sessionId)
    })

    this.coordinator.on(MuSig2Event.PARTIAL_SIGS_COMPLETE, async sessionId => {
      await this.handlePartialSigsComplete(sessionId)
    })
  }

  private async handleSessionReady(sessionId: string) {
    const state = this.activeSessions.get(sessionId)
    if (state) {
      await this.coordinator.shareNonces(sessionId, state.privateKey)
    }
  }

  private async handleNoncesComplete(sessionId: string) {
    const state = this.activeSessions.get(sessionId)
    if (state) {
      await this.coordinator.sharePartialSignature(sessionId, state.privateKey)
    }
  }

  private async handlePartialSigsComplete(sessionId: string) {
    if (this.coordinator.canFinalizeSession(sessionId)) {
      const signature = await this.coordinator.finalizeSession(sessionId)
      this.activeSessions.delete(sessionId)
      // Emit or callback with signature
    }
  }
}
```

### Pattern 2: CoinJoin Coordinator

```typescript
class CoinJoinCoordinator {
  private discovery: MuSig2Discovery
  private coordinator: MuSig2P2PCoordinator
  private pendingParticipants: PublicKey[] = []
  private targetParticipants = 5

  async startRound() {
    // Advertise as CoinJoin coordinator
    await this.discovery.advertiseSigner(
      this.myPublicKey,
      [TransactionType.COINJOIN],
      { metadata: { role: 'coordinator' } },
    )

    // Wait for participants
    await this.collectParticipants()

    // Create signing session
    const sessionId = await this.coordinator.createSession(
      this.pendingParticipants,
      this.myPrivateKey,
      this.buildCoinJoinTransaction(),
    )

    await this.coordinator.announceSession(sessionId)
  }

  private async collectParticipants() {
    return new Promise<void>(resolve => {
      this.coordinator.on(MuSig2Event.SIGNING_REQUEST_JOINED, () => {
        if (this.pendingParticipants.length >= this.targetParticipants) {
          resolve()
        }
      })
    })
  }
}
```

### Pattern 3: Retry with Exponential Backoff

```typescript
async function createSessionWithRetry(
  coordinator: MuSig2P2PCoordinator,
  signers: PublicKey[],
  privateKey: PrivateKey,
  message: Buffer,
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const sessionId = await coordinator.createSession(
        signers,
        privateKey,
        message,
      )
      return sessionId
    } catch (error) {
      lastError = error as Error
      const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError
}
```

### Pattern 4: Session Monitoring Dashboard

```typescript
function getSessionDashboard(coordinator: MuSig2P2PCoordinator) {
  const metrics = coordinator.getMetrics()
  const security = coordinator.getSecurityStatus()

  return {
    sessions: {
      active: metrics.activeSessions,
      created: metrics.sessionsCreated,
      completed: metrics.sessionsCompleted,
      aborted: metrics.sessionsAborted,
      timedOut: metrics.sessionsTimedOut,
    },
    security: {
      blockedPeers: security.blockedPeerCount,
      totalViolations: security.totalViolations,
    },
    nonces: {
      tracked: metrics.totalUsedNonces,
    },
  }
}
```

---

## Troubleshooting

### Session Not Progressing

1. Check if all participants have joined
2. Verify nonce timeout hasn't expired
3. Check for blocked peers
4. Verify network connectivity

```typescript
const session = coordinator.getSession(sessionId)
console.log('Phase:', session.session.phase)
console.log('Participants:', session.participants.size)
console.log('Expected:', session.session.signers.length)
```

### Nonce Errors

1. Ensure you're not reusing sessions
2. Check that private key matches a signer public key
3. Verify session is in correct phase

```typescript
const session = coordinator.getSession(sessionId)
if (session.session.phase !== 'INIT') {
  console.error('Cannot share nonces - wrong phase')
}
```

### Discovery Not Finding Signers

1. Verify DHT is enabled in P2P config
2. Check that signers have advertised recently
3. Verify criteria matches advertisements

```typescript
// Check if discovery is enabled
if (!coordinator.hasDiscovery()) {
  console.error('Discovery not enabled')
}
```

---

## Next Steps

- Review the [README.md](./README.md) for API reference
- Check the test files for more examples
- Join the Lotusia community for support

---

## License

MIT License - Copyright 2025 The Lotusia Stewardship
