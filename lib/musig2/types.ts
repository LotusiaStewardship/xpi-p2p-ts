/**
 * MuSig2 P2P Coordination Types
 *
 * Type definitions for coordinating MuSig2 multi-signature sessions over P2P networks
 */

import type { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import type { MuSigSession } from 'xpi-ts/lib/bitcore/musig2/session'

// ============================================================================
// Message Types
// ============================================================================

/**
 * MuSig2 protocol message types
 */
export enum MuSig2MessageType {
  /** Announce a new session on GossipSub (discovery) */
  SESSION_ANNOUNCEMENT = 'musig2:session-announcement',

  /** Request to join a session (direct P2P) */
  SESSION_JOIN = 'musig2:session-join',

  /** Accept join request (direct P2P) */
  SESSION_JOIN_ACK = 'musig2:session-join-ack',

  /** Share public nonces (MuSig2 Round 1 - direct P2P) */
  NONCE_SHARE = 'musig2:nonce-share',

  /** Share partial signature (MuSig2 Round 2 - direct P2P) */
  PARTIAL_SIG_SHARE = 'musig2:partial-sig-share',

  /** Session abort notification (direct P2P) */
  SESSION_ABORT = 'musig2:session-abort',

  /** Session complete notification (direct P2P) */
  SESSION_COMPLETE = 'musig2:session-complete',
}

// ============================================================================
// Session Announcement (GossipSub)
// ============================================================================

/**
 * Session announcement data (published to GossipSub)
 * Used for session discovery by potential participants
 */
export interface SessionAnnouncement {
  /** Unique session ID */
  sessionId: string

  /** Required number of signers */
  requiredSigners: number

  /** Coordinator peer ID */
  coordinatorPeerId: string

  /** Sorted list of participant public keys (if predetermined) */
  signers?: string[]

  /** Message hash being signed (for verification) */
  messageHash: string

  /** Creation timestamp */
  createdAt: number

  /** Expiration timestamp */
  expiresAt: number

  /** Optional metadata */
  metadata?: Record<string, unknown>
}

// ============================================================================
// Direct P2P Message Payloads
// ============================================================================

export interface MuSig2Payload {
  sessionId: string
  timestamp: number
  /** Monotonically increasing sequence number for replay protection */
  sequenceNumber?: number
}

/**
 * Join request payload
 */
export interface SessionJoinPayload extends MuSig2Payload {
  signerPublicKey: string
}

/**
 * Join acknowledgment payload
 */
export interface SessionJoinAckPayload extends MuSig2Payload {
  accepted: boolean
  signerIndex?: number
  reason?: string
}

/**
 * Nonce share payload (MuSig2 Round 1)
 *
 * Each signer sends ν ≥ 2 nonces directly without commitment phase
 */
export interface NonceSharePayload extends MuSig2Payload {
  signerIndex: number
  publicNonces: {
    // ν nonces where ν ≥ 2 (default ν = 4 for security)
    [key: string]: string // "r1", "r2", "r3", "r4" etc.
  }
}

/**
 * Partial signature share payload
 */
export interface PartialSigSharePayload extends MuSig2Payload {
  signerIndex: number
  partialSig: string // BN serialized to hex
}

/**
 * Session abort payload
 */
export interface SessionAbortPayload extends MuSig2Payload {
  reason: string
}

/**
 * Session complete payload
 */
export interface SessionCompletePayload extends MuSig2Payload {
  finalSignature?: {
    r: string
    s: string
  }
}

// ============================================================================
// Session State Management
// ============================================================================

/**
 * P2P session participant info
 */
export interface SessionParticipant {
  /** Peer ID */
  peerId: string

  /** Signer index in session */
  signerIndex: number

  /** Public key */
  publicKey: PublicKey

  /** Whether nonce has been received */
  hasNonce: boolean

  /** Whether partial signature has been received */
  hasPartialSig: boolean

  /** Last seen timestamp */
  lastSeen: number
}

/**
 * P2P-enhanced MuSig2 session
 * Extends the base session with P2P coordination data
 */
export interface MuSig2P2PSession {
  /** Base session state */
  session: MuSigSession

  /** Coordinator peer ID (who created/manages session) */
  coordinatorPeerId: string

  /** Map of peer IDs to participants */
  participants: Map<string, SessionParticipant>

  /** Whether we are the coordinator */
  isCoordinator: boolean

  /** Session announcement (if published) */
  announcement?: SessionAnnouncement

  /** Creation timestamp */
  createdAt: number

  /** Last activity timestamp */
  lastActivity: number
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * MuSig2 P2P configuration
 */
export interface MuSig2P2PConfig {
  /** GossipSub topic for session announcements */
  announcementTopic?: string

  /** Session announcement TTL in milliseconds */
  announcementTTL?: number

  /** Timeout for nonce collection in milliseconds */
  nonceTimeout?: number

  /** Timeout for partial signature collection in milliseconds */
  partialSigTimeout?: number

  /** Maximum concurrent sessions */
  maxConcurrentSessions?: number

  /** Enable automatic session cleanup */
  enableAutoCleanup?: boolean

  /** Session cleanup interval in milliseconds */
  cleanupInterval?: number

  /** Enable coordinator election */
  enableCoordinatorElection?: boolean

  // ============================================================================
  // Security Validation Limits (Phase 5)
  // ============================================================================

  /** Maximum message size in bytes (DoS protection) */
  maxMessageSize?: number

  /** Maximum timestamp skew in milliseconds */
  maxTimestampSkew?: number

  /** Maximum invalid messages per peer before blocking */
  maxInvalidMessagesPerPeer?: number

  /** Maximum nonce count per session (ν ≥ 2, but reasonable upper limit) */
  maxNonceCount?: number

  /** Enable validation-based security checks */
  enableValidationSecurity?: boolean

  /** Track validation violations for reputation */
  trackValidationViolations?: boolean

  /** Election method (lexicographic, hash-based, first-signer, last-signer) */
  electionMethod?:
    | 'lexicographic'
    | 'hash-based'
    | 'first-signer'
    | 'last-signer'

  /** Enable automatic coordinator failover */
  enableCoordinatorFailover?: boolean

  /** Timeout for coordinator to broadcast (milliseconds) */
  broadcastTimeout?: number
}

/**
 * Default MuSig2 P2P configuration
 */
export const DEFAULT_MUSIG2_P2P_CONFIG: Required<MuSig2P2PConfig> = {
  announcementTopic: 'lotus/musig2/sessions',
  announcementTTL: 5 * 60 * 1000, // 5 minutes
  nonceTimeout: 60 * 1000, // 1 minute
  partialSigTimeout: 60 * 1000, // 1 minute
  maxConcurrentSessions: 10,
  enableAutoCleanup: true,
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  enableCoordinatorElection: true,
  electionMethod: 'lexicographic',
  enableCoordinatorFailover: true,
  broadcastTimeout: 5 * 60 * 1000, // 5 minutes

  // Security Validation Limits (Phase 5)
  maxMessageSize: 100_000, // 100KB - DoS protection
  maxTimestampSkew: 5 * 60 * 1000, // 5 minutes
  maxInvalidMessagesPerPeer: 10, // Block peer after 10 invalid messages
  maxNonceCount: 10, // ν ≥ 2, but reasonable upper limit
  enableValidationSecurity: true,
  trackValidationViolations: true,
}

// ============================================================================
// Events
// ============================================================================

/**
 * MuSig2 coordination events
 */
export enum MuSig2Event {
  /** New session announced on network */
  SESSION_DISCOVERED = 'musig2:session-discovered',

  /** Session created locally */
  SESSION_CREATED = 'musig2:session-created',

  /** Participant joined session */
  PARTICIPANT_JOINED = 'musig2:participant-joined',

  /** All participants joined */
  SESSION_READY = 'musig2:session-ready',

  /** Nonce received from participant (MuSig2 Round 1) */
  NONCE_RECEIVED = 'musig2:nonce-received',

  /** All nonces collected (MuSig2 Round 1 complete) */
  NONCES_COMPLETE = 'musig2:nonces-complete',

  /** Partial signature received */
  PARTIAL_SIG_RECEIVED = 'musig2:partial-sig-received',

  /** All partial signatures collected */
  PARTIAL_SIGS_COMPLETE = 'musig2:partial-sigs-complete',

  /** Session signing complete */
  SESSION_COMPLETE = 'musig2:session-complete',

  /** Session aborted */
  SESSION_ABORTED = 'musig2:session-aborted',

  /** Session timeout */
  SESSION_TIMEOUT = 'musig2:session-timeout',

  /** Error in session */
  SESSION_ERROR = 'musig2:session-error',

  /** Coordinator elected */
  COORDINATOR_ELECTED = 'musig2:coordinator-elected',

  /** You should broadcast (you are coordinator) */
  SHOULD_BROADCAST = 'musig2:should-broadcast',

  /** Coordinator failed, failover initiated */
  COORDINATOR_FAILED = 'musig2:coordinator-failed',

  /** All coordinators failed */
  FAILOVER_EXHAUSTED = 'musig2:failover-exhausted',

  /** Broadcast confirmed */
  BROADCAST_CONFIRMED = 'musig2:broadcast-confirmed',

  /** Signer advertised successfully */
  SIGNER_ADVERTISED = 'musig2:signer-advertised',

  /** Signer discovered via DHT */
  SIGNER_DISCOVERED = 'musig2:signer-discovered',

  /** Signer advertisement withdrawn */
  SIGNER_WITHDRAWN = 'musig2:signer-withdrawn',

  /** Signing request created */
  SIGNING_REQUEST_CREATED = 'musig2:signing-request-created',

  /** Signing request received */
  SIGNING_REQUEST_RECEIVED = 'musig2:signing-request-received',

  /** Joined a signing request */
  SIGNING_REQUEST_JOINED = 'musig2:signing-request-joined',
}

// ============================================================================
// Transaction Types
// ============================================================================

/**
 * Transaction types supported by the MuSig2 coordination layer
 * Used for signer discovery and advertisement
 */
export enum TransactionType {
  /** Standard spend transaction */
  SPEND = 'spend',
  /** Atomic swap transaction */
  SWAP = 'swap',
  /** CoinJoin privacy transaction */
  COINJOIN = 'coinjoin',
  /** Custody/multisig wallet transaction */
  CUSTODY = 'custody',
  /** Escrow transaction */
  ESCROW = 'escrow',
  /** Payment channel transaction */
  CHANNEL = 'channel',
}
