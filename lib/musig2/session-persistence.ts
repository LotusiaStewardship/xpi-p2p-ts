/**
 * MuSig2 Session Persistence
 *
 * Provides session state serialization and persistence for recovery across
 * network interruptions and reconnects.
 *
 * @module SessionPersistence
 */

import type {
  MuSigSession,
  MuSigSessionPhase,
} from 'xpi-ts/lib/bitcore/musig2/session'
import type { MuSig2P2PSession, SessionParticipant } from './types.js'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import { Point, BN } from 'xpi-ts/lib/bitcore/crypto/index'
import {
  serializePublicKey,
  serializePublicKeys,
  deserializePublicKey,
  deserializePublicKeys,
  serializePoint,
  deserializePoint,
  serializeBN,
  deserializeBN,
} from './serialization.js'

/**
 * Serialized session state for persistence
 *
 * Contains all necessary data to restore a session after reconnection.
 * Sensitive data (secret nonces) is NOT persisted for security.
 */
export interface SerializedSession {
  /** Unique session identifier */
  sessionId: string

  /** Current session phase */
  phase: MuSigSessionPhase

  /** All participating signers' public keys (serialized) */
  signers: string[]

  /** Index of this signer in the signers array */
  myIndex: number

  /** Message being signed (hex encoded) */
  message: string

  /** Optional session metadata */
  metadata?: Record<string, unknown>

  /** Received public nonces from other signers (index -> serialized nonce pair) */
  receivedNonces: Record<number, { r1: string; r2: string }>

  /** Received partial signatures from other signers (index -> serialized BN) */
  receivedPartialSigs: Record<number, string>

  /** Coordinator peer ID */
  coordinatorPeerId: string

  /** Whether we are the coordinator */
  isCoordinator: boolean

  /** Creation timestamp */
  createdAt: number

  /** Last activity timestamp */
  lastActivity: number

  /** Coordinator election data */
  coordinatorIndex?: number
  electionMethod?: string
  electionProof?: string
  backupCoordinators?: number[]

  /** Serialized participants */
  participants: SerializedParticipant[]
}

/**
 * Serialized participant data
 */
export interface SerializedParticipant {
  peerId: string
  signerIndex: number
  publicKey: string
  hasNonce: boolean
  hasPartialSig: boolean
  lastSeen: number
}

/**
 * Session persistence storage interface
 *
 * Implement this interface to provide custom storage backends
 * (e.g., IndexedDB, localStorage, file system)
 */
export interface SessionStorage {
  /** Save a serialized session */
  save(sessionId: string, data: SerializedSession): Promise<void>

  /** Load a serialized session */
  load(sessionId: string): Promise<SerializedSession | null>

  /** Load all serialized sessions */
  loadAll(): Promise<SerializedSession[]>

  /** Delete a serialized session */
  delete(sessionId: string): Promise<void>

  /** Clear all sessions */
  clear(): Promise<void>
}

/**
 * In-memory session storage (default implementation)
 *
 * Suitable for testing and short-lived sessions.
 * For production, implement a persistent storage backend.
 */
export class InMemorySessionStorage implements SessionStorage {
  private sessions: Map<string, SerializedSession> = new Map()

  async save(sessionId: string, data: SerializedSession): Promise<void> {
    this.sessions.set(sessionId, data)
  }

  async load(sessionId: string): Promise<SerializedSession | null> {
    return this.sessions.get(sessionId) ?? null
  }

  async loadAll(): Promise<SerializedSession[]> {
    return Array.from(this.sessions.values())
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }

  async clear(): Promise<void> {
    this.sessions.clear()
  }
}

/**
 * Session persistence manager
 *
 * Handles serialization, deserialization, and storage of session state
 * for recovery across network interruptions.
 */
export class SessionPersistence {
  private storage: SessionStorage
  private sessionExpiry: number

