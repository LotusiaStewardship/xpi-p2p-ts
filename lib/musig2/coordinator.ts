/**
 * MuSig2 P2P Coordinator
 *
 * Coordinates MuSig2 multi-signature sessions over P2P networks.
 * Uses GossipSub for session discovery and direct P2P for coordination.
 *
 * ARCHITECTURE:
 * This module handles SESSION MANAGEMENT and BUSINESS LOGIC:
 * - Session creation, joining, and lifecycle management
 * - Nonce exchange coordination (MuSig2 Round 1)
 * - Partial signature exchange (MuSig2 Round 2)
 * - Coordinator election and failover
 * - EGRESS payload validation (before sending)
 *
 * IMPORTANT: This module does NOT re-validate ingress payloads.
 * Ingress validation is handled by protocol.ts before events are emitted.
 * Event handlers receive pre-validated payloads.
 *
 * Validation Flow:
 * 1. security.ts: Security constraints (DoS, blocking, timestamp)
 * 2. protocol.ts: Payload structure validation (single ingress point)
 * 3. coordinator.ts: Business logic handlers (no re-validation)
 *
 * Egress Flow:
 * 1. coordinator.ts: _validatePayloadForMessage() - Validates before sending
 * 2. coordinator.ts: _broadcastToSessionParticipants() - Sends validated payload
 */

import { EventEmitter } from 'events'
import { P2PCoordinator } from '../coordinator.js'
import type { P2PMessage } from '../types.js'
import { P2PProtocol } from '../protocol.js'
import { MuSig2ProtocolHandler } from './protocol.js'
import {
  MuSig2SecurityValidator,
  type MuSig2SecurityConfig,
} from './security.js'
import {
  MuSig2MessageType,
  MuSig2Event,
  DEFAULT_MUSIG2_P2P_CONFIG,
  type MuSig2P2PConfig,
  type MuSig2P2PSession,
  type SessionAnnouncement,
  type SessionParticipant,
  type SessionJoinPayload,
  type SessionJoinAckPayload,
  type NonceSharePayload,
  type PartialSigSharePayload,
  type SessionAbortPayload,
  type SessionCompletePayload,
} from './types.js'
import {
  electCoordinator,
  getBackupCoordinator,
  getCoordinatorPriorityList,
  ElectionMethod,
  type ElectionResult,
} from './election.js'
import {
  MuSigSessionManager,
  type MuSigSession,
  MuSigSessionPhase,
} from 'xpi-ts/lib/bitcore/musig2/session'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'
import { Point, BN } from 'xpi-ts/lib/bitcore/crypto/index'
import { Hash } from 'xpi-ts/lib/bitcore/crypto/hash'
import { MuSig2Discovery } from './discovery-extension.js'
import type { MuSig2DiscoveryConfig } from './discovery-types.js'
import type { IDiscoveryCache } from '../discovery/types.js'
import {
  serializeMessage,
  deserializeMessage,
  serializePoint,
  serializePublicNonces,
  deserializePublicNonces,
  serializeBN,
  deserializeBN,
  serializePublicKey,
  deserializePublicKey,
  serializePublicKeys,
  deserializePublicKeys,
  serializeSignature,
  deserializeSignature,
  type SerializedSignature,
} from './serialization.js'
// NOTE: These validators are used for EGRESS validation only.
// Ingress validation is handled by protocol.ts before events are emitted.
import {
  validateSessionJoinPayload,
  validateSessionJoinAckPayload,
  validateNonceSharePayload,
  validatePartialSigSharePayload,
  validateSessionAbortPayload,
  validateSessionCompletePayload,
  validateSessionAnnouncementPayload,
} from './validation.js'
import { SessionLock, withSessionLock } from './session-lock.js'
import {
  MuSig2MessageSigner,
  type SignedP2PMessage,
} from './message-signing.js'
import { ReplayProtection } from './replay-protection.js'

/**
 * MuSig2 P2P Coordinator
 *
 * Extends P2PCoordinator to provide MuSig2-specific session coordination
 *
 * Architecture:
 * - GossipSub: Session announcements and discovery
 * - Direct P2P: Nonce exchange, partial signature exchange
 * - Session Manager: Cryptographic operations and validation
 */
export class MuSig2P2PCoordinator extends EventEmitter {
  private coordinator: P2PCoordinator
  private protocolHandler: MuSig2ProtocolHandler
  private securityValidator: MuSig2SecurityValidator
  private sessionManager: MuSigSessionManager
  private protocol: P2PProtocol
  private discovery?: MuSig2Discovery

  // Session management
  private sessions: Map<string, MuSig2P2PSession> = new Map()
  private config: Required<MuSig2P2PConfig>
  private cleanupInterval?: NodeJS.Timeout
  private sessionTimeouts: Map<string, NodeJS.Timeout> = new Map()
  private broadcastTimeouts: Map<string, NodeJS.Timeout> = new Map()

  // Security: Track used nonces globally to prevent reuse
  private usedNonces: Set<string> = new Set()

  // Session locking for race condition prevention
  private sessionLock: SessionLock = new SessionLock()

  // Message signing for authentication (Phase 4 Security)
  private messageSigner: MuSig2MessageSigner = new MuSig2MessageSigner()

  // Replay protection (Phase 4 Security)
  private replayProtection: ReplayProtection = new ReplayProtection()

  // Sequence number tracking per session
  private sessionSequences: Map<string, number> = new Map()

  // Metrics
  private metrics = {
    sessionsCreated: 0,
    sessionsCompleted: 0,
    sessionsAborted: 0,
    sessionsTimedOut: 0,
  }

  /**
   * Create a MuSig2P2PCoordinator
   *
   * @param coordinator - An already-instantiated P2PCoordinator (caller manages lifecycle)
   * @param musig2Config - MuSig2-specific configuration
   * @param securityConfig - Security validation configuration
   * @param discoveryConfig - Discovery layer configuration
   * @param discoveryCache - Optional external cache for discovery persistence (e.g., localStorage-backed)
   */
  constructor(
    coordinator: P2PCoordinator,
    musig2Config?: MuSig2P2PConfig,
    securityConfig?: MuSig2SecurityConfig,
    discoveryConfig?: MuSig2DiscoveryConfig,
    discoveryCache?: IDiscoveryCache,
  ) {
    super()

    // Initialize configuration
    this.config = {
      ...DEFAULT_MUSIG2_P2P_CONFIG,
      ...musig2Config,
    }

    // Use provided coordinator (caller manages its lifecycle)
    this.coordinator = coordinator
    this.protocolHandler = new MuSig2ProtocolHandler()
    this.securityValidator = new MuSig2SecurityValidator(securityConfig)
    this.sessionManager = new MuSigSessionManager()
    this.protocol = new P2PProtocol()

    // Connect security validator to protocol handler for message validation
    this.protocolHandler.setSecurityValidator(this.securityValidator)

    // Register protocol handler with the coordinator
    this.coordinator.registerProtocol(this.protocolHandler)

    // Register security validator with core security manager
    this.coordinator
      .getCoreSecurityManager()
      .registerProtocolValidator('musig2', this.securityValidator)

    // Setup protocol event handlers
    this._setupProtocolHandlers()

    // Initialize discovery layer if config provided
    if (discoveryConfig) {
      this.discovery = new MuSig2Discovery(
        this.coordinator,
        discoveryConfig,
        discoveryCache,
      )
    }

    // Start cleanup if enabled
    if (this.config.enableAutoCleanup) {
      this.startCleanup()
    }
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Initialize MuSig2 protocol on the P2PCoordinator
   *
   * NOTE: The caller is responsible for starting the P2PCoordinator before
   * calling this method. This only sets up MuSig2-specific subscriptions.
   */
  async initialize(): Promise<void> {
    // Subscribe to session announcement topic
    await this.coordinator.subscribeToTopic(
      this.config.announcementTopic,
      this._handleSessionAnnouncement,
    )

    // Start discovery layer if available
    if (this.discovery) {
      await this.discovery.start()
      console.log('[MuSig2] Discovery layer started')
    }

    // Start replay protection cleanup timer
    this.replayProtection.start()
    console.log('[MuSig2] Replay protection started')

    console.log('[MuSig2] Protocol initialized')
  }

  /**
   * Cleanup MuSig2 protocol from the P2PCoordinator
   *
   * NOTE: The caller is responsible for stopping the P2PCoordinator.
   * This only cleans up MuSig2-specific resources.
   */
  async cleanup(): Promise<void> {
    // Stop discovery layer if available
    if (this.discovery) {
      await this.discovery.stop()
      console.log('[MuSig2] Discovery layer stopped')
    }

    // Stop replay protection
    this.replayProtection.stop()
    this.replayProtection.clear()
    console.log('[MuSig2] Replay protection stopped')

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }

    // Clear all session timeouts
    for (const sessionId of this.sessionTimeouts.keys()) {
      this._clearSessionTimeout(sessionId)
    }

    // Clear all broadcast timeouts
    for (const sessionId of this.broadcastTimeouts.keys()) {
      this._clearBroadcastTimeout(sessionId)
    }

    // Unsubscribe from topic
    await this.coordinator.unsubscribeFromTopic(this.config.announcementTopic)

    // Clear sessions
    this.sessions.clear()

    // Clear nonce tracking
    this.usedNonces.clear()

    // Clear sequence tracking
    this.sessionSequences.clear()

    // Clear all session locks
    this.sessionLock.clearAll()

    // Log final metrics
    console.log(
      '[MuSig2] Protocol cleaned up. Final metrics:',
      this.getMetrics(),
    )
  }

