# SwapSig Implementation Plan

**Version**: 2.1  
**Date**: November 28, 2025  
**Status**: Complete Re-Implementation Required (Updated with v2 Security Analysis)

---

## Overview

This document outlines the complete re-implementation plan for SwapSig following the MuSig2 P2P architecture rearchitecture. The previous implementation is no longer valid and must be rebuilt from scratch, incorporating fixes for the security/privacy gaps identified in:

- `SWAPSIG_SECURITY_PRIVACY_GAPS.md` (v1 analysis)
- `SWAPSIG_SECURITY_PRIVACY_GAPS_V2.md` (v2 comprehensive analysis)

### Key Updates in v2.1

Based on the comprehensive v2 security analysis, this plan now includes:

1. **Intersection Attack Prevention** - Wallet-level output isolation
2. **Fee Rate Obfuscation** - Randomized fees to prevent fingerprinting
3. **Amount Variance** - Slight randomization to break amount correlation
4. **Timelock Refunds** - Lotus OP_CHECKSEQUENCEVERIFY for trustless refunds
5. **Graph Obfuscation** - Decoy transactions and pool chaining support
6. **Privacy Modes** - Tiered privacy (Standard/Enhanced/Maximum)

---

## Architecture Overview

### Component Hierarchy

```
lib/p2p/swapsig/
├── index.ts                    # Public exports
├── types.ts                    # Type definitions
├── coordinator.ts              # Main SwapSigCoordinator class
├── pool.ts                     # Pool management
├── protocol.ts                 # Protocol state machine
├── discovery.ts                # DHT discovery (privacy-preserving)
├── commitment.ts               # Secure destination commitments
├── burn.ts                     # Stealth burn mechanism
├── timing.ts                   # Timing obfuscation
├── validation.ts               # Input/output validation
├── privacy.ts                  # Privacy utilities
├── security.ts                 # Security mechanisms
├── errors.ts                   # Error types
├── wallet.ts                   # Wallet integration (intersection prevention) [NEW]
├── refund.ts                   # Timelock refund scripts (Lotus CSV) [NEW]
├── obfuscation.ts              # Fee/amount obfuscation [NEW]
├── decoy.ts                    # Decoy transaction generation [NEW]
└── README.md                   # Module documentation
```

### Integration with MuSig2 P2P

```
┌─────────────────────────────────────────────────────────────┐
│                    SwapSigCoordinator                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Pool Management | Protocol FSM | Privacy Layer          │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   MuSig2P2PCoordinator                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Discovery Layer | Session Management | Signing          │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      P2PCoordinator                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ libp2p | DHT | GossipSub | Direct Messaging             │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Core Types & Infrastructure (Week 1)

**Files to Create**:

- `types.ts` - All type definitions
- `errors.ts` - Error classes
- `index.ts` - Public exports

**Key Types**:

```typescript
// types.ts

// ============================================================================
// Pool Types
// ============================================================================

export enum SwapPhase {
  DISCOVERY = 'discovery',
  REGISTRATION = 'registration',
  COMMITMENT = 'commitment',
  SETUP = 'setup',
  SETUP_CONFIRM = 'setup-confirm',
  REVEAL = 'reveal',
  SETTLEMENT = 'settlement',
  SETTLEMENT_CONFIRM = 'settlement-confirm',
  COMPLETE = 'complete',
  ABORTED = 'aborted',
}

export interface SwapPool {
  poolId: string
  denomination: number
  minParticipants: number
  maxParticipants: number
  feeRate: number

  // Privacy configuration
  privacyConfig: PoolPrivacyConfig

  // Burn configuration
  burnConfig: BurnConfig

  // Group size strategy (computed)
  groupSizeStrategy?: GroupSizeStrategy

  // Participants
  participants: SwapParticipant[]
  participantMap: Map<string, SwapParticipant>

  // Outputs
  outputGroups: OutputGroup[]
  settlementMapping: Map<number, SettlementInfo>

  // State
  phase: SwapPhase
  createdAt: number
  startedAt?: number
  completedAt?: number
  aborted: boolean
  abortReason?: string

  // Timeouts
  setupTimeout: number
  settlementTimeout: number
}

export interface SwapParticipant {
  peerId: string
  participantIndex: number
  publicKey: PublicKey

  // Input
  input: SwapInput
  ownershipProof: Buffer

  // Secure destination commitment (NEW)
  destinationCommitment: SecureCommitment
  revealedDestination?: Address

  // Transaction status
  setupTxId?: string
  setupConfirmed: boolean
  burnVerified: boolean

  joinedAt: number
}

// ============================================================================
// Privacy Types (NEW - Addresses Security Gaps)
// ============================================================================

export interface PoolPrivacyConfig {
  // Network privacy
  requireAnonymousTransport: boolean
  allowedTransports: ('tor' | 'i2p' | 'direct')[]

  // Timing obfuscation
  enableTimingObfuscation: boolean
  setupBroadcastWindowMs: number
  settlementBroadcastWindowMs: number

  // Coordinator blindness
  enableBlindCoordinator: boolean

  // On-chain privacy
  enableStealthBurn: boolean

  // DHT privacy
  enableAnonymousPoolAnnouncement: boolean
}

export interface SecureCommitment {
  // Pedersen commitment: C = g^m * h^r
  commitment: Buffer // 33 bytes (compressed point)

  // Per-participant encrypted destinations
  encryptedDestinations: Map<string, Buffer> // peerId -> encrypted

  // Reveal data (only set after reveal)
  revealData?: {
    destination: Address
    blindingFactor: Buffer
  }
}

export interface StealthBurnConfig {
  // Burn method
  method: 'fee-overpay' | 'unspendable-p2pkh' | 'generic-opreturn'

  // Verification
  offChainVerification: boolean
  burnCommitmentRequired: boolean
}

// ============================================================================
// Group Types
// ============================================================================

export interface OutputGroup {
  groupIndex: number
  participantIndices: number[]
  signers: PublicKey[]

  // MuSig2 aggregated key
  aggregatedKey: PublicKey
  taprootAddress: Address

  // Amount per output
  amount: number

  // Settlement info
  receiverIndex: number
  receiverAddress?: Address

  // Transaction status
  setupTxIds: string[]
  settlementTxId?: string
  settlementConfirmed: boolean

  // MuSig2 session
  signingRequestId?: string
  sessionId?: string
}

