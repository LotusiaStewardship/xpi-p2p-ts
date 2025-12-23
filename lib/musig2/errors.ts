/**
 * Copyright 2025 The Lotusia Stewardship
 * Github: https://github.com/LotusiaStewardship
 * License: MIT
 */

/**
 * MuSig2 P2P Error Classes
 *
 * Custom error types for distinguishing between different failure modes
 * Provides structured error handling for validation, deserialization, and protocol issues
 */

/**
 * Base class for all MuSig2 P2P errors
 */
export class MuSig2P2PError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MuSig2P2PError'
  }
}

/**
 * Deserialization errors - indicates malformed data from peer
 * These should trigger peer reputation penalties
 */
export class DeserializationError extends MuSig2P2PError {
  constructor(
    message: string,
    public readonly fieldName: string,
    public readonly receivedValue?: unknown,
  ) {
    super(`Deserialization failed for ${fieldName}: ${message}`)
    this.name = 'DeserializationError'
  }
}

/**
 * Validation errors - indicates data that's well-formed but invalid
 * These should also trigger peer reputation penalties
 */
export class ValidationError extends MuSig2P2PError {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(`Validation failed: ${message}`)
    this.name = 'ValidationError'
  }
}

/**
 * Protocol errors - indicates incorrect protocol usage
 */
export class ProtocolError extends MuSig2P2PError {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/**
 * Security errors - indicates security violations or attacks
 */
export class SecurityError extends MuSig2P2PError {
  constructor(
    message: string,
    public readonly violationType: string,
    public readonly peerId?: string,
  ) {
    super(`Security violation: ${message}`)
    this.name = 'SecurityError'
  }
}

/**
 * Serialization errors - indicates issues during object serialization
 */
export class SerializationError extends MuSig2P2PError {
  constructor(
    message: string,
    public readonly objectType: string,
    public readonly reason?: string,
  ) {
    super(`Serialization failed for ${objectType}: ${message}`)
    this.name = 'SerializationError'
  }
}

/**
 * Error codes for machine handling and categorization
 */
export enum ErrorCode {
  // Validation errors
  INVALID_PAYLOAD = 'VAL001',
  MISSING_FIELD = 'VAL002',
  INVALID_TYPE = 'VAL003',
  INVALID_FORMAT = 'VAL004',
  SIZE_LIMIT_EXCEEDED = 'VAL005',
  TIMESTAMP_SKEW = 'VAL006',

  // Deserialization errors
  MALFORMED_DATA = 'DES001',
  INVALID_HEX = 'DES002',
  INVALID_LENGTH = 'DES003',
  INVALID_PREFIX = 'DES004',
  BUFFER_ERROR = 'DES005',

  // Serialization errors
  SERIALIZATION_FAILED = 'SER001',
  INVALID_OBJECT = 'SER002',
  ENCODING_ERROR = 'SER003',

  // Protocol errors
  INVALID_MESSAGE_TYPE = 'PROT001',
  INVALID_PHASE = 'PROT002',
  INVALID_STATE = 'PROT003',
  PROTOCOL_VIOLATION = 'PROT004',

  // Security errors
  RATE_LIMIT_EXCEEDED = 'SEC001',
  REPLAY_ATTACK = 'SEC002',
  NONCE_REUSE = 'SEC003',
  MALICIOUS_PEER = 'SEC004',
  DOS_ATTEMPT = 'SEC005',
}

/**
 * Helper function to create validation errors with codes
 */
export function createValidationError(
  message: string,
  code: ErrorCode,
  fieldName?: string,
): ValidationError {
  const error = new ValidationError(message, code)
  if (fieldName) {
    ;(error as ValidationError & { fieldName: string }).fieldName = fieldName
  }
  return error
}

/**
 * Helper function to create deserialization errors with codes
 */
export function createDeserializationError(
  message: string,
  code: ErrorCode,
  fieldName: string,
  receivedValue?: unknown,
): DeserializationError {
  const error = new DeserializationError(message, fieldName, receivedValue)
  ;(error as DeserializationError & { code: ErrorCode }).code = code
  return error
}

/**
 * Helper function to create security errors with codes
 */
export function createSecurityError(
  message: string,
  code: ErrorCode,
  violationType: string,
  peerId?: string,
): SecurityError {
  const error = new SecurityError(message, violationType, peerId)
  ;(error as SecurityError & { code: ErrorCode }).code = code
  return error
}