  /**
   * @deprecated Use initialize() instead. The P2PCoordinator lifecycle
   * should be managed by the caller.
   */
  async start(): Promise<void> {
    console.warn(
      '[MuSig2] start() is deprecated. Use initialize() instead. ' +
        'The P2PCoordinator should be started by the caller.',
    )
    await this.initialize()
  }

  /**
   * @deprecated Use cleanup() instead. The P2PCoordinator lifecycle
   * should be managed by the caller.
   */
  async stop(): Promise<void> {
    console.warn(
      '[MuSig2] stop() is deprecated. Use cleanup() instead. ' +
        'The P2PCoordinator should be stopped by the caller.',
    )
    await this.cleanup()
  }

  /**
   * Get peer ID
   */
  get peerId(): string {
    return this.coordinator.peerId
  }

  /**
   * Get discovery layer instance
   * Returns undefined if discovery was not initialized
   */
  getDiscovery(): MuSig2Discovery | undefined {
    return this.discovery
  }

  /**
   * Check if discovery layer is available
   */
  hasDiscovery(): boolean {
    return this.discovery !== undefined
  }

  /**
   * Get the underlying P2PCoordinator instance
   *
   * This provides access to low-level P2P functionality such as:
   * - Connection stats (getStats(), getDHTStats())
   * - Manual peer management (connectToPeer(), disconnectFromPeer())
   * - GossipSub topics (subscribeToTopic(), publishToTopic())
   * - Resource announcements (announceResource())
   *
   * Use this when you need P2P features not directly exposed by MuSig2P2PCoordinator.
   */
  getP2PCoordinator(): P2PCoordinator {
    return this.coordinator
  }

  /**
   * Get the libp2p node instance
   * Shorthand for getP2PCoordinator().libp2pNode
   */
  get libp2pNode() {
    return this.coordinator.libp2pNode
  }

  // ============================================================================
  // Session Creation and Management
  // ============================================================================