export interface GroupSizeStrategy {
  groupSize: number // 2, 3, 5, or 10
  groupCount: number
  anonymityPerGroup: number
  reasoning: string
  recommendedRounds: number
}
```

**Deliverables**:

- [ ] Complete type definitions
- [ ] Error class hierarchy
- [ ] Public export structure

---

### Phase 2: Secure Commitment Scheme (Week 2)

**Files to Create**:

- `commitment.ts` - Pedersen commitments and secure reveal

**Implementation**:

```typescript
// commitment.ts

import { Point, BN } from '../../bitcore/crypto/index.js'
import { Hash } from '../../bitcore/crypto/hash.js'
import { PublicKey } from '../../bitcore/publickey.js'
import { PrivateKey } from '../../bitcore/privatekey.js'
import type { Address } from '../../bitcore/address.js'

/**
 * Secure Destination Commitment
 *
 * Uses Pedersen commitments for information-theoretic hiding:
 * C = g^m * h^r
 *
 * Where:
 * - g, h are generator points (h = Hash-to-curve of g)
 * - m is the message (destination address hash)
 * - r is the blinding factor (random)
 */
export class SecureDestinationCommitment {
  // Generator points
  private static readonly G: Point = Point.getG()
  private static readonly H: Point = this._deriveH()

  private static _deriveH(): Point {
    // H = Hash-to-curve(G) - nothing-up-my-sleeve derivation
    const gBytes = this.G.toBuffer()
    const hHash = Hash.sha256(
      Buffer.concat([Buffer.from('SwapSig_H_Generator'), gBytes]),
    )
    // Use hash as x-coordinate, find valid point
    return Point.fromX(hHash)
  }

  /**
   * Create a Pedersen commitment to a destination address
   */
  static commit(destination: Address): {
    commitment: Buffer
    blindingFactor: Buffer
  } {
    // Generate random blinding factor
    const blindingFactor = PrivateKey.fromRandom().bn.toBuffer()

    // Hash destination to scalar
    const destHash = Hash.sha256(destination.toBuffer())
    const m = BN.fromBuffer(destHash)
    const r = BN.fromBuffer(blindingFactor)

    // C = g^m * h^r
    const gm = this.G.mul(m)
    const hr = this.H.mul(r)
    const C = gm.add(hr)

    return {
      commitment: C.toBuffer(),
      blindingFactor,
    }
  }

  /**
   * Verify a commitment opening
   */
  static verify(
    commitment: Buffer,
    destination: Address,
    blindingFactor: Buffer,
  ): boolean {
    const destHash = Hash.sha256(destination.toBuffer())
    const m = BN.fromBuffer(destHash)
    const r = BN.fromBuffer(blindingFactor)

    // Recompute C = g^m * h^r
    const gm = this.G.mul(m)
    const hr = this.H.mul(r)
    const expectedC = gm.add(hr)

    // Compare
    return expectedC.toBuffer().equals(commitment)
  }

  /**
   * Encrypt destination for specific recipient
   * Uses ECIES-like encryption
   */
  static encryptForRecipient(
    destination: Address,
    recipientPubKey: PublicKey,
    senderPrivKey: PrivateKey,
  ): Buffer {
    // ECDH shared secret
    const sharedPoint = recipientPubKey.point.mul(senderPrivKey.bn)
    const sharedSecret = Hash.sha256(sharedPoint.toBuffer())

    // Encrypt destination with shared secret (AES-256-GCM)
    const destBytes = destination.toBuffer()
    return this._aesEncrypt(destBytes, sharedSecret)
  }

  /**
   * Decrypt destination from sender
   */
  static decryptFromSender(
    encrypted: Buffer,
    senderPubKey: PublicKey,
    recipientPrivKey: PrivateKey,
  ): Address {
    // ECDH shared secret
    const sharedPoint = senderPubKey.point.mul(recipientPrivKey.bn)
    const sharedSecret = Hash.sha256(sharedPoint.toBuffer())

    // Decrypt
    const destBytes = this._aesDecrypt(encrypted, sharedSecret)
    return Address.fromBuffer(destBytes)
  }

  private static _aesEncrypt(data: Buffer, key: Buffer): Buffer {
    // Implementation using crypto module
    // ... AES-256-GCM encryption
  }

  private static _aesDecrypt(data: Buffer, key: Buffer): Buffer {
    // Implementation using crypto module
    // ... AES-256-GCM decryption
  }
}
```

**Deliverables**:

- [ ] Pedersen commitment implementation
- [ ] ECIES encryption for per-recipient destinations
- [ ] Commitment verification
- [ ] Unit tests for commitment scheme

---

### Phase 3: Stealth Burn Mechanism (Week 2-3)

**Files to Create**:

- `burn.ts` - Privacy-preserving burn mechanism

**Implementation**:

```typescript
// burn.ts

import { Transaction, Output, Script, Opcode } from '../../bitcore/index.js'
import { Hash } from '../../bitcore/crypto/hash.js'
import type { BurnConfig, StealthBurnConfig } from './types.js'

/**
 * Stealth Burn Mechanism
 *
 * Provides Sybil defense without on-chain protocol fingerprinting.
 *
 * Methods:
 * 1. Fee Overpay: Burn via excessive transaction fee (miners receive)
 * 2. Unspendable P2PKH: Burn to known-unspendable address
 * 3. Generic OP_RETURN: Random data, no identifier
 */
export class StealthBurnMechanism {
  private config: StealthBurnConfig

  constructor(config: StealthBurnConfig) {
    this.config = config
  }

  /**
   * Calculate required burn amount
   */
  calculateBurnAmount(
    denomination: number,
    burnPercentage: number,
    poolSize: number,
  ): number {
    // Base burn
    let burn = Math.floor(denomination * burnPercentage)

    // Scale with pool size (larger pools = slightly higher burn)
    const poolMultiplier = 1 + Math.log10(poolSize) * 0.1
    burn = Math.floor(burn * poolMultiplier)

    // Apply bounds
    const minBurn = 1000 // 0.001 XPI
    const maxBurn = 100000 // 0.1 XPI

    return Math.max(minBurn, Math.min(burn, maxBurn))
  }

