/**
 * Copyright 2025 The Lotusia Stewardship
 * Github: https://github.com/LotusiaStewardship
 * License: MIT
 */

/**
 * MuSig2 P2P Validation Utilities
 *
 * Comprehensive validation for MuSig2 message payloads and security checks.
 * Supports all 8 message types in the new architecture with MuSig2 ν ≥ 2 compliance.
 *
 * ARCHITECTURE:
 * This module provides PURE VALIDATOR FUNCTIONS with no side effects.
 * These validators are used by:
 * - protocol.ts: For ingress payload validation (single validation point)
 * - coordinator.ts: For egress payload validation (before sending)
 *
 * Validators throw ValidationError on failure, allowing callers to handle
 * errors appropriately (reject message, block peer, etc.).
 *
 * TODO: Add the following validators:
 * - validateSessionAnnouncementSignature(): Verify coordinator signature on announcement
 * - validateNonceProofOfKnowledge(): Verify DLEQ proof for nonce (if implemented)
 * - validatePartialSigProof(): Verify partial signature is valid for the session
 * - validateAggregatedSignature(): Verify final signature before broadcasting
 */

import { ValidationError, ErrorCode, createValidationError } from './errors.js'
import type {
  SessionAnnouncement,
  SessionJoinPayload,
  SessionJoinAckPayload,
  NonceSharePayload,
  PartialSigSharePayload,
  SessionAbortPayload,
  SessionCompletePayload,
} from './types.js'

// ============================================================================
// Local constants
// ============================================================================

const MAX_MESSAGE_SIZE = 100_000 // 100KB - DoS protection
const MAX_TIMESTAMP_SKEW = 5 * 60 * 1000 // 5 minutes
const MAX_INVALID_MESSAGES = 10 // Block peer after 10 invalid messages

// ============================================================================
// Type-Safe Field Name Utilities
// ============================================================================

/**
 * Helper to get field names as strings with full type safety
 * Uses keyof to derive field names directly from the types
 */
function getFieldNames<T>(): Record<keyof T, string> {
  // This creates a type-safe mapping where keys are the actual field names
  // and values are the string representations of those field names
  return {
    sessionId: 'sessionId',
    requiredSigners: 'requiredSigners',
    coordinatorPeerId: 'coordinatorPeerId',
    messageHash: 'messageHash',
    createdAt: 'createdAt',
    expiresAt: 'expiresAt',
    signers: 'signers',
    metadata: 'metadata',
    signerPublicKey: 'signerPublicKey',
    accepted: 'accepted',
    signerIndex: 'signerIndex',
    reason: 'reason',
    publicNonces: 'publicNonces',
    partialSig: 'partialSig',
    finalSignature: 'finalSignature',
    timestamp: 'timestamp',
  } as Record<keyof T, string>
}

// Create type-safe field name mappings derived from actual types
const SESSION_FIELDS = getFieldNames<SessionAnnouncement>()
const JOIN_FIELDS = getFieldNames<SessionJoinPayload>()
const JOIN_ACK_FIELDS = getFieldNames<SessionJoinAckPayload>()
const NONCE_FIELDS = getFieldNames<NonceSharePayload>()
const SIG_FIELDS = getFieldNames<PartialSigSharePayload>()
const ABORT_FIELDS = getFieldNames<SessionAbortPayload>()
const COMPLETE_FIELDS = getFieldNames<SessionCompletePayload>()

// Additional field groups for nested objects
const MESSAGE_FIELDS = {
  type: 'type',
  protocol: 'protocol',
  payload: 'payload',
} as const

const SIGNATURE_FIELDS = {
  r: 'r',
  s: 's',
} as const

// ============================================================================
// Primitive Validation Helpers
// ============================================================================

/**
 * Validate string input
 */
function validateString(
  value: unknown,
  fieldName: string,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string') {
    throw createValidationError(
      `${fieldName} must be a string`,
      ErrorCode.INVALID_TYPE,
      fieldName,
    )
  }

  if (!allowEmpty && value.length === 0) {
    throw createValidationError(
      `${fieldName} cannot be empty`,
      ErrorCode.INVALID_PAYLOAD,
      fieldName,
    )
  }
}

/**
 * Validate number input
 */
function validateNumber(
  value: unknown,
  fieldName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createValidationError(
      `${fieldName} must be a valid number`,
      ErrorCode.INVALID_TYPE,
      fieldName,
    )
  }
}

/**
 * Validate array input
 */
