/**
 * MuSig2 Protocol Handler
 *
 * Handles MuSig2-specific P2P messages and routing.
 *
 * ARCHITECTURE:
 * This module is the SINGLE POINT OF INGRESS VALIDATION for MuSig2 messages.
 *
 * Validation Flow:
 * 1. security.ts: validateMessage() - Security constraints only (DoS, blocking, timestamp)
 * 2. protocol.ts: _validateAndRouteMessage() - Payload structure validation (THIS MODULE)
 * 3. coordinator.ts: Event handlers - Business logic only (no re-validation)
 *
 * Egress Flow:
 * 1. coordinator.ts: _validatePayloadForMessage() - Validates before sending
 * 2. coordinator.ts: _broadcastToSessionParticipants() - Sends validated payload
 *
 * This separation ensures:
 * - No double validation on ingress
 * - Clear separation of concerns
 * - Security checks happen before payload parsing
 * - Business logic handlers receive pre-validated payloads
 */

import type {
  IProtocolHandler,
  P2PMessage,
  PeerInfo,
  Stream,
  Connection,
} from '../types.js'
import {
  MuSig2MessageType,
  type SessionJoinPayload,
  type SessionJoinAckPayload,
  type NonceSharePayload,
  type PartialSigSharePayload,
  type SessionAbortPayload,
  type SessionCompletePayload,
} from './types.js'
import { EventEmitter } from 'events'
import {
  validateMessageStructure,
  validateSessionJoinPayload,
  validateSessionJoinAckPayload,
  validateNonceSharePayload,
  validatePartialSigSharePayload,
  validateSessionAbortPayload,
  validateSessionCompletePayload,
} from './validation.js'
import {
  ValidationError,
  DeserializationError,
  SerializationError,
  ErrorCode,
} from './errors.js'
import type { MuSig2SecurityValidator } from './security.js'
import {
  MuSig2MessageSigner,
  type SignedP2PMessage,
} from './message-signing.js'
import { ReplayProtection } from './replay-protection.js'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'

type Message =
  | SessionJoinPayload
  | SessionJoinAckPayload
  | NonceSharePayload
  | PartialSigSharePayload
  | SessionAbortPayload
  | SessionCompletePayload

/**
 * MuSig2 Protocol Handler
 *
 * Implements IProtocolHandler for MuSig2-specific messages
 * Routes messages to appropriate event handlers
 * Integrates with security validator for message validation
 */