  /**
   * Create burn output (stealth mode)
   */
  createBurnOutput(
    burnAmount: number,
    poolId: string,
  ): { output?: Output; feeAddition?: number; commitment: Buffer } {
    // Create off-chain commitment (for verification)
    const commitment = Hash.sha256(
      Buffer.concat([
        Buffer.from(poolId, 'hex'),
        Buffer.from(burnAmount.toString()),
        Buffer.from(Date.now().toString()),
      ]),
    )

    switch (this.config.method) {
      case 'fee-overpay':
        // No output, just add to fee
        return {
          feeAddition: burnAmount,
          commitment,
        }

      case 'unspendable-p2pkh':
        // Burn to provably unspendable address
        // Hash160 of empty = known unspendable
        const unspendableHash = Hash.sha256ripemd160(Buffer.alloc(0))
        const script = Script.buildPublicKeyHashOut(unspendableHash)
        return {
          output: new Output({ satoshis: burnAmount, script }),
          commitment,
        }

      case 'generic-opreturn':
        // Random data, no identifier
        const randomData = Hash.sha256(
          Buffer.concat([commitment, Buffer.from(Math.random().toString())]),
        )
        const opReturnScript = new Script()
          .add(Opcode.OP_RETURN)
          .add(randomData.slice(0, 20)) // 20 random bytes
        return {
          output: new Output({ satoshis: burnAmount, script: opReturnScript }),
          commitment,
        }
    }
  }

  /**
   * Verify burn in transaction (off-chain)
   *
   * Participants exchange signed burn commitments
   * No on-chain verification needed
   */
  async verifyBurnCommitment(
    setupTxId: string,
    expectedBurnAmount: number,
    burnCommitment: Buffer,
    participantSignature: Buffer,
    participantPubKey: PublicKey,
  ): Promise<boolean> {
    // Verify signature over commitment
    const message = Buffer.concat([
      Buffer.from(setupTxId, 'hex'),
      burnCommitment,
    ])

    if (!Schnorr.verify(message, participantSignature, participantPubKey)) {
      return false
    }

    // Verify transaction exists and has sufficient burn
    // (fee overpay or unspendable output)
    const tx = await this._fetchTransaction(setupTxId)

    switch (this.config.method) {
      case 'fee-overpay':
        const inputValue = await this._getInputValue(tx)
        const outputValue = tx.outputs.reduce((sum, o) => sum + o.satoshis, 0)
        const fee = inputValue - outputValue
        return fee >= expectedBurnAmount + this._getBaseFee(tx)

      case 'unspendable-p2pkh':
      case 'generic-opreturn':
        // Find burn output
        const burnOutput = tx.outputs.find(
          o =>
            o.satoshis >= expectedBurnAmount &&
            (o.script.isDataOut() || this._isUnspendable(o.script)),
        )
        return burnOutput !== undefined
    }

    return false
  }

  private _isUnspendable(script: Script): boolean {
    // Check if P2PKH to known unspendable hash
    const unspendableHash = Hash.sha256ripemd160(Buffer.alloc(0))
    // ... implementation
    return false
  }
}
```

**Deliverables**:

- [ ] Three burn methods implemented
- [ ] Off-chain verification
- [ ] Burn commitment signing
- [ ] Unit tests

---

### Phase 4: Privacy-Preserving Discovery (Week 3)

**Files to Create**:

- `discovery.ts` - Anonymous pool discovery

**Implementation**:

```typescript
// discovery.ts

import type { MuSig2P2PCoordinator } from '../musig2/coordinator.js'
import type { SwapPool, PoolPrivacyConfig } from './types.js'

/**
 * Privacy-Preserving Pool Discovery
 *
 * Addresses DHT privacy leakage by:
 * 1. Anonymous pool announcements (no creator identity)
 * 2. Onion-routed DHT queries
 * 3. Encrypted participant lists
 */
export class SwapSigDiscovery {
  private coordinator: MuSig2P2PCoordinator
  private privacyConfig: PoolPrivacyConfig

  constructor(
    coordinator: MuSig2P2PCoordinator,
    privacyConfig: PoolPrivacyConfig,
  ) {
    this.coordinator = coordinator
    this.privacyConfig = privacyConfig
  }

  /**
   * Announce pool anonymously
   */
  async announcePool(pool: SwapPool): Promise<void> {
    // Create anonymous announcement
    const announcement: AnonymousPoolAnnouncement = {
      poolId: pool.poolId,
      denomination: pool.denomination,
      minParticipants: pool.minParticipants,
      maxParticipants: pool.maxParticipants,
      currentParticipants: pool.participants.length,

      // NO creator identity
      // Use ring signature to prove valid creation
      creatorProof: await this._createRingSignature(pool),

      // Encrypted metadata
      encryptedMetadata: this._encryptPoolMetadata(pool),

      // Expiration
      expiresAt: Date.now() + pool.setupTimeout + pool.settlementTimeout,
    }

    // Announce via onion routing if enabled
    if (this.privacyConfig.enableAnonymousPoolAnnouncement) {
      await this._announceViaOnionRoute(announcement)
    } else {
      await this.coordinator.announceResource(
        'swapsig-pool',
        pool.poolId,
        announcement,
      )
    }
  }

  /**
   * Discover pools with privacy
   */
  async discoverPools(filters: PoolFilters): Promise<PoolAnnouncement[]> {
    // Query DHT via Tor/onion if enabled
    let announcements: PoolAnnouncement[]

    if (this.privacyConfig.requireAnonymousTransport) {
      announcements = await this._queryViaOnionRoute(filters)
    } else {
      announcements = await this.coordinator.discoverResources(
        'swapsig-pool',
        filters,
      )
    }

    // Filter and validate
    return announcements
      .filter(a => this._validateAnnouncement(a))
      .filter(a => this._matchesFilters(a, filters))
  }

  /**
   * Join pool anonymously
   */
  async joinPool(poolId: string, participant: SwapParticipant): Promise<void> {
    // Create anonymous join message
    const joinMessage: AnonymousJoinMessage = {
      poolId,

      // Participant info (encrypted to pool creator)
      encryptedParticipant: await this._encryptParticipant(participant),

      // Proof of valid input (without revealing identity)
      inputProof: await this._createInputProof(participant),

      // Commitment to destination
      destinationCommitment: participant.destinationCommitment.commitment,
    }

    // Send via anonymous channel
    await this._sendAnonymousJoin(joinMessage)
  }

  private async _createRingSignature(pool: SwapPool): Promise<Buffer> {
    // Ring signature proves creator is a valid participant
    // without revealing which one
    // ... implementation using existing crypto
    return Buffer.alloc(64)
  }