function validateArray(
  value: unknown,
  fieldName: string,
  minLength = 0,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw createValidationError(
      `${fieldName} must be an array`,
      ErrorCode.INVALID_TYPE,
      fieldName,
    )
  }

  if (value.length < minLength) {
    throw createValidationError(
      `${fieldName} must have at least ${minLength} elements`,
      ErrorCode.INVALID_LENGTH,
      fieldName,
    )
  }
}

/**
 * Validate timestamp with skew protection
 */
function validateTimestamp(
  timestamp: unknown,
  fieldName: string,
  maxSkew = 300_000, // 5 minutes
): asserts timestamp is number {
  validateNumber(timestamp, fieldName)

  const now = Date.now()
  const skew = Math.abs(now - timestamp)

  if (skew > maxSkew) {
    throw createValidationError(
      `${fieldName} timestamp skew too large: ${skew}ms > ${maxSkew}ms`,
      ErrorCode.TIMESTAMP_SKEW,
      fieldName,
    )
  }
}

/**
 * Validate hex string format
 */
function validateHexString(
  value: unknown,
  fieldName: string,
  expectedLength?: number,
): asserts value is string {
  validateString(value, fieldName)

  if (!/^[0-9a-fA-F]*$/.test(value)) {
    throw createValidationError(
      `${fieldName} must be a valid hex string`,
      ErrorCode.INVALID_FORMAT,
      fieldName,
    )
  }

  if (expectedLength !== undefined) {
    const buffer = Buffer.from(value, 'hex')
    if (buffer.length !== expectedLength) {
      throw createValidationError(
        `${fieldName} must be ${expectedLength} bytes, got ${buffer.length}`,
        ErrorCode.INVALID_LENGTH,
        fieldName,
      )
    }
  }
}

/**
 * Validate signers array
 */
function validateSignersArray(
  value: unknown,
  fieldName: string,
): asserts value is string[] {
  validateArray(value, fieldName, 1)
  // Validate each public key is a hex string
  value.forEach((pk, index) => {
    validateHexString(pk, `${fieldName}[${index}]`)
  })
}

/**
 * Validate public nonces object (MuSig2 ν ≥ 2 compliance)
 */
function validatePublicNonces(
  value: unknown,
  fieldName: string,
): asserts value is Record<string, string> {
  validateObject(value, fieldName)

  // Must have at least 2 nonces (r1, r2, r3, etc.)
  const nonceKeys = Object.keys(value).filter(key => /^r\d+$/.test(key))
  if (nonceKeys.length < 2) {
    throw createValidationError(
      'MuSig2 requires at least 2 nonces (ν ≥ 2)',
      ErrorCode.INVALID_PAYLOAD,
      fieldName,
    )
  }

  // Validate each nonce is a valid hex string (33-byte compressed point)
  nonceKeys.forEach(key => {
    validateHexString(value[key], `${fieldName}.${key}`, 33)
  })

  // Ensure nonce keys are sequential (r1, r2, r3, etc.)
  nonceKeys.sort((a, b) => {
    const numA = parseInt(a.substring(1))
    const numB = parseInt(b.substring(1))
    return numA - numB
  })

  for (let i = 0; i < nonceKeys.length; i++) {
    const expectedKey = `r${i + 1}`
    if (nonceKeys[i] !== expectedKey) {
      throw createValidationError(
        `Nonce keys must be sequential: expected ${expectedKey}, got ${nonceKeys[i]}`,
        ErrorCode.INVALID_PAYLOAD,
        fieldName,
      )
    }
  }
}

/**
 * Validate 32-byte hex string (for signature components)
 */
function validate32ByteHex(
  value: unknown,
  fieldName: string,
): asserts value is string {
  validateHexString(value, fieldName, 32)
}

/**
 * Validate final signature object
 */
function validateFinalSignature(
  value: unknown,
  fieldName: string,
): asserts value is { r: string; s: string } {
  validateObject(value, fieldName)
  const sigObj = value as Record<string, unknown>

  // Validate r and s components are hex strings
  validateField(sigObj, SIGNATURE_FIELDS.r, validate32ByteHex)
  validateField(sigObj, SIGNATURE_FIELDS.s, validate32ByteHex)
}

/**
 * Validate boolean input
 */
function validateBoolean(
  value: unknown,
  fieldName: string,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw createValidationError(
      `${fieldName} must be a boolean`,
      ErrorCode.INVALID_TYPE,
      fieldName,
    )
  }
}

/**
 * Validate object structure
 */
