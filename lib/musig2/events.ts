/**
 * MuSig2 Event Type Definitions
 *
 * Provides strongly-typed event maps for MuSig2 coordinators.
 * These types ensure event handlers receive correctly typed data.
 *
 * Usage in consumers (e.g., wallet UI):
 * ```typescript
 * import { MuSig2Event, MuSig2EventMap } from 'lotus-sdk'
 *
 * discovery.on(MuSig2Event.SIGNER_DISCOVERED, (data: MuSig2EventMap['musig2:signer-discovered']) => {
 *   console.log('Signer discovered:', data.id, data.publicKey.toString())
 * })
 * ```
 */

import type { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import type {
  MuSig2P2PSession,
  SessionAnnouncement,
  TransactionType,
} from './types.js'
import type { SerializedSignature } from './serialization.js'

// ============================================================================
// Signer Discovery Events
// ============================================================================

/**
 * Data emitted when a signer is discovered via DHT or GossipSub
 * This is the canonical type for signer advertisements
 *
 * Note: This type matches MuSig2SignerAdvertisement from discovery-types.ts
 * but is designed for event consumption with guaranteed required fields
 */
export interface SignerDiscoveredEventData {
  /** Unique advertisement ID */
  id: string

  /** Peer information */
  peerInfo: {
    /** libp2p peer ID */
    peerId: string
    /** Multiaddresses for connection (may be empty if not yet known) */
    multiaddrs?: string[]
  }

  /** Signer's public key */
  publicKey: PublicKey

  /** Transaction types the signer supports */
  transactionTypes: TransactionType[]

  /** Amount range the signer is willing to sign (satoshis) */
  amountRange?: {
    min?: number
    max?: number
  }

  /** Signer metadata */
  signerMetadata?: {
    /** User-friendly nickname */
    nickname?: string
    /** Description of services */
    description?: string
    /** Fee for signing (satoshis) */
    fee?: number
    /** Average response time (milliseconds) */
    averageResponseTime?: number
    /** Burn-based identity information */
    identity?: {
      identityId: string
      totalBurned: number
      maturationBlocks: number
      registeredAt: number
    }
  }

  /** Reputation score (0-100) */
  reputation: number

  /** When the advertisement was created */
  createdAt: number

  /** When the advertisement expires */
  expiresAt: number
}

/**
 * Data emitted when a signer advertisement is withdrawn
 */
export interface SignerWithdrawnEventData {
  /** The advertisement ID that was withdrawn */
  advertisementId: string
  /** Timestamp of withdrawal */
  timestamp: number
}

/**
 * Data emitted when a signer is successfully advertised
 */
export interface SignerAdvertisedEventData {
  /** The advertisement ID */
  advertisementId: string
  /** The public key being advertised */
  publicKey: PublicKey
  /** Transaction types advertised */
  transactionTypes: TransactionType[]
  /** Timestamp */
  timestamp: number
}

// ============================================================================
// Signing Request Events
// ============================================================================

/**
 * Data emitted when a signing request is created
 */
export interface SigningRequestCreatedEventData {
  /** Unique request ID */
  requestId: string
  /** Required public keys (all must sign) */
  requiredPublicKeys: string[]
  /** Message hash to sign */
  messageHash: string
  /** Creator peer ID */
  creatorPeerId: string
  /** Creator public key */
  creatorPublicKey: string
  /** Request metadata */
  requestMetadata?: {
    transactionHex?: string
    amount?: number
    transactionType?: TransactionType
    purpose?: string
  }
  /** When the request was created */
  createdAt: number
  /** When the request expires */
  expiresAt: number
}

/**
 * Data emitted when a signing request is received
 */
export interface SigningRequestReceivedEventData
  extends SigningRequestCreatedEventData {
  /** Peer info of the requester */
  peerInfo: {
    peerId: string
    multiaddrs: string[]
  }
}

/**
 * Data emitted when joining a signing request
 */
export interface SigningRequestJoinedEventData {
  /** The request ID that was joined */
  requestId: string
  /** Timestamp */
  timestamp: number
}

// ============================================================================
// Session Events
// ============================================================================

/**
 * Data emitted when a session is discovered on the network
 */
export interface SessionDiscoveredEventData {
  /** Session announcement */
  announcement: SessionAnnouncement
  /** Timestamp of discovery */
  timestamp: number
}

/**
 * Data emitted when a session is created locally
 */
export interface SessionCreatedEventData {
  /** Session ID */
  sessionId: string
  /** The full session object */
  session: MuSig2P2PSession
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when a participant joins a session
 */
export interface ParticipantJoinedEventData {
  /** Session ID */
  sessionId: string
  /** Peer ID of the participant */
  peerId: string
  /** Signer index in the session */
  signerIndex: number
  /** Public key of the participant */
  publicKey: PublicKey
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when all participants have joined
 */
export interface SessionReadyEventData {
  /** Session ID */
  sessionId: string
  /** Number of participants */
  participantCount: number
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when a nonce is received
 */
export interface NonceReceivedEventData {
  /** Session ID */
  sessionId: string
  /** Signer index */
  signerIndex: number
  /** Peer ID of the sender */
  peerId: string
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when all nonces are collected
 */
export interface NoncesCompleteEventData {
  /** Session ID */
  sessionId: string
  /** Number of nonces collected */
  nonceCount: number
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when a partial signature is received
 */
export interface PartialSigReceivedEventData {
  /** Session ID */
  sessionId: string
  /** Signer index */
  signerIndex: number
  /** Peer ID of the sender */
  peerId: string
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when all partial signatures are collected
 */
export interface PartialSigsCompleteEventData {
  /** Session ID */
  sessionId: string
  /** Number of signatures collected */
  signatureCount: number
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when a session completes successfully
 */
export interface SessionCompleteEventData {
  /** Session ID */
  sessionId: string
  /** The final aggregated signature */
  signature: SerializedSignature
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when a session is aborted
 */
export interface SessionAbortedEventData {
  /** Session ID */
  sessionId: string
  /** Reason for abort */
  reason: string
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when a session times out
 */
export interface SessionTimeoutEventData {
  /** Session ID */
  sessionId: string
  /** Phase when timeout occurred */
  phase: string
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted on session error
 */
export interface SessionErrorEventData {
  /** Session ID */
  sessionId: string
  /** Error message */
  message: string
  /** Error code */
  code?: string
  /** Original error */
  error?: Error
  /** Timestamp */
  timestamp: number
}

// ============================================================================
// Coordinator Election Events
// ============================================================================

/**
 * Data emitted when a coordinator is elected
 */
export interface CoordinatorElectedEventData {
  /** Session ID */
  sessionId: string
  /** Coordinator index */
  coordinatorIndex: number
  /** Coordinator public key */
  coordinatorPublicKey: PublicKey
  /** Election method used */
  electionMethod: string
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when you should broadcast (you are coordinator)
 */
export interface ShouldBroadcastEventData {
  /** Session ID */
  sessionId: string
  /** Transaction to broadcast */
  transactionHex: string
  /** Timestamp */
  timestamp: number
}

/**
 * Data emitted when coordinator fails
 */
export interface CoordinatorFailedEventData {
  /** Session ID */
  sessionId: string
  /** Failed coordinator index */
  failedIndex: number
  /** New coordinator index */
  newCoordinatorIndex: number
  /** Timestamp */
  timestamp: number
}

export interface BroadcastConfirmedEventData {
  /** Session ID */
  sessionId: string
  /** ID of the broadcasted transaction (returned from successful Chronik API request) */
  txid: string
  /** Event timestamp */
  timestamp: number
}

// ============================================================================
// MuSig2 Event Map
// ============================================================================

/**
 * Complete MuSig2 Event Map
 * Maps event names to their data types for strong typing
 */
export interface MuSig2EventMap {
  // Discovery events
  'musig2:signer-discovered': [SignerDiscoveredEventData]
  'musig2:signer-withdrawn': [SignerWithdrawnEventData]
  'musig2:signer-advertised': [SignerAdvertisedEventData]

  // Signing request events
  'musig2:signing-request-created': [SigningRequestCreatedEventData]
  'musig2:signing-request-received': [SigningRequestReceivedEventData]
  'musig2:signing-request-joined': [SigningRequestJoinedEventData]

  // Session lifecycle events
  'musig2:session-discovered': [SessionDiscoveredEventData]
  'musig2:session-created': [SessionCreatedEventData]
  'musig2:participant-joined': [ParticipantJoinedEventData]
  'musig2:session-ready': [SessionReadyEventData]

  // MuSig2 protocol events
  'musig2:nonce-received': [NonceReceivedEventData]
  'musig2:nonces-complete': [NoncesCompleteEventData]
  'musig2:partial-sig-received': [PartialSigReceivedEventData]
  'musig2:partial-sigs-complete': [PartialSigsCompleteEventData]

  // Session completion events
  'musig2:session-complete': [SessionCompleteEventData]
  'musig2:session-aborted': [SessionAbortedEventData]
  'musig2:session-timeout': [SessionTimeoutEventData]
  'musig2:session-error': [SessionErrorEventData]

  // Coordinator events
  'musig2:coordinator-elected': [CoordinatorElectedEventData]
  'musig2:should-broadcast': [ShouldBroadcastEventData]
  'musig2:coordinator-failed': [CoordinatorFailedEventData]
  'musig2:failover-exhausted': [{ sessionId: string; timestamp: number }]
  'musig2:broadcast-confirmed': [BroadcastConfirmedEventData]
}

/**
 * Type helper to get event data type from event name
 */
export type MuSig2EventData<E extends keyof MuSig2EventMap> = MuSig2EventMap[E]