  private async _announceViaOnionRoute(
    announcement: AnonymousPoolAnnouncement,
  ): Promise<void> {
    // Select random intermediate nodes
    const hops = await this._selectOnionHops(3)

    // Encrypt in layers (onion)
    let payload = Buffer.from(JSON.stringify(announcement))
    for (const hop of hops.reverse()) {
      payload = await this._encryptForHop(payload, hop)
    }

    // Send to first hop
    await this.coordinator.sendTo(hops[0], {
      type: 'swapsig:onion-announce',
      payload,
    })
  }
}
```

**Deliverables**:

- [ ] Anonymous pool announcements
- [ ] Onion-routed DHT operations
- [ ] Ring signature for creator proof
- [ ] Unit tests

---

### Phase 5: Timing Obfuscation (Week 3-4)

**Files to Create**:

- `timing.ts` - Timing decorrelation

**Implementation**:

```typescript
// timing.ts

/**
 * Timing Obfuscation
 *
 * Prevents timing correlation attacks by:
 * 1. Random delays with exponential distribution
 * 2. Broadcast window spreading
 * 3. Decoy transaction support
 */
export class TimingObfuscation {
  private config: TimingConfig

  constructor(config: TimingConfig) {
    this.config = config
  }

  /**
   * Get random delay with exponential distribution
   *
   * Exponential distribution is memoryless, making
   * timing analysis much harder than uniform distribution
   */
  getRandomDelay(windowMs: number): number {
    // Exponential distribution: -ln(U) * mean
    // Mean = window / 3 (so most delays are within window)
    const mean = windowMs / 3
    const u = Math.random()
    const delay = -Math.log(u) * mean

    // Cap at 2x window to prevent extreme outliers
    return Math.min(delay, windowMs * 2)
  }

  /**
   * Schedule transaction broadcast with obfuscation
   */
  async scheduleBroadcast(
    tx: Transaction,
    windowMs: number,
    broadcaster: TransactionBroadcaster,
  ): Promise<string> {
    const delay = this.getRandomDelay(windowMs)

    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          // Optionally use random broadcast node
          const node = this.config.useRandomBroadcastNode
            ? await this._selectRandomBroadcastNode()
            : broadcaster

          const txId = await node.broadcast(tx)
          resolve(txId)
        } catch (error) {
          reject(error)
        }
      }, delay)
    })
  }

  /**
   * Batch schedule multiple broadcasts
   * Ensures they're spread across the window
   */
  async scheduleBatchBroadcast(
    transactions: Transaction[],
    windowMs: number,
    broadcaster: TransactionBroadcaster,
  ): Promise<string[]> {
    // Assign random delays to each
    const scheduled = transactions.map(tx => ({
      tx,
      delay: this.getRandomDelay(windowMs),
    }))

    // Sort by delay for efficient scheduling
    scheduled.sort((a, b) => a.delay - b.delay)

    // Execute in order
    const results: string[] = []
    let lastDelay = 0

    for (const { tx, delay } of scheduled) {
      const waitTime = delay - lastDelay
      await sleep(waitTime)

      const txId = await broadcaster.broadcast(tx)
      results.push(txId)

      lastDelay = delay
    }

    return results
  }

  /**
   * Create decoy transaction (optional, high privacy)
   */
  async createDecoyTransaction(
    denomination: number,
    feeRate: number,
  ): Promise<Transaction | null> {
    if (!this.config.enableDecoys) {
      return null
    }

    // Create self-send transaction that looks like SwapSig setup
    // ... implementation
    return null
  }
}
```

**Deliverables**:

- [ ] Exponential delay distribution
- [ ] Batch broadcast scheduling
- [ ] Decoy transaction support
- [ ] Unit tests

---

### Phase 6: Pool & Protocol Management (Week 4-5)

**Files to Create**:

- `pool.ts` - Pool lifecycle management
- `protocol.ts` - Protocol state machine

**Key Implementation Points**:

```typescript
// protocol.ts

/**
 * SwapSig Protocol State Machine
 *
 * Phases:
 * 1. DISCOVERY - Find/create pool
 * 2. REGISTRATION - Register inputs with ownership proof
 * 3. COMMITMENT - Submit destination commitments
 * 4. SETUP - Build and broadcast setup transactions
 * 5. SETUP_CONFIRM - Wait for confirmations
 * 6. REVEAL - Reveal destinations to settlement partners
 * 7. SETTLEMENT - MuSig2 signing and broadcast
 * 8. SETTLEMENT_CONFIRM - Wait for confirmations
 * 9. COMPLETE - Cleanup
 */
export class SwapSigProtocol extends EventEmitter {
  private pool: SwapPool
  private coordinator: MuSig2P2PCoordinator
  private discovery: SwapSigDiscovery
  private commitment: SecureDestinationCommitment
  private burn: StealthBurnMechanism
  private timing: TimingObfuscation

  /**
   * Execute complete swap protocol
   */
  async executeSwap(
    input: SwapInput,
    destination: Address,
  ): Promise<SwapResult> {
    // Phase 1-2: Registration
    await this._executeRegistration(input)

    // Phase 3: Commitment
    await this._executeCommitment(destination)

    // Phase 4-5: Setup
    await this._executeSetup()

    // Phase 6: Reveal (to settlement partners only)
    await this._executeReveal()

    // Phase 7-8: Settlement
    await this._executeSettlement()

    return this._getResult()
  }

  /**
   * Execute reveal phase with coordinator blindness
   */
  private async _executeReveal(): Promise<void> {
    this._transitionPhase(SwapPhase.REVEAL)

    // Determine my settlement partners
    const myIndex = this._getMyParticipantIndex()
    const myGroup = this._getMyOutputGroup()

    // Reveal destination ONLY to settlement partners
    // NOT to coordinator or other participants
    for (const partnerIndex of myGroup.participantIndices) {
      if (partnerIndex === myIndex) continue

      const partner = this.pool.participants[partnerIndex]

      // Decrypt my destination for this partner
      const encryptedDest = this._myCommitment.encryptedDestinations.get(
        partner.peerId,
      )

      // Send reveal directly to partner (not broadcast)
      await this.coordinator.sendTo(partner.peerId, {
        type: 'swapsig:destination-reveal',
        payload: {
          poolId: this.pool.poolId,
          participantIndex: myIndex,
          destination: this._myDestination.toString(),
          blindingFactor: this._myBlindingFactor.toString('hex'),
        },
      })
    }

    // Wait for reveals from partners
    await this._waitForPartnerReveals()

    // Verify all commitments
    this._verifyAllReveals()
  }