function validateObject(
  value: unknown,
  fieldName: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw createValidationError(
      `${fieldName} must be an object`,
      ErrorCode.INVALID_TYPE,
      fieldName,
    )
  }
}

/**
 * Validate required field exists
 */
function validateField(
  obj: Record<string, unknown>,
  fieldName: string,
  validator?: (value: unknown, fieldName: string) => void,
): void {
  if (!(fieldName in obj)) {
    throw createValidationError(
      `Missing required field: ${fieldName}`,
      ErrorCode.MISSING_FIELD,
      fieldName,
    )
  }

  if (validator) {
    try {
      validator(obj[fieldName], fieldName)
    } catch (error) {
      if (error instanceof ValidationError) {
        throw createValidationError(
          `Invalid field ${fieldName}: ${error.message}`,
          ErrorCode.INVALID_PAYLOAD,
          fieldName,
        )
      }
      throw error
    }
  }
}

// ============================================================================
// Message Payload Validators
// ============================================================================

/**
 * Validate session announcement payload (GossipSub messages)
 */
export function validateSessionAnnouncementPayload(
  payload: unknown,
): asserts payload is SessionAnnouncement {
  validateObject(payload, 'sessionAnnouncement')

  // Required fields for SessionAnnouncement
  validateField(payload, SESSION_FIELDS.sessionId, validateString)
  validateField(payload, SESSION_FIELDS.requiredSigners, validateNumber)
  validateField(payload, SESSION_FIELDS.coordinatorPeerId, validateString)
  validateField(payload, SESSION_FIELDS.messageHash, validateHexString)
  validateField(payload, SESSION_FIELDS.createdAt, validateTimestamp)
  validateField(payload, SESSION_FIELDS.expiresAt, validateTimestamp)

  // Optional fields
  if (SESSION_FIELDS.signers in payload) {
    validateField(payload, SESSION_FIELDS.signers, validateSignersArray)
  }

  if (SESSION_FIELDS.metadata in payload) {
    validateField(payload, SESSION_FIELDS.metadata, validateObject)
  }
}

/**
 * Validate session join payload (direct P2P messages)
 */
export function validateSessionJoinPayload(
  payload: unknown,
): asserts payload is SessionJoinPayload {
  validateObject(payload, 'sessionJoin')

  // Required fields
  validateField(payload, JOIN_FIELDS.sessionId, validateString)
  validateField(payload, JOIN_FIELDS.signerPublicKey, validateHexString)
  validateField(payload, JOIN_FIELDS.timestamp, validateTimestamp)
}

/**
 * Validate session join acknowledgment payload
 */
export function validateSessionJoinAckPayload(
  payload: unknown,
): asserts payload is SessionJoinAckPayload {
  validateObject(payload, 'sessionJoinAck')

  // Required fields
  validateField(payload, JOIN_ACK_FIELDS.sessionId, validateString)
  validateField(payload, JOIN_ACK_FIELDS.accepted, validateBoolean)
  validateField(payload, JOIN_ACK_FIELDS.timestamp, validateTimestamp)

  // If rejected, require reason
  const payloadObj = payload as unknown as SessionJoinAckPayload
  if (!payloadObj.accepted) {
    validateField(payload, JOIN_ACK_FIELDS.reason, validateString)
  }

  // Optional fields
  if (JOIN_ACK_FIELDS.signerIndex in payload) {
    validateField(payload, JOIN_ACK_FIELDS.signerIndex, validateNumber)
  }
}

/**
 * Validate nonce share payload (MuSig2 Round 1 - supports ν ≥ 2 nonces)
 */
export function validateNonceSharePayload(
  payload: unknown,
): asserts payload is NonceSharePayload {
  validateObject(payload, 'nonceShare')

  // Required fields
  validateField(payload, NONCE_FIELDS.sessionId, validateString)
  validateField(payload, NONCE_FIELDS.signerIndex, validateNumber)
  validateField(payload, NONCE_FIELDS.timestamp, validateTimestamp)

  // Validate public nonces - MuSig2 ν ≥ 2 compliance
  validateField(payload, NONCE_FIELDS.publicNonces, validatePublicNonces)
}

/**
 * Validate partial signature share payload (MuSig2 Round 2)
 */