  /**
   * Create a new MuSig2 signing session
   *
   * @param signers - All participating signers' public keys (sorted)
   * @param myPrivateKey - This signer's private key
   * @param message - Message to sign
   * @param metadata - Optional session metadata
   * @returns Session ID
   */
  async createSession(
    signers: PublicKey[],
    myPrivateKey: PrivateKey,
    message: Buffer,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    // Check max concurrent sessions
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached`,
      )
    }

    // Create base session using session manager
    const session = this.sessionManager.createSession(
      signers,
      myPrivateKey,
      message,
      metadata,
    )

    // Handle session ID collision by regenerating with new entropy
    // This can happen if signing the same message with the same signers
    let collisionAttempts = 0
    const maxCollisionAttempts = 3
    while (this.sessions.has(session.sessionId)) {
      collisionAttempts++
      if (collisionAttempts > maxCollisionAttempts) {
        throw new Error(
          `Session ID collision persisted after ${maxCollisionAttempts} regeneration attempts`,
        )
      }
      console.warn(
        `[MuSig2] Session ID collision detected, regenerating (attempt ${collisionAttempts})`,
      )
      session.sessionId = this.sessionManager.regenerateSessionId(session)
    }

    // Create P2P session wrapper
    const p2pSession: MuSig2P2PSession = {
      session,
      coordinatorPeerId: this.peerId,
      participants: new Map(),
      isCoordinator: true,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    }

    // Perform coordinator election if enabled
    if (this.config.enableCoordinatorElection) {
      const electionMethod = this._getElectionMethod()
      const election = electCoordinator(session.signers, electionMethod)

      // Store election results in session
      session.coordinatorIndex = election.coordinatorIndex
      session.electionMethod = this.config.electionMethod
      session.electionProof = election.electionProof

      // Generate backup coordinator priority list if failover enabled
      if (this.config.enableCoordinatorFailover) {
        session.backupCoordinators = getCoordinatorPriorityList(
          session.signers,
          electionMethod,
        )
      }

      console.log(
        `[MuSig2] Coordinator elected: index ${election.coordinatorIndex}, method: ${this.config.electionMethod}`,
      )
      this.emit(
        MuSig2Event.COORDINATOR_ELECTED,
        session.sessionId,
        election.coordinatorIndex,
        this.sessionManager.isCoordinator(session),
      )
    }

    // Store session
    this.sessions.set(session.sessionId, p2pSession)

    // Update metrics
    this.metrics.sessionsCreated++

    console.log(`[MuSig2] Created session: ${session.sessionId}`)
    this.emit(MuSig2Event.SESSION_CREATED, session.sessionId, session)

    return session.sessionId
  }

  /**
   * Announce session on GossipSub for peer discovery
   *
   * @param sessionId - Session ID
   */
  async announceSession(sessionId: string): Promise<void> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session

    // Create announcement with serialized data
    const announcement: SessionAnnouncement = {
      sessionId: session.sessionId,
      requiredSigners: session.signers.length,
      coordinatorPeerId: this.peerId,
      signers: serializePublicKeys(session.signers),
      messageHash: serializeMessage(Hash.sha256(session.message)),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.announcementTTL,
      metadata: session.metadata,
    }

    // Store announcement
    p2pSession.announcement = announcement

    // Publish to GossipSub
    await this.coordinator.publishToTopic(
      this.config.announcementTopic,
      announcement,
    )

    console.log(`[MuSig2] Announced session: ${sessionId}`)
  }

  /**
   * Join an existing MuSig2 session discovered via announcement
   *
   * This method is called by participants who discover a session via GossipSub
   * and want to join it. It creates a local session state and sends a join
   * request to the coordinator.
   *
   * @param announcement - Session announcement received from GossipSub
   * @param myPrivateKey - This signer's private key
   * @returns Session ID if join request was sent successfully
   */
  async joinSession(
    announcement: SessionAnnouncement,
    myPrivateKey: PrivateKey,
  ): Promise<string> {
    const sessionId = announcement.sessionId

    // Check if session already exists locally
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists locally: ${sessionId}`)
    }

    // Check max concurrent sessions
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached`,
      )
    }

    // Validate our public key is in the signers list
    const myPubKey = myPrivateKey.publicKey
    const myPubKeyHex = serializePublicKey(myPubKey)

    if (!announcement.signers) {
      throw new Error('Session announcement does not include signers list')
    }

    const myIndex = announcement.signers.findIndex(pk => pk === myPubKeyHex)
    if (myIndex === -1) {
      throw new Error('My public key is not in the signers list')
    }

    // Deserialize signers from announcement
    const signers = deserializePublicKeys(announcement.signers)

    // Deserialize message hash
    const messageHash = deserializeMessage(announcement.messageHash)

    // Create local session using session manager
    const session = this.sessionManager.createSession(
      signers,
      myPrivateKey,
      messageHash,
      announcement.metadata,
    )

    // Override session ID to match announcement
    session.sessionId = sessionId

    // Create P2P session wrapper (we are NOT the coordinator)
    const p2pSession: MuSig2P2PSession = {
      session,
      coordinatorPeerId: announcement.coordinatorPeerId,
      participants: new Map(),
      isCoordinator: false,
      announcement,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    }

    // Store session
    this.sessions.set(sessionId, p2pSession)

    // Send join request to coordinator
    const joinPayload: SessionJoinPayload = {
      sessionId,
      signerPublicKey: myPubKeyHex,
      timestamp: Date.now(),
    }

    try {
      // Validate payload before sending
      validateSessionJoinPayload(joinPayload)

      const message = this.protocol.createMessage(
        MuSig2MessageType.SESSION_JOIN,
        JSON.stringify(joinPayload),
        this.peerId,
        { protocol: 'musig2' },
      )

      await this.coordinator.sendTo(
        announcement.coordinatorPeerId,
        message,
        this.protocolHandler.protocolId,
      )

      console.log(
        `[MuSig2] Sent join request for session ${sessionId} to coordinator ${announcement.coordinatorPeerId}`,
      )

      // Update metrics
      this.metrics.sessionsCreated++

      return sessionId
    } catch (error) {
      // Remove session on failure
      this.sessions.delete(sessionId)
      throw error
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): MuSig2P2PSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): MuSig2P2PSession[] {
    return Array.from(this.sessions.values())
  }

  // ============================================================================
  // Nonce Exchange (MuSig2 Round 1: Direct Exchange)
  // ============================================================================

  /**
   * Share nonces (MuSig2 Round 1)
   *
   * According to MuSig2 specification, each signer generates ν ≥ 2 nonces
   * and sends them directly without any commitment phase.
   *
   * @param sessionId - Session ID
   * @param privateKey - This signer's private key
   */
  async shareNonces(sessionId: string, privateKey: PrivateKey): Promise<void> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session

    // Validate phase
    if (session.phase !== MuSigSessionPhase.INIT) {
      throw new Error(
        `Cannot share nonces in phase ${session.phase}. Expected INIT`,
      )
    }

    // Check if we already have nonces (prevent re-sharing)
    if (session.myPublicNonce) {
      throw new Error('Nonces already generated for this session')
    }

    // Generate ν ≥ 2 nonces using session manager
    const publicNonces = this.sessionManager.generateNonces(session, privateKey)

    // SECURITY: Track nonce to prevent reuse
    const nonceHash = this._hashNonce(publicNonces)
    if (this.usedNonces.has(nonceHash)) {
      throw new Error('Nonce reuse detected! Aborting for security.')
    }
    this.usedNonces.add(nonceHash)

    // Update session state
    p2pSession.lastActivity = Date.now()

    // Serialize nonces using serialization layer
    const nonceMap = serializePublicNonces(publicNonces)

    // Broadcast nonces directly to all participants (no commitment phase)
    const payload: NonceSharePayload = {
      sessionId,
      signerIndex: session.myIndex,
      publicNonces: nonceMap,
      timestamp: Date.now(),
    }

    await this._broadcastToSessionParticipants(
      sessionId,
      MuSig2MessageType.NONCE_SHARE,
      payload,
    )

    // Set timeout for nonce collection
    this._setNonceTimeout(sessionId)

    // Transition to NONCE_EXCHANGE phase
    if (session.phase === MuSigSessionPhase.INIT) {
      session.phase = MuSigSessionPhase.NONCE_EXCHANGE
      session.updatedAt = Date.now()
    }

    console.log(
      `[MuSig2] Shared ${publicNonces.length} nonces for session: ${sessionId}`,
    )
  }
  // ============================================================================

  /**
   * Create and share partial signature for a session
   *
   * @param sessionId - Session ID
   * @param privateKey - This signer's private key
   */
  async sharePartialSignature(
    sessionId: string,
    privateKey: PrivateKey,
  ): Promise<void> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session

    // Validate phase
    if (session.phase !== MuSigSessionPhase.PARTIAL_SIG_EXCHANGE) {
      throw new Error(
        `Cannot share partial signature in phase ${session.phase}. Expected PARTIAL_SIG_EXCHANGE`,
      )
    }

    // Create partial signature using session manager
    const partialSig = this.sessionManager.createPartialSignature(
      session,
      privateKey,
    )

    // Update session state
    p2pSession.lastActivity = Date.now()

    // Broadcast partial signature to all other participants
    const payload: PartialSigSharePayload = {
      sessionId,
      signerIndex: session.myIndex,
      partialSig: serializeBN(partialSig),
      timestamp: Date.now(),
    }

    await this._broadcastToSessionParticipants(
      sessionId,
      MuSig2MessageType.PARTIAL_SIG_SHARE,
      payload,
    )

    // Set timeout for partial signature collection
    this._setPartialSigTimeout(sessionId)

    console.log(`[MuSig2] Shared partial signature for session: ${sessionId}`)
  }

  // ============================================================================
  // Session Finalization
  // ============================================================================

  /**
   * Check if session is ready to finalize
   */
  canFinalizeSession(sessionId: string): boolean {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      return false
    }

    return this.sessionManager.hasAllPartialSignatures(p2pSession.session)
  }

  /**
   * Finalize session and get final signature
   *
   * @param sessionId - Session ID
   * @returns Final aggregated signature
   */
  async finalizeSession(sessionId: string): Promise<Buffer> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session

    // Get final signature using session manager
    const signature = this.sessionManager.getFinalSignature(session)

    // Update session state
    p2pSession.lastActivity = Date.now()

    // Update metrics
    this.metrics.sessionsCompleted++

    // Clear timeouts
    this._clearSessionTimeout(sessionId)
    this._clearBroadcastTimeout(sessionId)

    // Broadcast completion to participants with serialized signature
    const sigBuffer = signature.toBuffer()
    const completionPayload: SessionCompletePayload = {
      sessionId,
      finalSignature: serializeSignature(sigBuffer),
      timestamp: Date.now(),
    }

    await this._broadcastToSessionParticipants(
      sessionId,
      MuSig2MessageType.SESSION_COMPLETE,
      completionPayload,
    ).catch(console.error)

    console.log(`[MuSig2] Finalized session: ${sessionId}`)
    this.emit(MuSig2Event.SESSION_COMPLETE, sessionId, signature)

    // Cleanup: Clear nonces from this session to free memory
    this._clearSessionNonces(p2pSession.session)

    return sigBuffer
  }

  // ============================================================================
  // Session Abort
  // ============================================================================

  /**
   * Abort a session
   *
   * @param sessionId - Session ID
   * @param reason - Abort reason
   */
  async abortSession(sessionId: string, reason: string): Promise<void> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      console.warn(
        `[MuSig2] Attempted to abort non-existent session: ${sessionId}`,
      )
      return
    }

    // Update session state
    p2pSession.session.phase = MuSigSessionPhase.ABORTED
    p2pSession.session.abortReason = reason
    p2pSession.lastActivity = Date.now()

    // Clear any pending timeouts
    this._clearSessionTimeout(sessionId)

    // Notify participants
    const payload: SessionAbortPayload = {
      sessionId,
      reason,
      timestamp: Date.now(),
    }

    await this._broadcastToSessionParticipants(
      sessionId,
      MuSig2MessageType.SESSION_ABORT,
      payload,
    )

    // Update metrics
    this.metrics.sessionsAborted++

    // Cleanup: Clear nonces from this session
    this._clearSessionNonces(p2pSession.session)

    console.log(`[MuSig2] Aborted session ${sessionId}: ${reason}`)
    this.emit(MuSig2Event.SESSION_ABORTED, sessionId, reason)

    // Remove session after abort
    this.sessions.delete(sessionId)
  }

  // ============================================================================
  // Protocol Event Handlers
  // ============================================================================

  /**
   * Setup protocol event handlers with validation error handling
   */
  private _setupProtocolHandlers(): void {
    // Session join request received (from participant wanting to join)
    this.protocolHandler.on(
      'session:join',
      async (payload: SessionJoinPayload, from) => {
        try {
          await this._handleSessionJoin(payload, from.peerId)
        } catch (error) {
          this._handleProtocolError('session:join', error, payload, from.peerId)
        }
      },
    )

    // Session join acknowledgment received (from coordinator)
    this.protocolHandler.on(
      'session:join-ack',
      async (payload: SessionJoinAckPayload, from) => {
        try {
          await this._handleSessionJoinAck(payload, from.peerId)
        } catch (error) {
          this._handleProtocolError(
            'session:join-ack',
            error,
            payload,
            from.peerId,
          )
        }
      },
    )

    // Nonce received (MuSig2 Round 1)
    this.protocolHandler.on(
      'nonce:share',
      async (payload: NonceSharePayload, from) => {
        try {
          await this._handleNonceShare(payload, from.peerId)
        } catch (error) {
          this._handleProtocolError('nonce:share', error, payload, from.peerId)
        }
      },
    )

    // Partial signature received (MuSig2 Round 2)
    this.protocolHandler.on(
      'partial-sig:share',
      async (payload: PartialSigSharePayload, from) => {
        try {
          await this._handlePartialSigShare(payload, from.peerId)
        } catch (error) {
          this._handleProtocolError(
            'partial-sig:share',
            error,
            payload,
            from.peerId,
          )
        }
      },
    )

    // Session abort
    this.protocolHandler.on(
      'session:abort',
      async (payload: SessionAbortPayload, from) => {
        try {
          await this._handleSessionAbort(payload, from.peerId)
        } catch (error) {
          this._handleProtocolError(
            'session:abort',
            error,
            payload,
            from.peerId,
          )
        }
      },
    )

    // Session complete
    this.protocolHandler.on(
      'session:complete',
      async (payload: SessionCompletePayload, from) => {
        try {
          await this._handleSessionComplete(payload, from.peerId)
        } catch (error) {
          this._handleProtocolError(
            'session:complete',
            error,
            payload,
            from.peerId,
          )
        }
      },
    )

    // Validation errors from protocol handler
    this.protocolHandler.on('validation:error', ({ error, message, from }) => {
      console.warn(
        `[MuSig2] Validation error from ${from.peerId}: ${error.message}`,
      )
      this.emit('validation:error', { error, message, from })
    })

    // Deserialization errors from protocol handler
    this.protocolHandler.on(
      'deserialization:error',
      ({ error, message, from }) => {
        console.warn(
          `[MuSig2] Deserialization error from ${from.peerId}: ${error.message}`,
        )
        this.emit('deserialization:error', { error, message, from })
      },
    )

    // Serialization errors from protocol handler
    this.protocolHandler.on(
      'serialization:error',
      ({ error, message, from }) => {
        console.warn(
          `[MuSig2] Serialization error from ${from.peerId}: ${error.message}`,
        )
        this.emit('serialization:error', { error, message, from })
      },
    )

    // Unexpected errors from protocol handler
    this.protocolHandler.on('unexpected:error', ({ error, message, from }) => {
      console.error(`[MuSig2] Unexpected error from ${from.peerId}:`, error)
      this.emit('unexpected:error', { error, message, from })
    })

    // Security rejected messages from protocol handler
    this.protocolHandler.on(
      'security:rejected',
      ({ message, from, reason }) => {
        console.warn(
          `[MuSig2] Security rejected message ${message.type} from ${from.peerId}: ${reason}`,
        )
        this.emit('security:rejected', { message, from, reason })
      },
    )

    // Peer disconnected
    this.protocolHandler.on('peer:disconnected', (peerId: string) => {
      this._handlePeerDisconnected(peerId)
    })

    // Peer connected - forward to coordinator event emitter
    this.protocolHandler.on('peer:connected', (peerId: string) => {
      console.log(`[MuSig2] Peer connected: ${peerId}`)
      this.emit('peer:connected', peerId)
    })

    // Peer discovered - forward to coordinator event emitter
    this.protocolHandler.on('peer:discovered', peerInfo => {
      console.log(`[MuSig2] Peer discovered: ${peerInfo.peerId}`)
      this.emit('peer:discovered', peerInfo)
    })
  }

  /**
   * Handle protocol-level errors with proper logging and metrics
   */
  private _handleProtocolError = (
    messageType: string,
    error: unknown,
    payload: unknown,
    fromPeerId: string,
  ): void => {
    console.error(
      `[MuSig2] Error handling ${messageType} from ${fromPeerId}:`,
      error,
    )

    // Emit error for monitoring and handling
    this.emit('protocol:error', {
      messageType,
      error,
      payload,
      fromPeerId,
      timestamp: Date.now(),
    })

    // Update metrics if applicable
    if (messageType === 'session:abort') {
      this.metrics.sessionsAborted++
    }
  }

  /**
   * Handle session announcement from GossipSub with security and validation
   */
  private _handleSessionAnnouncement = async (
    data: Uint8Array,
  ): Promise<void> => {
    try {
      const json = Buffer.from(data).toString('utf8')
      const announcement = JSON.parse(json) as SessionAnnouncement

      // Check if coordinator peer is blocked
      if (
        this.securityValidator.isPeerBlocked(announcement.coordinatorPeerId)
      ) {
        console.warn(
          `[MuSig2] Ignoring announcement from blocked peer: ${announcement.coordinatorPeerId}`,
        )
        return
      }

      // Validate session announcement using security validator
      const isValid = await this.securityValidator.validateResourceAnnouncement(
        'musig2-session',
        announcement.sessionId,
        announcement,
        announcement.coordinatorPeerId,
      )

      if (!isValid) {
        console.warn(
          `[MuSig2] Security validation failed for announcement: ${announcement.sessionId}`,
        )
        this.emit('announcement:rejected', {
          announcement,
          reason: 'security_validation_failed',
        })
        return
      }

      // Additional validation using validation layer
      validateSessionAnnouncementPayload(announcement)

      console.log(
        `[MuSig2] Discovered valid session: ${announcement.sessionId} from ${announcement.coordinatorPeerId}`,
      )

      this.emit(MuSig2Event.SESSION_DISCOVERED, announcement)
    } catch (error) {
      console.error('[MuSig2] Error processing session announcement:', error)
      this.emit('announcement:error', { error, data })
    }
  }

  /**
   * Handle session complete message
   *
   * ARCHITECTURE NOTE: Payload validation is performed by protocol.ts before
   * this handler is called. No re-validation needed here.
   */
  private _handleSessionComplete = async (
    payload: SessionCompletePayload,
    fromPeerId: string,
  ): Promise<void> => {
    // NOTE: Payload already validated by protocol.ts via _validateAndRouteMessage()

    const p2pSession = this.sessions.get(payload.sessionId)
    if (!p2pSession) {
      console.warn(
        `[MuSig2] Received complete for unknown session: ${payload.sessionId}`,
      )
      return
    }

    console.log(`[MuSig2] Session completed: ${payload.sessionId}`)

    // Update session state
    p2pSession.session.phase = MuSigSessionPhase.COMPLETE
    p2pSession.session.updatedAt = Date.now()

    // Update metrics
    this.metrics.sessionsCompleted++

    // Deserialize final signature if present
    let finalSignature: Buffer | undefined
    if (payload.finalSignature) {
      try {
        finalSignature = deserializeSignature(payload.finalSignature)
      } catch (error) {
        console.error(
          `[MuSig2] Failed to deserialize final signature for session ${payload.sessionId}:`,
          error,
        )
        // Still emit event but without signature
        this.emit(MuSig2Event.SESSION_COMPLETE, {
          sessionId: payload.sessionId,
          finalSignature: undefined,
          fromPeerId,
        })
        return
      }
    }

    // Emit completion event with deserialized signature
    this.emit(MuSig2Event.SESSION_COMPLETE, {
      sessionId: payload.sessionId,
      finalSignature,
      fromPeerId,
    })
  }

  /**
   * Handle nonce share from peer (MuSig2 Round 1)
   *
   * ARCHITECTURE NOTE: Payload validation is performed by protocol.ts before
   * this handler is called. No re-validation needed here.
   */
  private _handleNonceShare = async (
    payload: NonceSharePayload,
    fromPeerId: string,
  ): Promise<void> => {
    // NOTE: Payload already validated by protocol.ts via _validateAndRouteMessage()

    const p2pSession = this.sessions.get(payload.sessionId)
    if (!p2pSession) {
      console.warn(
        `[MuSig2] Received nonce for unknown session: ${payload.sessionId}`,
      )
      return
    }

    try {
      // Deserialize nonce points using serialization layer
      const publicNonces = deserializePublicNonces(payload.publicNonces)

      // Add nonces to session using session manager
      // TODO: Update session manager to support ν ≥ 2 nonces
      // For now, cast to [Point, Point] for compatibility
      const nonceTuple = publicNonces.slice(0, 2) as [Point, Point]
      this.sessionManager.receiveNonces(
        p2pSession.session,
        payload.signerIndex,
        nonceTuple,
      )

      // Update participant state
      const participant = p2pSession.participants.get(fromPeerId)
      if (participant) {
        participant.hasNonce = true
        participant.lastSeen = Date.now()
      }

      p2pSession.lastActivity = Date.now()

      console.log(
        `[MuSig2] Received ${publicNonces.length} nonces from peer ${fromPeerId} (index ${payload.signerIndex})`,
      )

      this.emit(
        MuSig2Event.NONCE_RECEIVED,
        payload.sessionId,
        payload.signerIndex,
      )

      // Check if all nonces collected
      if (this.sessionManager.hasAllNonces(p2pSession.session)) {
        console.log(`[MuSig2] All nonces collected for ${payload.sessionId}`)

        // Clear nonce timeout
        this._clearSessionTimeout(payload.sessionId)

        // Transition to PARTIAL_SIG_EXCHANGE phase
        p2pSession.session.phase = MuSigSessionPhase.PARTIAL_SIG_EXCHANGE
        p2pSession.session.updatedAt = Date.now()

        // Emit event - ready for partial signatures
        this.emit(MuSig2Event.NONCES_COMPLETE, payload.sessionId)
      }
    } catch (error) {
      console.error('[MuSig2] Error processing nonce share:', error)
      this.emit(MuSig2Event.SESSION_ERROR, payload.sessionId, error)
    }
  }

  /**
   * Handle partial signature share from peer
   *
   * ARCHITECTURE NOTE: Payload validation is performed by protocol.ts before
   * this handler is called. No re-validation needed here.
   */
  private _handlePartialSigShare = async (
    payload: PartialSigSharePayload,
    fromPeerId: string,
  ): Promise<void> => {
    // NOTE: Payload already validated by protocol.ts via _validateAndRouteMessage()

    const p2pSession = this.sessions.get(payload.sessionId)
    if (!p2pSession) {
      console.warn(
        `[MuSig2] Received partial sig for unknown session: ${payload.sessionId}`,
      )
      return
    }

    try {
      // Deserialize partial signature using serialization layer
      const partialSig = deserializeBN(payload.partialSig)

      // Add partial signature to session using session manager
      this.sessionManager.receivePartialSignature(
        p2pSession.session,
        payload.signerIndex,
        partialSig,
      )

      // Update participant state
      const participant = p2pSession.participants.get(fromPeerId)
      if (participant) {
        participant.hasPartialSig = true
        participant.lastSeen = Date.now()
      }

      p2pSession.lastActivity = Date.now()

      console.log(
        `[MuSig2] Received partial sig from peer ${fromPeerId} (index ${payload.signerIndex})`,
      )

      this.emit(
        MuSig2Event.PARTIAL_SIG_RECEIVED,
        payload.sessionId,
        payload.signerIndex,
      )

      // Check if all partial signatures collected
      if (this.sessionManager.hasAllPartialSignatures(p2pSession.session)) {
        console.log(
          `[MuSig2] All partial signatures collected for ${payload.sessionId}`,
        )

        // Clear partial sig timeout
        this._clearSessionTimeout(payload.sessionId)

        // Auto-transition to COMPLETE
        p2pSession.session.phase = MuSigSessionPhase.COMPLETE
        p2pSession.session.updatedAt = Date.now()

        this.emit(MuSig2Event.PARTIAL_SIGS_COMPLETE, payload.sessionId)

        // If election is enabled and I'm the coordinator, set broadcast timeout
        if (
          this.config.enableCoordinatorElection &&
          this.config.enableCoordinatorFailover &&
          this.sessionManager.isCoordinator(p2pSession.session)
        ) {
          this._setBroadcastTimeout(payload.sessionId)
          this.emit(
            MuSig2Event.SHOULD_BROADCAST,
            payload.sessionId,
            p2pSession.session.coordinatorIndex,
          )
        }
      }
    } catch (error) {
      console.error('[MuSig2] Error processing partial signature:', error)
      this.emit(MuSig2Event.SESSION_ERROR, payload.sessionId, error)
    }
  }

  /**
   * Handle session abort from peer
   *
   * ARCHITECTURE NOTE: Payload validation is performed by protocol.ts before
   * this handler is called. No re-validation needed here.
   */
  private _handleSessionAbort = async (
    payload: SessionAbortPayload,
    fromPeerId: string,
  ): Promise<void> => {
    // NOTE: Payload already validated by protocol.ts via _validateAndRouteMessage()

    const p2pSession = this.sessions.get(payload.sessionId)
    if (!p2pSession) {
      return
    }

    console.log(
      `[MuSig2] Session ${payload.sessionId} aborted by ${fromPeerId}: ${payload.reason}`,
    )

    // Mark session as aborted
    p2pSession.session.phase = MuSigSessionPhase.ABORTED
    p2pSession.session.abortReason = payload.reason

    this.emit(MuSig2Event.SESSION_ABORTED, payload.sessionId, payload.reason)

    // Remove session
    this.sessions.delete(payload.sessionId)
  }

  /**
   * Handle session join request from participant (coordinator receives this)
   *
   * ARCHITECTURE NOTE: Payload validation is performed by protocol.ts before
   * this handler is called. No re-validation needed here.
   *
   * RACE CONDITION FIX: Uses session lock to prevent concurrent join requests
   * from corrupting the participants map.
   */
  private _handleSessionJoin = async (
    payload: SessionJoinPayload,
    fromPeerId: string,
  ): Promise<void> => {
    // NOTE: Payload already validated by protocol.ts via _validateAndRouteMessage()
    // If we reach this handler, the payload structure is guaranteed to be valid.

    const p2pSession = this.sessions.get(payload.sessionId)

    // Session not found - reject (no lock needed for this check)
    if (!p2pSession) {
      console.warn(
        `[MuSig2] Received join request for unknown session: ${payload.sessionId}`,
      )
      await this._sendJoinAck(fromPeerId, {
        sessionId: payload.sessionId,
        accepted: false,
        reason: 'Session not found',
        timestamp: Date.now(),
      })
      return
    }

    // Only coordinator can accept join requests (no lock needed)
    if (!p2pSession.isCoordinator) {
      console.warn(
        `[MuSig2] Received join request but not coordinator for session: ${payload.sessionId}`,
      )
      await this._sendJoinAck(fromPeerId, {
        sessionId: payload.sessionId,
        accepted: false,
        reason: 'Not the coordinator',
        timestamp: Date.now(),
      })
      return
    }

    // Validate the signer public key (no lock needed)
    let signerPubKey: PublicKey
    try {
      signerPubKey = deserializePublicKey(payload.signerPublicKey)
    } catch (error) {
      console.warn(`[MuSig2] Invalid signer public key in join request`)
      await this._sendJoinAck(fromPeerId, {
        sessionId: payload.sessionId,
        accepted: false,
        reason: 'Invalid public key format',
        timestamp: Date.now(),
      })
      return
    }

    // Find signer index in session (no lock needed - signers list is immutable)
    const signerIndex = p2pSession.session.signers.findIndex(pk =>
      pk.toBuffer().equals(signerPubKey.toBuffer()),
    )

    if (signerIndex === -1) {
      console.warn(
        `[MuSig2] Public key not in signers list for session: ${payload.sessionId}`,
      )
      await this._sendJoinAck(fromPeerId, {
        sessionId: payload.sessionId,
        accepted: false,
        reason: 'Public key not in signers list',
        timestamp: Date.now(),
      })
      return
    }

    // RACE CONDITION FIX: Acquire lock for atomic participant check-and-add
    await withSessionLock(this.sessionLock, payload.sessionId, async () => {
      // Re-check session exists (may have been deleted while waiting for lock)
      const session = this.sessions.get(payload.sessionId)
      if (!session) {
        await this._sendJoinAck(fromPeerId, {
          sessionId: payload.sessionId,
          accepted: false,
          reason: 'Session no longer exists',
          timestamp: Date.now(),
        })
        return
      }

      // Atomic check: participant already joined?
      if (session.participants.has(fromPeerId)) {
        console.warn(
          `[MuSig2] Peer ${fromPeerId} already joined session: ${payload.sessionId}`,
        )
        await this._sendJoinAck(fromPeerId, {
          sessionId: payload.sessionId,
          accepted: false,
          reason: 'Already joined',
          timestamp: Date.now(),
        })
        return
      }

      // Atomic check: signer index already taken by another peer?
      for (const [peerId, participant] of session.participants) {
        if (participant.signerIndex === signerIndex) {
          console.warn(
            `[MuSig2] Signer index ${signerIndex} already taken by peer ${peerId}`,
          )
          await this._sendJoinAck(fromPeerId, {
            sessionId: payload.sessionId,
            accepted: false,
            reason: 'Signer index already taken',
            timestamp: Date.now(),
          })
          return
        }
      }

      // Atomic add: Accept the join request - add participant
      const participant: SessionParticipant = {
        peerId: fromPeerId,
        signerIndex,
        publicKey: signerPubKey,
        hasNonce: false,
        hasPartialSig: false,
        lastSeen: Date.now(),
      }

      session.participants.set(fromPeerId, participant)
      session.lastActivity = Date.now()

      console.log(
        `[MuSig2] Accepted join request from ${fromPeerId} for session ${payload.sessionId} (index ${signerIndex})`,
      )

      // Send acceptance
      await this._sendJoinAck(fromPeerId, {
        sessionId: payload.sessionId,
        accepted: true,
        signerIndex,
        timestamp: Date.now(),
      })

      // Emit participant joined event
      this.emit(MuSig2Event.PARTICIPANT_JOINED, payload.sessionId, participant)

      // Check if all participants joined (excluding ourselves)
      if (session.participants.size === session.session.signers.length - 1) {
        console.log(
          `[MuSig2] All participants joined session ${payload.sessionId}`,
        )
        this.emit(MuSig2Event.SESSION_READY, payload.sessionId)
      }
    })
  }

  /**
   * Handle session join acknowledgment from coordinator (participant receives this)
   *
   * ARCHITECTURE NOTE: Payload validation is performed by protocol.ts before
   * this handler is called. No re-validation needed here.
   */
  private _handleSessionJoinAck = async (
    payload: SessionJoinAckPayload,
    fromPeerId: string,
  ): Promise<void> => {
    // NOTE: Payload already validated by protocol.ts via _validateAndRouteMessage()

    const p2pSession = this.sessions.get(payload.sessionId)

    if (!p2pSession) {
      console.warn(
        `[MuSig2] Received join ack for unknown session: ${payload.sessionId}`,
      )
      return
    }

    if (payload.accepted) {
      console.log(
        `[MuSig2] Join accepted for session ${payload.sessionId}, signer index: ${payload.signerIndex}`,
      )

      // Update our session state with the assigned signer index
      if (payload.signerIndex !== undefined) {
        p2pSession.session.myIndex = payload.signerIndex
      }

      // Mark coordinator as a participant (for tracking)
      if (!p2pSession.participants.has(fromPeerId)) {
        const coordinatorPubKey =
          p2pSession.session.signers[p2pSession.session.coordinatorIndex ?? 0]
        p2pSession.participants.set(fromPeerId, {
          peerId: fromPeerId,
          signerIndex: p2pSession.session.coordinatorIndex ?? 0,
          publicKey: coordinatorPubKey,
          hasNonce: false,
          hasPartialSig: false,
          lastSeen: Date.now(),
        })
      }

      p2pSession.lastActivity = Date.now()

      // Emit join accepted event
      this.emit('session:join-accepted', {
        sessionId: payload.sessionId,
        signerIndex: payload.signerIndex,
        coordinatorPeerId: fromPeerId,
      })
    } else {
      console.warn(
        `[MuSig2] Join rejected for session ${payload.sessionId}: ${payload.reason}`,
      )

      // Emit join rejected event
      this.emit('session:join-rejected', {
        sessionId: payload.sessionId,
        reason: payload.reason,
        coordinatorPeerId: fromPeerId,
      })

      // Remove the session since we couldn't join
      this.sessions.delete(payload.sessionId)
    }
  }

  /**
   * Send join acknowledgment to a peer
   */
  private async _sendJoinAck(
    peerId: string,
    payload: SessionJoinAckPayload,
  ): Promise<void> {
    try {
      // Validate payload before sending
      validateSessionJoinAckPayload(payload)

      const message = this.protocol.createMessage(
        MuSig2MessageType.SESSION_JOIN_ACK,
        JSON.stringify(payload),
        this.peerId,
        { protocol: 'musig2' },
      )

      await this.coordinator.sendTo(
        peerId,
        message,
        this.protocolHandler.protocolId,
      )
    } catch (error) {
      console.error(`[MuSig2] Failed to send join ack to ${peerId}:`, error)
    }
  }

  /**
   * Handle peer disconnection
   */
  private _handlePeerDisconnected = (peerId: string): void => {
    // Find sessions with this peer
    for (const [sessionId, p2pSession] of this.sessions) {
      if (p2pSession.participants.has(peerId)) {
        console.warn(
          `[MuSig2] Peer ${peerId} disconnected from session ${sessionId}`,
        )

        // If session is in progress, consider aborting
        if (
          p2pSession.session.phase === MuSigSessionPhase.NONCE_EXCHANGE ||
          p2pSession.session.phase === MuSigSessionPhase.PARTIAL_SIG_EXCHANGE
        ) {
          this.abortSession(
            sessionId,
            `Participant ${peerId} disconnected`,
          ).catch(error => {
            console.error('[MuSig2] Error aborting session:', error)
          })
        }
      }
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Send message to participants with validation and serialization integration
   */
  private async _broadcastToSessionParticipants(
    sessionId: string,
    messageType: MuSig2MessageType,
    payload:
      | SessionJoinPayload
      | SessionJoinAckPayload
      | NonceSharePayload
      | PartialSigSharePayload
      | SessionAbortPayload
      | SessionCompletePayload,
  ): Promise<void> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Get all participant peer IDs
    const peerIds = Array.from(p2pSession.participants.keys())

    try {
      // Step 1: Validate payload before serialization
      const validatedPayload = this._validatePayloadForMessage(
        messageType,
        payload,
      )

      // Step 2: Serialize payload using JSON (for now - can be enhanced later)
      const serializedPayload = JSON.stringify(validatedPayload)

      // Step 3: Create P2P message with serialized payload
      const message = this.protocol.createMessage(
        messageType,
        serializedPayload,
        this.peerId,
        { protocol: 'musig2' },
      )

      // Step 4: Send to all participants
      await this.coordinator.broadcast(message, {
        includedOnly: peerIds,
      })

      console.log(
        `[MuSig2] Sent ${messageType} to ${peerIds.length} participants for session ${p2pSession.session.sessionId}`,
      )
    } catch (error) {
      console.error(
        `[MuSig2] Failed to send ${messageType} for session ${p2pSession.session.sessionId}:`,
        error,
      )
      this.emit('send:error', {
        messageType,
        sessionId: p2pSession.session.sessionId,
        error,
        peerIds,
      })
      throw error
    }
  }

  /**
   * Validate payload for specific message type
   */
  private _validatePayloadForMessage(
    messageType: MuSig2MessageType,
    payload:
      | SessionJoinPayload
      | SessionJoinAckPayload
      | NonceSharePayload
      | PartialSigSharePayload
      | SessionAbortPayload
      | SessionCompletePayload,
  ):
    | SessionJoinPayload
    | SessionJoinAckPayload
    | NonceSharePayload
    | PartialSigSharePayload
    | SessionAbortPayload
    | SessionCompletePayload {
    switch (messageType) {
      case MuSig2MessageType.SESSION_JOIN:
        validateSessionJoinPayload(payload)
        return payload

      case MuSig2MessageType.SESSION_JOIN_ACK:
        validateSessionJoinAckPayload(payload)
        return payload

      case MuSig2MessageType.NONCE_SHARE:
        validateNonceSharePayload(payload)
        return payload

      case MuSig2MessageType.PARTIAL_SIG_SHARE:
        validatePartialSigSharePayload(payload)
        return payload

      case MuSig2MessageType.SESSION_ABORT:
        validateSessionAbortPayload(payload)
        return payload

      case MuSig2MessageType.SESSION_COMPLETE:
        validateSessionCompletePayload(payload)
        return payload

      default:
        throw new Error(`Unknown message type: ${messageType}`)
    }
  }

  /**
   * Start automatic session cleanup
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this._cleanupExpiredSessions()
    }, this.config.cleanupInterval)
  }

  /**
   * Cleanup expired sessions (internal periodic cleanup)
   */
  private _cleanupExpiredSessions(): void {
    const now = Date.now()
    const maxAge = 10 * 60 * 1000 // 10 minutes

    for (const [sessionId, p2pSession] of this.sessions) {
      // Remove old sessions
      if (now - p2pSession.lastActivity > maxAge) {
        console.log(`[MuSig2] Cleaning up expired session: ${sessionId}`)
        this._clearSessionTimeout(sessionId)
        this.sessions.delete(sessionId)
      }
    }
  }

  /**
   * Set timeout for nonce collection (MuSig2 Round 1)
   */
  private _setNonceTimeout(sessionId: string): void {
    // Clear existing timeout
    this._clearSessionTimeout(sessionId)

    // Set new timeout
    const timeout = setTimeout(() => {
      const p2pSession = this.sessions.get(sessionId)
      if (!p2pSession) return

      if (p2pSession.session.phase === MuSigSessionPhase.INIT) {
        console.warn(
          `[MuSig2] Nonce collection timeout for session: ${sessionId}`,
        )
        this.metrics.sessionsTimedOut++
        this.emit(MuSig2Event.SESSION_TIMEOUT, sessionId, 'nonce-collection')
        this.abortSession(sessionId, 'Timeout waiting for nonces').catch(
          console.error,
        )
      }
    }, this.config.nonceTimeout)

    this.sessionTimeouts.set(sessionId, timeout)
  }

  /**
   * Set timeout for partial signature collection
   */
  private _setPartialSigTimeout(sessionId: string): void {
    // Clear existing timeout
    this._clearSessionTimeout(sessionId)

    // Set new timeout
    const timeout = setTimeout(() => {
      const p2pSession = this.sessions.get(sessionId)
      if (!p2pSession) return

      if (p2pSession.session.phase === MuSigSessionPhase.PARTIAL_SIG_EXCHANGE) {
        console.warn(
          `[MuSig2] Partial signature collection timeout for session: ${sessionId}`,
        )
        this.metrics.sessionsTimedOut++
        this.emit(
          MuSig2Event.SESSION_TIMEOUT,
          sessionId,
          'partial-sig-collection',
        )
        this.abortSession(
          sessionId,
          'Timeout waiting for partial signatures',
        ).catch(console.error)
      }
    }, this.config.partialSigTimeout)

    this.sessionTimeouts.set(sessionId, timeout)
  }

  /**
   * Clear session timeout
   */
  private _clearSessionTimeout(sessionId: string): void {
    const timeout = this.sessionTimeouts.get(sessionId)
    if (timeout) {
      clearTimeout(timeout)
      this.sessionTimeouts.delete(sessionId)
    }
  }

  /**
   * Hash nonce for reuse prevention (supports ν ≥ 2 nonces)
   */
  private _hashNonce(publicNonces: Point[]): string {
    // Concatenate all nonce points for hashing using serialization layer
    const allNonceBytes = publicNonces.map(nonce =>
      Buffer.from(serializePoint(nonce), 'hex'),
    )
    return Hash.sha256(Buffer.concat(allNonceBytes)).toString('hex')
  }

  /**
   * Get election method enum from config string
   */
  private _getElectionMethod(): ElectionMethod {
    switch (this.config.electionMethod) {
      case 'lexicographic':
        return ElectionMethod.LEXICOGRAPHIC
      case 'hash-based':
        return ElectionMethod.HASH_BASED
      case 'first-signer':
        return ElectionMethod.FIRST_SIGNER
      case 'last-signer':
        return ElectionMethod.LAST_SIGNER
      default:
        return ElectionMethod.LEXICOGRAPHIC
    }
  }

  /**
   * Set broadcast timeout for coordinator failover
   */
  private _setBroadcastTimeout(sessionId: string): void {
    // Clear existing timeout
    this._clearBroadcastTimeout(sessionId)

    // Set new timeout
    const timeout = setTimeout(() => {
      this._handleBroadcastTimeout(sessionId).catch(console.error)
    }, this.config.broadcastTimeout)

    this.broadcastTimeouts.set(sessionId, timeout)
  }

  /**
   * Clear broadcast timeout
   */
  private _clearBroadcastTimeout(sessionId: string): void {
    const timeout = this.broadcastTimeouts.get(sessionId)
    if (timeout) {
      clearTimeout(timeout)
      this.broadcastTimeouts.delete(sessionId)
    }
  }

  /**
   * Handle broadcast timeout (coordinator failover)
   */
  private async _handleBroadcastTimeout(sessionId: string): Promise<void> {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) return

    const session = p2pSession.session

    console.warn(
      `[MuSig2] Broadcast timeout for session ${sessionId}, initiating failover`,
    )

    // Get backup coordinator
    if (!session.coordinatorIndex || !session.electionMethod) {
      console.error('[MuSig2] Cannot failover: no election data')
      return
    }

    const backup = getBackupCoordinator(
      session.signers,
      session.coordinatorIndex,
      this._getElectionMethod(),
    )

    if (backup === null) {
      console.error(
        '[MuSig2] No backup coordinator available, failover exhausted',
      )
      this.emit(MuSig2Event.FAILOVER_EXHAUSTED, sessionId)
      return
    }

    // Update coordinator index
    const oldCoordinator = session.coordinatorIndex
    session.coordinatorIndex = backup
    session.updatedAt = Date.now()

    console.log(`[MuSig2] Failover: coordinator ${oldCoordinator} → ${backup}`)
    this.emit(MuSig2Event.COORDINATOR_FAILED, sessionId, oldCoordinator)

    // Check if I am the new coordinator
    if (this.sessionManager.isCoordinator(session)) {
      console.log(`[MuSig2] I am now coordinator for session ${sessionId}`)
      this.emit(MuSig2Event.SHOULD_BROADCAST, sessionId, backup)
    }

    // Set new broadcast timeout for backup coordinator
    this._setBroadcastTimeout(sessionId)
  }

  /**
   * Clear session nonces from tracking (memory management)
   */
  private _clearSessionNonces(session: MuSigSession): void {
    if (session.myPublicNonce) {
      const nonceHash = this._hashNonce(session.myPublicNonce)
      this.usedNonces.delete(nonceHash)
    }
  }

  /**
   * Get session participants
   */
  getParticipants(sessionId: string): SessionParticipant[] {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return Array.from(p2pSession.participants.values())
  }

  /**
   * Get specific participant
   */
  getParticipant(
    sessionId: string,
    peerId: string,
  ): SessionParticipant | undefined {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      return undefined
    }
    return p2pSession.participants.get(peerId)
  }

  /**
   * Remove participant from session
   */
  removeParticipant(sessionId: string, peerId: string): boolean {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      return false
    }

    const removed = p2pSession.participants.delete(peerId)
    if (removed) {
      console.log(
        `[MuSig2] Removed participant ${peerId} from session ${sessionId}`,
      )
      p2pSession.lastActivity = Date.now()
    }
    return removed
  }

  /**
   * Get comprehensive validation and serialization status
   */
  getValidationStatus() {
    return {
      validation: {
        enabled: true,
        layer: 'comprehensive',
        fieldSafety: 'type-safe',
        errorHandling: 'enhanced',
      },
      serialization: {
        enabled: true,
        format: 'network-safe',
        compression: 'optional',
        errorHandling: 'enhanced',
      },
      protocol: {
        validationEnabled: true,
        errorHandlingEnabled: true,
        securityChecksEnabled: true,
      },
      security: this.securityValidator.getSecurityStatus(),
      metrics: this.metrics,
    }
  }

  /**
   * Get security status from the security validator (Phase 5)
   */
  getSecurityStatus() {
    return this.securityValidator.getSecurityStatus()
  }

  /**
   * Check if a peer is blocked by the security validator (Phase 5)
   */
  isPeerBlocked(peerId: string): boolean {
    return this.securityValidator.isPeerBlocked(peerId)
  }

  /**
   * Unblock a peer (Phase 5)
   */
  unblockPeer(peerId: string): boolean {
    return this.securityValidator.unblockPeer(peerId)
  }

  /**
   * Get session metrics and status
   */
  getSessionMetrics() {
    return {
      ...this.metrics,
      activeSessions: this.sessions.size,
      usedNonces: this.usedNonces.size,
      validation: {
        enabled: true,
        errorHandlingEnabled: true,
        securityChecksEnabled: true,
      },
      security: this.securityValidator.getSecurityStatus(),
    }
  }

  /**
   * Get coordinator metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeSessions: this.sessions.size,
      totalUsedNonces: this.usedNonces.size,
      validationStatus: this.getValidationStatus(),
    }
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size
  }

  // ============================================================================
  // Coordinator Election Methods
  // ============================================================================

  /**
   * Check if this participant is the coordinator for a session
   */
  isCoordinator(sessionId: string): boolean {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return this.sessionManager.isCoordinator(p2pSession.session)
  }

  /**
   * Get coordinator information for a session
   */
  getCoordinatorInfo(sessionId: string): {
    coordinatorIndex: number | undefined
    isCoordinator: boolean
    electionMethod: string | undefined
    electionProof: string | undefined
    backupCoordinators: number[] | undefined
  } {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session
    return {
      coordinatorIndex: session.coordinatorIndex,
      isCoordinator: this.sessionManager.isCoordinator(session),
      electionMethod: session.electionMethod,
      electionProof: session.electionProof,
      backupCoordinators: session.backupCoordinators,
    }
  }

  /**
   * Get backup coordinator for a session
   */
  getBackupCoordinator(sessionId: string): number | null {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session
    if (!session.coordinatorIndex || !session.electionMethod) {
      return null
    }

    return getBackupCoordinator(
      session.signers,
      session.coordinatorIndex,
      this._getElectionMethod(),
    )
  }

  /**
   * Get coordinator priority list for a session
   */
  getCoordinatorPriorityList(sessionId: string): number[] {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const session = p2pSession.session
    if (session.backupCoordinators) {
      return session.backupCoordinators
    }

    if (!session.electionMethod) {
      throw new Error('Session does not have election data')
    }

    return getCoordinatorPriorityList(
      session.signers,
      this._getElectionMethod(),
    )
  }

  /**
   * Notify that broadcast has been completed (cancels failover timeout)
   */
  notifyBroadcastComplete(sessionId: string): void {
    this._clearBroadcastTimeout(sessionId)
    console.log(`[MuSig2] Broadcast confirmed for session ${sessionId}`)
    this.emit(MuSig2Event.BROADCAST_CONFIRMED, sessionId)
  }

  /**
   * Add participant to session
   */
  addParticipant(
    sessionId: string,
    peerId: string,
    signerIndex: number,
    publicKey: PublicKey,
  ): void {
    const p2pSession = this.sessions.get(sessionId)
    if (!p2pSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Prevent duplicate participants
    if (p2pSession.participants.has(peerId)) {
      throw new Error(`Participant ${peerId} already in session ${sessionId}`)
    }

    // Validate signer index
    if (signerIndex < 0 || signerIndex >= p2pSession.session.signers.length) {
      throw new Error(`Invalid signer index: ${signerIndex}`)
    }

    // Verify public key matches signer index
    const expectedPubKey = p2pSession.session.signers[signerIndex]
    if (!expectedPubKey.toBuffer().equals(publicKey.toBuffer())) {
      throw new Error(`Public key mismatch for signer index ${signerIndex}`)
    }

    const participant: SessionParticipant = {
      peerId,
      signerIndex,
      publicKey,
      hasNonce: false,
      hasPartialSig: false,
      lastSeen: Date.now(),
    }

    p2pSession.participants.set(peerId, participant)
    p2pSession.lastActivity = Date.now()

    console.log(
      `[MuSig2] Added participant ${peerId} to session ${sessionId} (index ${signerIndex})`,
    )

    this.emit(MuSig2Event.PARTICIPANT_JOINED, sessionId, participant)

    // Check if all participants joined
    if (
      p2pSession.participants.size ===
      p2pSession.session.signers.length - 1
    ) {
      // -1 because we don't count ourselves
      console.log(`[MuSig2] All participants joined session ${sessionId}`)
      this.emit(MuSig2Event.SESSION_READY, sessionId)
    }
  }

  // ============================================================================
  // Phase 4 Security Methods
  // ============================================================================

  /**
   * Get the message signer instance
   * Useful for external signing operations
   */
  getMessageSigner(): MuSig2MessageSigner {
    return this.messageSigner
  }

  /**
   * Get the replay protection instance
   * Useful for external validation or monitoring
   */
  getReplayProtection(): ReplayProtection {
    return this.replayProtection
  }

  /**
   * Get the next sequence number for a session
   * Used when constructing outgoing messages
   */
  getNextSequenceNumber(sessionId: string): number {
    const current = this.sessionSequences.get(sessionId) ?? -1
    const next = current + 1
    this.sessionSequences.set(sessionId, next)
    return next
  }

  /**
   * Get comprehensive security status including Phase 4 additions
   */
  getPhase4SecurityStatus() {
    return {
      messageSigning: {
        enabled: true,
        config: this.messageSigner.getConfig(),
      },
      replayProtection: {
        enabled: true,
        stats: this.replayProtection.getStats(),
      },
      sequenceTracking: {
        activeSessions: this.sessionSequences.size,
      },
      securityValidator: this.securityValidator.getSecurityStatus(),
    }
  }
}