  /**
   * Execute settlement with three-phase MuSig2
   */
  private async _executeSettlement(): Promise<void> {
    this._transitionPhase(SwapPhase.SETTLEMENT)

    // Get my output groups (groups I'm a signer for)
    const myGroups = this._getMyOutputGroups()

    for (const group of myGroups) {
      // Build settlement transaction
      const settlementTx = this._buildSettlementTransaction(group)

      // Compute sighash
      const sighash = this._computeSighash(settlementTx, group)

      // Create signing request (Phase 2 of MuSig2 P2P)
      const requestId = await this.coordinator.announceSigningRequest(
        group.signers,
        sighash,
        this._myPrivateKey,
        {
          metadata: {
            swapPoolId: this.pool.poolId,
            groupIndex: group.groupIndex,
            transactionType: 'swap-settlement',
          },
        },
      )

      group.signingRequestId = requestId

      // Wait for session creation (all signers join)
      const sessionId = await this._waitForSessionReady(requestId)
      group.sessionId = sessionId

      // MuSig2 rounds happen automatically via P2P coordinator
      // Wait for completion
      const signature = await this.coordinator.getFinalSignature(sessionId)

      // Add signature to transaction
      this._addSignature(settlementTx, signature)

      // Broadcast with timing obfuscation
      const txId = await this.timing.scheduleBroadcast(
        settlementTx,
        this.pool.privacyConfig.settlementBroadcastWindowMs,
        this._broadcaster,
      )

      group.settlementTxId = txId
    }

    // Wait for all settlements to confirm
    await this._waitForSettlementConfirmations()

    this._transitionPhase(SwapPhase.COMPLETE)
  }
}
```

**Deliverables**:

- [ ] Pool lifecycle management
- [ ] Protocol state machine
- [ ] Phase transition logic
- [ ] Event emission
- [ ] Unit tests

---

### Phase 7: Main Coordinator (Week 5-6)

**Files to Create**:

- `coordinator.ts` - Main SwapSigCoordinator class

**Implementation**:

```typescript
// coordinator.ts

import { EventEmitter } from 'events'
import type { MuSig2P2PCoordinator } from '../musig2/coordinator.js'
import { SwapSigDiscovery } from './discovery.js'
import { SwapSigProtocol } from './protocol.js'
import { SecureDestinationCommitment } from './commitment.js'
import { StealthBurnMechanism } from './burn.js'
import { TimingObfuscation } from './timing.js'
import type {
  SwapSigConfig,
  SwapPool,
  SwapParticipant,
  SwapResult,
  PoolFilters,
} from './types.js'

/**
 * SwapSig Coordinator
 *
 * Main entry point for SwapSig privacy protocol.
 * Coordinates pool discovery, participant registration,
 * and swap execution using MuSig2 P2P infrastructure.
 */
export class SwapSigCoordinator extends EventEmitter {
  private musig2Coordinator: MuSig2P2PCoordinator
  private config: Required<SwapSigConfig>

  // Components
  private discovery: SwapSigDiscovery
  private burnMechanism: StealthBurnMechanism
  private timing: TimingObfuscation

  // Active pools
  private pools: Map<string, SwapPool> = new Map()
  private activeProtocols: Map<string, SwapSigProtocol> = new Map()