export function validatePartialSigSharePayload(
  payload: unknown,
): asserts payload is PartialSigSharePayload {
  validateObject(payload, 'partialSigShare')

  // Required fields
  validateField(payload, SIG_FIELDS.sessionId, validateString)
  validateField(payload, SIG_FIELDS.signerIndex, validateNumber)
  validateField(payload, SIG_FIELDS.timestamp, validateTimestamp)
  validateField(payload, SIG_FIELDS.partialSig, validateHexString)

  // Partial signature should be 32 bytes (scalar)
  const payloadObj = payload as unknown as PartialSigSharePayload
  const sigBuffer = Buffer.from(payloadObj.partialSig, 'hex')
  if (sigBuffer.length !== 32) {
    throw createValidationError(
      'Partial signature must be 32 bytes',
      ErrorCode.INVALID_LENGTH,
      SIG_FIELDS.partialSig,
    )
  }
}

/**
 * Validate session abort payload
 */
export function validateSessionAbortPayload(
  payload: unknown,
): asserts payload is SessionAbortPayload {
  validateObject(payload, 'sessionAbort')

  // Required fields
  validateField(payload, ABORT_FIELDS.sessionId, validateString)
  validateField(payload, ABORT_FIELDS.reason, validateString)
  validateField(payload, ABORT_FIELDS.timestamp, validateTimestamp)
}

/**
 * Validate session complete payload
 */
export function validateSessionCompletePayload(
  payload: unknown,
): asserts payload is SessionCompletePayload {
  validateObject(payload, 'sessionComplete')

  // Required fields
  validateField(payload, COMPLETE_FIELDS.sessionId, validateString)
  validateField(payload, COMPLETE_FIELDS.timestamp, validateTimestamp)

  // Optional final signature
  if (COMPLETE_FIELDS.finalSignature in payload) {
    validateField(
      payload,
      COMPLETE_FIELDS.finalSignature,
      validateFinalSignature,
    )
  }
}

// ============================================================================
// Message Type Router
// ============================================================================

/**
 * Main message validation router - validates payload based on message type
 */
export function validateMessagePayload(
  messageType: string,
  payload: unknown,
): void {
  switch (messageType) {
    case 'sessionAnnouncement':
      validateSessionAnnouncementPayload(payload)
      break

    case 'sessionJoin':
      validateSessionJoinPayload(payload)
      break

    case 'sessionJoinAck':
      validateSessionJoinAckPayload(payload)
      break

    case 'nonceShare':
      validateNonceSharePayload(payload)
      break

    case 'partialSigShare':
      validatePartialSigSharePayload(payload)
      break

    case 'sessionAbort':
      validateSessionAbortPayload(payload)
      break

    case 'sessionComplete':
      validateSessionCompletePayload(payload)
      break

    default:
      throw createValidationError(
        `Unknown message type: ${messageType}`,
        ErrorCode.INVALID_MESSAGE_TYPE,
        'messageType',
      )
  }
}

// ============================================================================
// Security Validation Utilities
// ============================================================================

/**
 * Validate message size to prevent DoS attacks
 */
export function validateMessageSize(message: unknown, maxSize = 100_000): void {
  const messageStr = JSON.stringify(message)
  const size = Buffer.byteLength(messageStr, 'utf8')

  if (size > maxSize) {
    throw createValidationError(
      `Message too large: ${size} bytes > ${maxSize} bytes`,
      ErrorCode.SIZE_LIMIT_EXCEEDED,
      'message',
    )
  }
}

/**
 * Validate message structure for basic security
 */
export function validateMessageStructure(message: unknown): void {
  validateObject(message, 'message')

  const msg = message as Record<string, unknown>

  // Must have type and protocol fields
  validateField(msg, MESSAGE_FIELDS.type, validateString)
  validateField(msg, MESSAGE_FIELDS.protocol, validateString)
  validateField(msg, MESSAGE_FIELDS.payload, validateObject)

  // Validate payload size
  validateMessageSize(msg.payload)
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get validation info for debugging
 */
export function getValidationInfo(): {
  supportedMessageTypes: string[]
  maxMessageSize: number
  maxTimestampSkew: number
  nonceRequirements: { min: number; max: number }
} {
  return {
    supportedMessageTypes: [
      'sessionAnnouncement',
      'sessionJoin',
      'sessionJoinAck',
      'nonceShare',
      'partialSigShare',
      'sessionAbort',
      'sessionComplete',
    ],
    maxMessageSize: MAX_MESSAGE_SIZE,
    maxTimestampSkew: MAX_TIMESTAMP_SKEW,
    nonceRequirements: { min: 2, max: 10 }, // ν ≥ 2, reasonable upper limit
  }
}