export class MuSig2ProtocolHandler
  extends EventEmitter
  implements IProtocolHandler
{
  readonly protocolName = 'musig2'
  readonly protocolId = '/lotus/musig2/1.0.0'

  // Security validator reference (set by coordinator)
  private securityValidator?: MuSig2SecurityValidator

  // Message signer for signature verification (Phase 4)
  private messageSigner: MuSig2MessageSigner = new MuSig2MessageSigner()

  // Replay protection (Phase 4)
  private replayProtection: ReplayProtection = new ReplayProtection()

  // Whether to require signatures on messages (Phase 4)
  private requireSignatures: boolean = false

  // Session public key resolver (set by coordinator)
  private publicKeyResolver?: (
    sessionId: string,
    signerIndex: number,
  ) => PublicKey | undefined

  /**
   * Set the security validator for message validation
   */
  setSecurityValidator(validator: MuSig2SecurityValidator): void {
    this.securityValidator = validator
  }

  /**
   * Set the message signer for signature verification (Phase 4)
   */
  setMessageSigner(signer: MuSig2MessageSigner): void {
    this.messageSigner = signer
  }

  /**
   * Set the replay protection instance (Phase 4)
   */
  setReplayProtection(protection: ReplayProtection): void {
    this.replayProtection = protection
  }

  /**
   * Enable or disable signature requirement (Phase 4)
   * When enabled, unsigned messages will be rejected
   */
  setRequireSignatures(require: boolean): void {
    this.requireSignatures = require
  }

  /**
   * Set the public key resolver for signature verification (Phase 4)
   * The resolver should return the public key for a given session/signer
   */
  setPublicKeyResolver(
    resolver: (sessionId: string, signerIndex: number) => PublicKey | undefined,
  ): void {
    this.publicKeyResolver = resolver
  }

  /**
   * Handle incoming MuSig2 message with security and validation integration
   *
   * Phase 4 Security Flow:
   * 1. Basic protocol validation
   * 2. Security validation (DoS, blocking, timestamp)
   * 3. Signature verification (if enabled)
   * 4. Replay protection validation
   * 5. Message structure validation
   * 6. Payload validation and routing
   */
  async handleMessage(message: P2PMessage, from: PeerInfo): Promise<void> {
    try {
      // Step 1: Basic protocol validation
      if (message.protocol !== this.protocolName) {
        console.warn(
          `[MuSig2Protocol] Ignoring message with wrong protocol: ${message.protocol}`,
        )
        return
      }

      // Step 2: Security validation (if validator is set)
      if (this.securityValidator) {
        const isSecure = await this.securityValidator.validateMessage(
          message,
          from,
        )
        if (!isSecure) {
          console.warn(
            `[MuSig2Protocol] Security validation failed for ${message.type} from ${from.peerId}`,
          )
          this.emit('security:rejected', {
            message,
            from,
            reason: 'security_validation_failed',
          })
          return
        }
      }

      // Step 3: Signature verification (Phase 4)
      if (this.requireSignatures) {
        const signatureResult = this._verifyMessageSignature(message, from)
        if (!signatureResult.valid) {
          console.warn(
            `[MuSig2Protocol] Signature verification failed for ${message.type} from ${from.peerId}: ${signatureResult.reason}`,
          )
          this.emit('security:rejected', {
            message,
            from,
            reason: signatureResult.reason || 'signature_verification_failed',
          })
          return
        }
      }

      // Step 4: Replay protection (Phase 4)
      const payload = message.payload as {
        sessionId?: string
        signerIndex?: number
        sequenceNumber?: number
      }
      const replayResult = this.replayProtection.validateMessage(
        message,
        payload?.sessionId,
        payload?.signerIndex,
        payload?.sequenceNumber,
      )
      if (!replayResult.valid) {
        console.warn(
          `[MuSig2Protocol] Replay protection failed for ${message.type} from ${from.peerId}: ${replayResult.reason}`,
        )
        this.emit('security:rejected', {
          message,
          from,
          reason: replayResult.reason || 'replay_protection_failed',
        })
        return
      }

      // Step 5: Validate message structure (additional validation checks)
      validateMessageStructure(message)

      // Step 6: Route and validate payload based on message type
      const validatedPayload = this._validateAndRouteMessage(message)

      // Step 7: Emit events with validated payloads
      this._emitValidatedMessage(
        message.type as MuSig2MessageType,
        validatedPayload,
        from,
      )
    } catch (error) {
      // Handle validation and security errors
      this._handleMessageError(error, message, from)
    }
  }

  /**
   * Verify message signature (Phase 4)
   *
   * @param message - The message to verify
   * @param from - Peer info of sender
   * @returns Validation result
   */
  private _verifyMessageSignature(
    message: P2PMessage,
    from: PeerInfo,
  ): { valid: boolean; reason?: string } {
    // Check if message has signature
    if (!this.messageSigner.hasSignature(message)) {
      return { valid: false, reason: 'missing_signature' }
    }

    const signedMessage = message as SignedP2PMessage

    // Try to get expected public key from resolver
    let expectedPublicKey: PublicKey | undefined
    if (this.publicKeyResolver) {
      const payload = message.payload as {
        sessionId?: string
        signerIndex?: number
      }
      if (
        payload?.sessionId !== undefined &&
        payload?.signerIndex !== undefined
      ) {
        expectedPublicKey = this.publicKeyResolver(
          payload.sessionId,
          payload.signerIndex,
        )
      }
    }

    // If we have an expected public key from the session, use it
    // Otherwise, use the public key from the message itself
    if (expectedPublicKey) {
      if (!this.messageSigner.verifyMessage(signedMessage, expectedPublicKey)) {
        return { valid: false, reason: 'invalid_signature' }
      }
    } else {
      // Verify using the public key embedded in the message
      if (!this.messageSigner.verifyMessage(signedMessage)) {
        return { valid: false, reason: 'invalid_signature' }
      }
    }

    return { valid: true }
  }

  /**
   * Validate message payload and route to appropriate handler
   */
  private _validateAndRouteMessage(message: P2PMessage): Message {
    switch (message.type) {
      case MuSig2MessageType.SESSION_JOIN:
        validateSessionJoinPayload(message.payload)
        return message.payload as SessionJoinPayload

      case MuSig2MessageType.SESSION_JOIN_ACK:
        validateSessionJoinAckPayload(message.payload)
        return message.payload as SessionJoinAckPayload

      case MuSig2MessageType.NONCE_SHARE:
        validateNonceSharePayload(message.payload)
        return message.payload as NonceSharePayload

      case MuSig2MessageType.PARTIAL_SIG_SHARE:
        validatePartialSigSharePayload(message.payload)
        return message.payload as PartialSigSharePayload

      case MuSig2MessageType.SESSION_ABORT:
        validateSessionAbortPayload(message.payload)
        return message.payload as SessionAbortPayload

      case MuSig2MessageType.SESSION_COMPLETE:
        validateSessionCompletePayload(message.payload)
        return message.payload as SessionCompletePayload

      default:
        throw new ValidationError(
          ErrorCode.INVALID_PAYLOAD,
          `Unknown message type: ${message.type}`,
        )
    }
  }

  /**
   * Emit validated message events
   */
  private _emitValidatedMessage(
    type: MuSig2MessageType,
    payload: Message,
    from: PeerInfo,
  ): void {
    switch (type) {
      case MuSig2MessageType.SESSION_JOIN:
        this.emit('session:join', payload as SessionJoinPayload, from)
        break

      case MuSig2MessageType.SESSION_JOIN_ACK:
        this.emit('session:join-ack', payload as SessionJoinAckPayload, from)
        break

      case MuSig2MessageType.NONCE_SHARE:
        this.emit('nonce:share', payload as NonceSharePayload, from)
        break

      case MuSig2MessageType.PARTIAL_SIG_SHARE:
        this.emit('partial-sig:share', payload as PartialSigSharePayload, from)
        break

      case MuSig2MessageType.SESSION_ABORT:
        this.emit('session:abort', payload as SessionAbortPayload, from)
        break

      case MuSig2MessageType.SESSION_COMPLETE:
        this.emit('session:complete', payload as SessionCompletePayload, from)
        break
    }
  }

  /**
   * Handle message validation and security errors
   */
  private _handleMessageError(
    error: unknown,
    message: P2PMessage,
    from: PeerInfo,
  ): void {
    if (error instanceof ValidationError) {
      console.warn(
        `[MuSig2Protocol] Validation failed for ${message.type} from ${from.peerId}: ${error.message}`,
      )
      this.emit('validation:error', { error, message, from })
      return
    }

    if (error instanceof DeserializationError) {
      console.warn(
        `[MuSig2Protocol] Deserialization failed for ${message.type} from ${from.peerId}: ${error.message}`,
      )
      this.emit('deserialization:error', { error, message, from })
      return
    }

    if (error instanceof SerializationError) {
      console.warn(
        `[MuSig2Protocol] Serialization error for ${message.type} from ${from.peerId}: ${error.message}`,
      )
      this.emit('serialization:error', { error, message, from })
      return
    }

    // Unknown error
    console.error(
      `[MuSig2Protocol] Unexpected error processing ${message.type} from ${from.peerId}:`,
      error,
    )
    this.emit('unexpected:error', { error, message, from })
  }

  /**
   * Handle peer connection
   */
  async onPeerConnected(peerId: string): Promise<void> {
    console.log(`[MuSig2Protocol] Peer connected: ${peerId}`)
    this.emit('peer:connected', peerId)
  }

  /**
   * Handle peer disconnection
   */
  async onPeerDisconnected(peerId: string): Promise<void> {
    console.log(`[MuSig2Protocol] Peer disconnected: ${peerId}`)
    this.emit('peer:disconnected', peerId)
  }

  /**
   * Handle peer discovery
   */
  async onPeerDiscovered(peerInfo: PeerInfo): Promise<void> {
    console.log(`[MuSig2Protocol] Peer discovered: ${peerInfo.peerId}`)
    this.emit('peer:discovered', peerInfo)
  }

  /**
   * Enhanced message payload validation using comprehensive validation layer
   * @deprecated Use validateMessageStructure and specific payload validators instead
   */
  validateMessagePayload(type: MuSig2MessageType, payload: unknown): boolean {
    try {
      // Use the new comprehensive validation system
      switch (type) {
        case MuSig2MessageType.SESSION_JOIN:
          validateSessionJoinPayload(payload)
          break

        case MuSig2MessageType.SESSION_JOIN_ACK:
          validateSessionJoinAckPayload(payload)
          break

        case MuSig2MessageType.NONCE_SHARE:
          validateNonceSharePayload(payload)
          break

        case MuSig2MessageType.PARTIAL_SIG_SHARE:
          validatePartialSigSharePayload(payload)
          break

        case MuSig2MessageType.SESSION_ABORT:
          validateSessionAbortPayload(payload)
          break

        case MuSig2MessageType.SESSION_COMPLETE:
          validateSessionCompletePayload(payload)
          break

        default:
          return false
      }

      return true
    } catch (error) {
      // Validation failed
      return false
    }
  }

  /**
   * Get validation info for debugging and monitoring
   */
  getValidationInfo() {
    return {
      supportedMessageTypes: [
        MuSig2MessageType.SESSION_JOIN,
        MuSig2MessageType.SESSION_JOIN_ACK,
        MuSig2MessageType.NONCE_SHARE,
        MuSig2MessageType.PARTIAL_SIG_SHARE,
        MuSig2MessageType.SESSION_ABORT,
        MuSig2MessageType.SESSION_COMPLETE,
      ],
      validationEnabled: true,
      errorHandlingEnabled: true,
      securityChecksEnabled: true,
      // Phase 4 Security
      signatureVerificationEnabled: this.requireSignatures,
      replayProtectionEnabled: true,
      replayProtectionStats: this.replayProtection.getStats(),
    }
  }

  /**
   * Get Phase 4 security status
   */
  getSecurityStatus() {
    return {
      signatureVerification: {
        enabled: this.requireSignatures,
        hasPublicKeyResolver: !!this.publicKeyResolver,
      },
      replayProtection: this.replayProtection.getStats(),
    }
  }

  /**
   * Start replay protection cleanup timer
   */
  startReplayProtection(): void {
    this.replayProtection.start()
  }

  /**
   * Stop replay protection cleanup timer
   */
  stopReplayProtection(): void {
    this.replayProtection.stop()
  }

  /**
   * Clear session from replay protection
   */
  clearSessionReplayData(sessionId: string): void {
    this.replayProtection.clearSession(sessionId)
  }

  /**
   * Get validation info for debugging and monitoring (legacy)
   * @deprecated Use getValidationInfo() instead
   */
  getLegacyValidationInfo() {
    return {
      supportedMessageTypes: [
        MuSig2MessageType.SESSION_JOIN,
        MuSig2MessageType.SESSION_JOIN_ACK,
        MuSig2MessageType.NONCE_SHARE,
        MuSig2MessageType.PARTIAL_SIG_SHARE,
        MuSig2MessageType.SESSION_ABORT,
        MuSig2MessageType.SESSION_COMPLETE,
      ],
      validationEnabled: true,
      errorHandlingEnabled: true,
      securityChecksEnabled: true,
    }
  }
}