  constructor(config: SwapSigConfig) {
    super()

    this.config = this._mergeWithDefaults(config)
    this.musig2Coordinator = config.musig2Coordinator

    // Initialize components
    this.discovery = new SwapSigDiscovery(
      this.musig2Coordinator,
      this.config.privacyConfig,
    )

    this.burnMechanism = new StealthBurnMechanism(this.config.burnConfig)

    this.timing = new TimingObfuscation(this.config.timingConfig)

    // Setup event handlers
    this._setupEventHandlers()
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Discover available swap pools
   */
  async discoverPools(filters?: PoolFilters): Promise<PoolAnnouncement[]> {
    return this.discovery.discoverPools(filters || {})
  }

  /**
   * Get recommended pools (sorted by quality)
   */
  async getRecommendedPools(denomination: number): Promise<PoolAnnouncement[]> {
    const pools = await this.discoverPools({ denomination })

    return pools
      .filter(p => p.currentParticipants < p.maxParticipants)
      .sort((a, b) => this._scorePool(b) - this._scorePool(a))
  }

  /**
   * Create new swap pool
   */
  async createPool(params: CreatePoolParams): Promise<string> {
    // Generate random pool ID (not derived from creator)
    const poolId = this._generateRandomPoolId()

    // Create pool
    const pool: SwapPool = {
      poolId,
      denomination: params.denomination,
      minParticipants: params.minParticipants || 3,
      maxParticipants: params.maxParticipants || 10,
      feeRate: params.feeRate || 1,

      privacyConfig: this.config.privacyConfig,
      burnConfig: this.config.burnConfig,

      participants: [],
      participantMap: new Map(),
      outputGroups: [],
      settlementMapping: new Map(),

      phase: SwapPhase.DISCOVERY,
      createdAt: Date.now(),
      aborted: false,

      setupTimeout: params.setupTimeout || 600000,
      settlementTimeout: params.settlementTimeout || 600000,
    }

    this.pools.set(poolId, pool)

    // Announce anonymously
    await this.discovery.announcePool(pool)

    this.emit('pool:created', poolId, pool)

    return poolId
  }

  /**
   * Join existing pool
   */
  async joinPool(
    poolId: string,
    input: SwapInput,
    destination: Address,
  ): Promise<void> {
    // Validate input
    await this._validateInput(input)

    // Create secure destination commitment
    const { commitment, blindingFactor } =
      SecureDestinationCommitment.commit(destination)

    // Encrypt destination for all potential partners
    const encryptedDestinations = new Map<string, Buffer>()
    // (Will be populated as we learn about other participants)

    // Create participant
    const participant: SwapParticipant = {
      peerId: this.musig2Coordinator.myPeerId,
      participantIndex: -1, // Assigned by pool
      publicKey: this._myPublicKey,

      input,
      ownershipProof: await this._createOwnershipProof(input, poolId),

      destinationCommitment: {
        commitment,
        encryptedDestinations,
      },

      setupConfirmed: false,
      burnVerified: false,
      joinedAt: Date.now(),
    }

    // Store for later
    this._myDestination = destination
    this._myBlindingFactor = blindingFactor

    // Join via discovery (anonymous)
    await this.discovery.joinPool(poolId, participant)

    this.emit('pool:joined', poolId)
  }

  /**
   * Execute complete swap
   */
  async executeSwap(
    poolId: string,
    input: SwapInput,
    destination: Address,
  ): Promise<SwapResult> {
    // Join pool
    await this.joinPool(poolId, input, destination)

    // Get or create protocol instance
    let protocol = this.activeProtocols.get(poolId)
    if (!protocol) {
      protocol = new SwapSigProtocol(
        this.pools.get(poolId)!,
        this.musig2Coordinator,
        this.discovery,
        this.burnMechanism,
        this.timing,
      )
      this.activeProtocols.set(poolId, protocol)
    }

    // Execute swap
    const result = await protocol.executeSwap(input, destination)

    // Cleanup
    this.activeProtocols.delete(poolId)

    return result
  }

  /**
   * Get pool status
   */
  getPoolStatus(poolId: string): PoolStatus | undefined {
    const pool = this.pools.get(poolId)
    if (!pool) return undefined

    return {
      poolId,
      phase: pool.phase,
      participants: pool.participants.length,
      minRequired: pool.minParticipants,
      maxAllowed: pool.maxParticipants,
      setupComplete: pool.phase >= SwapPhase.SETUP_CONFIRM,
      settlementsComplete: pool.phase === SwapPhase.COMPLETE,
      healthy: !pool.aborted,
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private _setupEventHandlers(): void {
    // Handle signing requests for SwapSig settlements
    this.musig2Coordinator.on('signing-request:received', async request => {
      if (request.metadata?.transactionType !== 'swap-settlement') return

      const poolId = request.metadata.swapPoolId
      const protocol = this.activeProtocols.get(poolId)

      if (protocol) {
        await protocol.handleSigningRequest(request)
      }
    })

    // Handle session ready events
    this.musig2Coordinator.on('session:ready', (sessionId, requestId) => {
      // Forward to relevant protocol
      for (const protocol of this.activeProtocols.values()) {
        protocol.handleSessionReady(sessionId, requestId)
      }
    })
  }

  private _generateRandomPoolId(): string {
    // Random 32-byte ID (not derived from creator identity)
    return Hash.sha256(
      Buffer.concat([
        Buffer.from(Date.now().toString()),
        Buffer.from(Math.random().toString()),
        PrivateKey.fromRandom().toBuffer(),
      ]),
    ).toString('hex')
  }

  private _scorePool(pool: PoolAnnouncement): number {
    // Score based on:
    // - Participant count (more = better anonymity)
    // - Time remaining (more = better)
    // - Group size strategy (5-of-5 preferred)
    let score = 0

    score += pool.currentParticipants * 10
    score += (pool.expiresAt - Date.now()) / 60000 // Minutes remaining

    if (pool.currentParticipants >= 15 && pool.currentParticipants <= 49) {
      score += 50 // Sweet spot for 5-of-5
    }

    return score
  }
}
```

**Deliverables**:

- [ ] Main coordinator class
- [ ] Public API implementation
- [ ] Event handling
- [ ] Integration with MuSig2 P2P
- [ ] Unit tests

---

### Phase 8: Validation & Security (Week 6)

**Files to Create**:

- `validation.ts` - Input/output validation
- `security.ts` - Security mechanisms

**Deliverables**:

- [ ] Input validation
- [ ] Output validation
- [ ] Burn verification
- [ ] Ownership proof validation
- [ ] Rate limiting
- [ ] Unit tests

---

### Phase 9: Integration Testing (Week 7)

**Test Files to Create**:

```
test/p2p/swapsig/
├── commitment.test.ts
├── burn.test.ts
├── discovery.test.ts
├── timing.test.ts
├── protocol.test.ts
├── coordinator.test.ts
├── integration.test.ts
├── privacy.test.ts
└── security.test.ts
```

**Test Scenarios**:

- [ ] 3-party swap (2-of-2 groups)
- [ ] 5-party swap (2-of-2 groups)
- [ ] 10-party swap (3-of-3 groups)
- [ ] 25-party swap (5-of-5 groups)
- [ ] Participant abandonment
- [ ] Coordinator failover
- [ ] Timing obfuscation verification
- [ ] Burn verification
- [ ] Commitment scheme security
- [ ] DHT privacy verification
- [ ] Intersection attack prevention [NEW]
- [ ] Fee rate fingerprinting resistance [NEW]
- [ ] Amount correlation resistance [NEW]
- [ ] Timelock refund execution [NEW]
- [ ] Decoy transaction generation [NEW]
- [ ] Privacy mode switching [NEW]

---

### Phase 10: Wallet Integration & Intersection Prevention (Week 6-7) [NEW]

**Files to Create**:

- `wallet.ts` - SwapSig wallet integration

**Implementation**:

```typescript
// wallet.ts

/**
 * SwapSig Wallet Integration
 *
 * Prevents intersection attacks by:
 * 1. Tracking which outputs came from which pools
 * 2. Preventing combination of outputs from different pools
 * 3. Enforcing output cooldown periods
 */
export class SwapSigWallet {
  // Track output origins
  private outputPoolMapping: Map<string, PoolInfo> = new Map()

  // Cooldown tracking
  private outputLastUsed: Map<string, number> = new Map()

  /**
   * Register output from completed swap
   */
  registerSwapOutput(utxo: UTXO, poolInfo: PoolInfo): void {
    const key = `${utxo.txid}:${utxo.vout}`
    this.outputPoolMapping.set(key, poolInfo)
    this.outputLastUsed.set(key, Date.now())
  }

  /**
   * Validate transaction doesn't create intersection risk
   */
  validateTransactionPrivacy(inputs: UTXO[]): PrivacyRisk {
    const pools = new Set<string>()

    for (const input of inputs) {
      const key = `${input.txid}:${input.vout}`
      const poolInfo = this.outputPoolMapping.get(key)

      if (poolInfo) {
        pools.add(poolInfo.poolId)
      }
    }

    if (pools.size > 1) {
      return {
        level: 'CRITICAL',
        reason: 'INTERSECTION_ATTACK',
        message: `Combining outputs from ${pools.size} different pools`,
        pools: Array.from(pools),
      }
    }

    return { level: 'SAFE', reason: 'NO_INTERSECTION' }
  }

  /**
   * Check output cooldown
   */
  isOutputCooledDown(utxo: UTXO, cooldownMs: number): boolean {
    const key = `${utxo.txid}:${utxo.vout}`
    const lastUsed = this.outputLastUsed.get(key)

    if (!lastUsed) return true
    return Date.now() - lastUsed >= cooldownMs
  }
}
```

**Deliverables**:

- [ ] Output pool tracking
- [ ] Intersection risk detection
- [ ] Cooldown enforcement
- [ ] Wallet integration API
- [ ] Unit tests

---

### Phase 11: Timelock Refund Scripts (Week 7) [NEW]

**Files to Create**:

- `refund.ts` - Lotus OP_CHECKSEQUENCEVERIFY refund scripts

**Implementation**:

```typescript
// refund.ts

import { Script, Opcode } from '../../bitcore/index.js'
import type { PublicKey } from '../../bitcore/publickey.js'

/**
 * Timelock Refund Scripts
 *
 * Uses Lotus OP_CHECKSEQUENCEVERIFY for trustless refunds.
 * If settlement fails, original owner can reclaim after timeout.
 */
export class TimelockRefund {
  /**
   * Build refund script for Taproot script-spend path
   *
   * Script: <timeout> OP_CSV OP_DROP <pubkey> OP_CHECKSIG
   */
  static buildRefundScript(
    ownerPubkey: PublicKey,
    timeoutBlocks: number, // e.g., 720 blocks = ~1 day on Lotus
  ): Script {
    return new Script()
      .add(Script.encodeNumber(timeoutBlocks))
      .add(Opcode.OP_CHECKSEQUENCEVERIFY)
      .add(Opcode.OP_DROP)
      .add(ownerPubkey.toBuffer())
      .add(Opcode.OP_CHECKSIG)
  }

  /**
   * Build Taproot output with refund path
   */
  static buildTaprootWithRefund(
    musig2AggKey: PublicKey,
    refundScript: Script,
  ): TaprootOutput {
    // Compute tapleaf hash
    const tapleafHash = Hash.taggedHash(
      'TapLeaf',
      Buffer.concat([
        Buffer.from([0xc0]), // TAPROOT_LEAF_TAPSCRIPT
        refundScript.toBuffer(),
      ]),
    )

    // Tweak aggregated key
    const tweakHash = Hash.taggedHash(
      'TapTweak',
      Buffer.concat([musig2AggKey.toBuffer(), tapleafHash]),
    )

    const commitment = musig2AggKey.point.add(
      Point.fromScalar(BN.fromBuffer(tweakHash)),
    )

    return {
      commitment: new PublicKey(commitment),
      internalKey: musig2AggKey,
      tapleafHash,
      refundScript,
    }
  }

  /**
   * Build refund transaction (script-spend path)
   */
  static buildRefundTransaction(
    taprootUtxo: UTXO,
    refundScript: Script,
    controlBlock: Buffer,
    ownerPrivkey: PrivateKey,
    destinationAddress: Address,
    feeRate: number,
  ): Transaction {
    const tx = new Transaction()
      .from(taprootUtxo)
      .to(destinationAddress, taprootUtxo.satoshis - estimateFee(feeRate))

    // Set sequence for CSV
    tx.inputs[0].sequenceNumber = timeoutBlocks

    // Sign with owner key
    const signature = this._signScriptSpend(tx, ownerPrivkey, refundScript)

    // Build scriptSig for Taproot script-spend
    tx.inputs[0].setScript(
      new Script()
        .add(signature)
        .add(refundScript.toBuffer())
        .add(controlBlock),
    )

    return tx
  }
}
```

**Deliverables**:

- [ ] Refund script construction
- [ ] Taproot with script-spend path
- [ ] Refund transaction building
- [ ] CSV timeout handling
- [ ] Unit tests

---

### Phase 12: Fee & Amount Obfuscation (Week 7) [NEW]

**Files to Create**:

- `obfuscation.ts` - Fee rate and amount randomization

**Implementation**:

```typescript
// obfuscation.ts

/**
 * Fee & Amount Obfuscation
 *
 * Prevents fingerprinting via:
 * 1. Randomized fee rates (±20%)
 * 2. Slight amount variance (±1%)
 * 3. Random padding for burns
 */
export class Obfuscation {
  private config: ObfuscationConfig

  constructor(config: ObfuscationConfig) {
    this.config = config
  }

  /**
   * Get randomized fee rate
   */
  getRandomizedFeeRate(baseFeeRate: number): number {
    if (!this.config.enableFeeRandomization) {
      return baseFeeRate
    }

    const variance = baseFeeRate * this.config.feeVariancePercent
    const offset = (Math.random() - 0.5) * 2 * variance
    return Math.max(1, baseFeeRate + offset)
  }

  /**
   * Get randomized amount
   */
  getRandomizedAmount(baseAmount: number): number {
    if (!this.config.enableAmountVariance) {
      return baseAmount
    }

    const variance = baseAmount * this.config.amountVariancePercent
    const offset = (Math.random() - 0.5) * 2 * variance
    return Math.floor(baseAmount + offset)
  }

  /**
   * Get burn amount with random padding
   */
  getBurnWithPadding(baseBurn: number): number {
    if (!this.config.enableBurnPadding) {
      return baseBurn
    }

    const padding = Math.random() * baseBurn * this.config.burnPaddingPercent
    return Math.floor(baseBurn + padding)
  }
}

export interface ObfuscationConfig {
  enableFeeRandomization: boolean
  feeVariancePercent: number // e.g., 0.2 = ±20%

  enableAmountVariance: boolean
  amountVariancePercent: number // e.g., 0.01 = ±1%

  enableBurnPadding: boolean
  burnPaddingPercent: number // e.g., 0.5 = 0-50% extra
}
```

**Deliverables**:

- [ ] Fee rate randomization
- [ ] Amount variance
- [ ] Burn padding
- [ ] Configuration interface
- [ ] Unit tests

---

### Phase 13: Decoy Transactions (Week 7-8) [NEW]

**Files to Create**:

- `decoy.ts` - Decoy transaction generation

**Implementation**:

```typescript
// decoy.ts

/**
 * Decoy Transaction Generator
 *
 * Creates self-send transactions that look like SwapSig
 * to obscure real SwapSig transactions in the graph.
 */
export class DecoyGenerator {
  /**
   * Create decoy setup transaction
   *
   * Looks like: input → Taproot output
   * But is actually: self-send to own Taproot address
   */
  async createDecoySetup(
    wallet: SwapSigWallet,
    denomination: number,
    feeRate: number,
  ): Promise<Transaction> {
    // Select input matching denomination
    const input = await wallet.selectUTXO(denomination)

    // Generate new Taproot address (self-owned)
    const taprootAddress = await wallet.getNewTaprootAddress()

    // Build transaction that looks like SwapSig setup
    const tx = new Transaction()
      .from(input)
      .to(taprootAddress, denomination - estimateFee(feeRate))

    // Sign with wallet key
    tx.sign(wallet.privateKey)

    return tx
  }

  /**
   * Create decoy settlement transaction
   */
  async createDecoySettlement(
    wallet: SwapSigWallet,
    taprootUtxo: UTXO,
    feeRate: number,
  ): Promise<Transaction> {
    // Get new regular address
    const finalAddress = await wallet.getNewAddress()

    // Build transaction that looks like SwapSig settlement
    const tx = new Transaction()
      .from(taprootUtxo)
      .to(finalAddress, taprootUtxo.satoshis - estimateFee(feeRate))

    // Sign (key-spend path)
    tx.sign(wallet.privateKey)

    return tx
  }

  /**
   * Schedule decoy broadcasts around real SwapSig
   */
  async scheduleDecoys(
    realTxs: Transaction[],
    decoyRate: number,  // e.g., 0.2 = 20% decoys
    broadcastWindowMs: number,
  ): Promise<void> {
    const decoyCount = Math.floor(realTxs.length * decoyRate)

    for (let i = 0; i < decoyCount; i++) {
      const delay = Math.random() * broadcastWindowMs
      const decoyTx = await this.createDecoySetup(...)

      setTimeout(() => {
        this.broadcast(decoyTx)
      }, delay)
    }
  }
}
```

**Deliverables**:

- [ ] Decoy setup transactions
- [ ] Decoy settlement transactions
- [ ] Decoy scheduling
- [ ] Integration with timing obfuscation
- [ ] Unit tests

---

### Phase 14: Documentation & Examples (Week 8)

**Files to Create**:

- `README.md` - Module documentation
- `examples/swapsig-basic.ts`
- `examples/swapsig-advanced.ts`
- `examples/swapsig-privacy-config.ts`
- `examples/swapsig-wallet-integration.ts` [NEW]
- `examples/swapsig-refund.ts` [NEW]

---

## File Summary

| File             | Lines (Est.) | Priority | Week    | Notes                          |
| ---------------- | ------------ | -------- | ------- | ------------------------------ |
| `types.ts`       | ~500         | P0       | 1       | +privacy modes, +wallet types  |
| `errors.ts`      | ~100         | P0       | 1       |                                |
| `index.ts`       | ~50          | P0       | 1       |                                |
| `commitment.ts`  | ~300         | P0       | 2       |                                |
| `burn.ts`        | ~250         | P0       | 2-3     |                                |
| `discovery.ts`   | ~350         | P0       | 3       |                                |
| `timing.ts`      | ~200         | P1       | 3-4     |                                |
| `pool.ts`        | ~400         | P0       | 4-5     |                                |
| `protocol.ts`    | ~600         | P0       | 4-5     |                                |
| `coordinator.ts` | ~500         | P0       | 5-6     |                                |
| `validation.ts`  | ~300         | P1       | 6       |                                |
| `security.ts`    | ~200         | P1       | 6       |                                |
| `wallet.ts`      | ~350         | P0       | 6-7     | [NEW] Intersection prevention  |
| `refund.ts`      | ~250         | P1       | 7       | [NEW] Lotus CSV timelocks      |
| `obfuscation.ts` | ~200         | P1       | 7       | [NEW] Fee/amount randomization |
| `decoy.ts`       | ~150         | P2       | 7-8     | [NEW] Decoy transactions       |
| `README.md`      | ~300         | P2       | 8       |                                |
| **Total**        | **~5,000**   | -        | 8 weeks | +30% from v2 requirements      |

---

## Dependencies

### Required (Existing)

- `lib/p2p/musig2/coordinator.ts` - MuSig2 P2P coordination
- `lib/p2p/musig2/discovery-extension.ts` - Discovery layer
- `lib/bitcore/musig2/session.ts` - MuSig2 session management
- `lib/bitcore/crypto/` - Cryptographic primitives
- `lib/bitcore/transaction/` - Transaction construction

### New Dependencies

- None (uses existing infrastructure)

---

## Success Criteria

1. **Privacy**: No on-chain protocol fingerprinting
2. **Security**: All gaps from v1 and v2 security analysis addressed
3. **Performance**: 5-party swap completes in <10 minutes
4. **Reliability**: 95%+ success rate for swaps
5. **Testing**: >90% code coverage
6. **Intersection Prevention**: Wallet integration prevents output mixing [NEW]
7. **Trustless Refunds**: Timelock refunds work without coordinator [NEW]
8. **Fingerprint Resistance**: Fee/amount obfuscation passes analysis [NEW]

---

## Risk Mitigation

| Risk                           | Mitigation                                   |
| ------------------------------ | -------------------------------------------- |
| Pedersen commitment complexity | Use existing Point/BN primitives             |
| Onion routing complexity       | Start with Tor integration, add custom later |
| Timing analysis                | Exponential distribution is proven effective |
| DHT privacy                    | Anonymous announcements + Tor queries        |
| Intersection attacks           | Wallet-level output isolation [NEW]          |
| Fee fingerprinting             | ±20% fee variance [NEW]                      |
| Amount correlation             | ±1% amount variance [NEW]                    |
| Stuck funds                    | Lotus CSV timelock refunds [NEW]             |
| Graph analysis                 | Decoy transactions + pool chaining [NEW]     |

---

## Lotus-Specific Features Used

| Feature                  | Usage in SwapSig                      |
| ------------------------ | ------------------------------------- |
| `SIGHASH_LOTUS`          | Required for Taproot key-spend        |
| `OP_CHECKSEQUENCEVERIFY` | Timelock refund scripts               |
| `OP_CHECKLOCKTIMEVERIFY` | Alternative absolute timelock refunds |
| Taproot (OP_SCRIPTTYPE)  | MuSig2 shared outputs                 |
| Taproot script-spend     | Refund path (hidden unless used)      |
| Schnorr signatures       | All SwapSig signatures                |

---

**Document Version**: 2.1  
**Last Updated**: November 28, 2025  
**Status**: Ready for Implementation (Updated with v2 Security Analysis)