  /**
   * Create a session persistence manager
   *
   * @param storage - Storage backend (defaults to in-memory)
   * @param sessionExpiry - Session expiry time in ms (default 5 minutes)
   */
  constructor(
    storage: SessionStorage = new InMemorySessionStorage(),
    sessionExpiry: number = 5 * 60 * 1000,
  ) {
    this.storage = storage
    this.sessionExpiry = sessionExpiry
  }

  /**
   * Serialize a P2P session for persistence
   *
   * NOTE: Secret nonces are NOT serialized for security.
   * After recovery, nonces must be regenerated if the session
   * is still in INIT phase.
   *
   * @param p2pSession - The P2P session to serialize
   * @returns Serialized session data
   */
  serialize(p2pSession: MuSig2P2PSession): SerializedSession {
    const session = p2pSession.session

    // Serialize received nonces
    const receivedNonces: Record<number, { r1: string; r2: string }> = {}
    for (const [index, nonce] of session.receivedPublicNonces) {
      receivedNonces[index] = {
        r1: serializePoint(nonce[0]),
        r2: serializePoint(nonce[1]),
      }
    }

    // Serialize received partial signatures
    const receivedPartialSigs: Record<number, string> = {}
    for (const [index, sig] of session.receivedPartialSigs) {
      receivedPartialSigs[index] = serializeBN(sig)
    }

    // Serialize participants
    const participants: SerializedParticipant[] = []
    for (const [peerId, participant] of p2pSession.participants) {
      participants.push({
        peerId,
        signerIndex: participant.signerIndex,
        publicKey: serializePublicKey(participant.publicKey),
        hasNonce: participant.hasNonce,
        hasPartialSig: participant.hasPartialSig,
        lastSeen: participant.lastSeen,
      })
    }

    return {
      sessionId: session.sessionId,
      phase: session.phase,
      signers: serializePublicKeys(session.signers),
      myIndex: session.myIndex,
      message: session.message.toString('hex'),
      metadata: session.metadata,
      receivedNonces,
      receivedPartialSigs,
      coordinatorPeerId: p2pSession.coordinatorPeerId,
      isCoordinator: p2pSession.isCoordinator,
      createdAt: p2pSession.createdAt,
      lastActivity: p2pSession.lastActivity,
      coordinatorIndex: session.coordinatorIndex,
      electionMethod: session.electionMethod,
      electionProof: session.electionProof,
      backupCoordinators: session.backupCoordinators,
      participants,
    }
  }

  /**
   * Deserialize session data back into a partial session state
   *
   * NOTE: This returns a partial session that needs to be completed
   * with key aggregation context and other computed fields.
   *
   * @param data - Serialized session data
   * @returns Partial session data for reconstruction
   */
  deserialize(data: SerializedSession): {
    sessionId: string
    phase: MuSigSessionPhase
    signers: PublicKey[]
    myIndex: number
    message: Buffer
    metadata?: Record<string, unknown>
    receivedPublicNonces: Map<number, [Point, Point]>
    receivedPartialSigs: Map<number, BN>
    coordinatorPeerId: string
    isCoordinator: boolean
    createdAt: number
    lastActivity: number
    coordinatorIndex?: number
    electionMethod?: string
    electionProof?: string
    backupCoordinators?: number[]
    participants: Map<string, SessionParticipant>
  } {
    // Deserialize signers
    const signers = deserializePublicKeys(data.signers)

    // Deserialize received nonces
    const receivedPublicNonces = new Map<number, [Point, Point]>()
    for (const [indexStr, nonce] of Object.entries(data.receivedNonces)) {
      const index = parseInt(indexStr, 10)
      receivedPublicNonces.set(index, [
        deserializePoint(nonce.r1),
        deserializePoint(nonce.r2),
      ])
    }

    // Deserialize received partial signatures
    const receivedPartialSigs = new Map<number, BN>()
    for (const [indexStr, sig] of Object.entries(data.receivedPartialSigs)) {
      const index = parseInt(indexStr, 10)
      receivedPartialSigs.set(index, deserializeBN(sig))
    }

    // Deserialize participants
    const participants = new Map<string, SessionParticipant>()
    for (const p of data.participants) {
      participants.set(p.peerId, {
        peerId: p.peerId,
        signerIndex: p.signerIndex,
        publicKey: deserializePublicKey(p.publicKey),
        hasNonce: p.hasNonce,
        hasPartialSig: p.hasPartialSig,
        lastSeen: p.lastSeen,
      })
    }

    return {
      sessionId: data.sessionId,
      phase: data.phase,
      signers,
      myIndex: data.myIndex,
      message: Buffer.from(data.message, 'hex'),
      metadata: data.metadata,
      receivedPublicNonces,
      receivedPartialSigs,
      coordinatorPeerId: data.coordinatorPeerId,
      isCoordinator: data.isCoordinator,
      createdAt: data.createdAt,
      lastActivity: data.lastActivity,
      coordinatorIndex: data.coordinatorIndex,
      electionMethod: data.electionMethod,
      electionProof: data.electionProof,
      backupCoordinators: data.backupCoordinators,
      participants,
    }
  }

  /**
   * Save a session to storage
   *
   * @param p2pSession - The P2P session to save
   */
  async save(p2pSession: MuSig2P2PSession): Promise<void> {
    const serialized = this.serialize(p2pSession)
    await this.storage.save(p2pSession.session.sessionId, serialized)
  }

  /**
   * Load a session from storage
   *
   * @param sessionId - The session ID to load
   * @returns Deserialized session data or null if not found
   */
  async load(
    sessionId: string,
  ): Promise<ReturnType<typeof this.deserialize> | null> {
    const data = await this.storage.load(sessionId)
    if (!data) {
      return null
    }
    return this.deserialize(data)
  }

  /**
   * Load all sessions from storage
   *
   * @returns Array of deserialized session data
   */
  async loadAll(): Promise<Array<ReturnType<typeof this.deserialize>>> {
    const allData = await this.storage.loadAll()
    return allData.map(data => this.deserialize(data))
  }

  /**
   * Load all non-expired sessions from storage
   *
   * @returns Array of deserialized session data that haven't expired
   */
  async loadActive(): Promise<Array<ReturnType<typeof this.deserialize>>> {
    const allData = await this.storage.loadAll()
    const now = Date.now()

    return allData
      .filter(data => now - data.lastActivity < this.sessionExpiry)
      .map(data => this.deserialize(data))
  }

  /**
   * Delete a session from storage
   *
   * @param sessionId - The session ID to delete
   */
  async delete(sessionId: string): Promise<void> {
    await this.storage.delete(sessionId)
  }

  /**
   * Clear all sessions from storage
   */
  async clear(): Promise<void> {
    await this.storage.clear()
  }

  /**
   * Check if a session has expired
   *
   * @param lastActivity - Last activity timestamp
   * @returns True if the session has expired
   */
  isExpired(lastActivity: number): boolean {
    return Date.now() - lastActivity >= this.sessionExpiry
  }

  /**
   * Cleanup expired sessions from storage
   *
   * @returns Number of sessions cleaned up
   */
  async cleanupExpired(): Promise<number> {
    const allData = await this.storage.loadAll()
    let cleaned = 0

    for (const data of allData) {
      if (this.isExpired(data.lastActivity)) {
        await this.storage.delete(data.sessionId)
        cleaned++
      }
    }

    return cleaned
  }
}

/**
 * Session recovery message types
 */
export enum SessionRecoveryMessageType {
  /** Request session state from coordinator */
  RECOVERY_REQUEST = 'musig2:session-recovery-request',
  /** Response with current session state */
  RECOVERY_RESPONSE = 'musig2:session-recovery-response',
}

/**
 * Session recovery request payload
 */
export interface SessionRecoveryRequest {
  sessionId: string
  requestingPeerId: string
  lastKnownPhase: MuSigSessionPhase
  timestamp: number
}

/**
 * Session recovery response payload
 */
export interface SessionRecoveryResponse {
  sessionId: string
  found: boolean
  currentPhase?: MuSigSessionPhase
  /** Serialized session state if found */
  sessionState?: SerializedSession
  timestamp: number
}
