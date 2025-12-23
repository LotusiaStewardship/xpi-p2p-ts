/**
 * MuSig2 P2P Coordination Module
 *
 * Exports all components for MuSig2 multi-signature coordination over P2P networks
 */

export { MuSig2P2PCoordinator } from './coordinator.js'
export { MuSig2ProtocolHandler } from './protocol.js'
export { MuSig2SecurityValidator, DEFAULT_MUSIG2_SECURITY } from './security.js'
export type { MuSig2SecurityConfig } from './security.js'
export * from './types.js'

// Event types for strongly-typed event handling
export * from './events.js'

// Serialization Layer
export {
  serializePoint,
  deserializePoint,
  serializePublicNonces,
  deserializePublicNonces,
  serializeBN,
  deserializeBN,
  serializePublicKey,
  deserializePublicKey,
  serializePublicKeys,
  deserializePublicKeys,
  serializeMessage,
  deserializeMessage,
  serializeSignature,
  deserializeSignature,
  validateHexString,
  getSerializationInfo,
  type SerializedSignature,
} from './serialization.js'

// Validation Layer
export {
  validateMessageStructure,
  validateSessionJoinPayload,
  validateSessionJoinAckPayload,
  validateNonceSharePayload,
  validatePartialSigSharePayload,
  validateSessionAbortPayload,
  validateSessionCompletePayload,
  validateSessionAnnouncementPayload,
} from './validation.js'

// Error Classes
export {
  MuSig2P2PError,
  ValidationError,
  DeserializationError,
  SerializationError,
  SecurityError,
  ProtocolError,
  ErrorCode,
  createValidationError,
  createDeserializationError,
  createSecurityError,
} from './errors.js'

// Coordinator Election
export {
  electCoordinator,
  verifyElectionResult,
  isCoordinator,
  getCoordinatorPublicKey,
  getBackupCoordinator,
  getCoordinatorPriorityList,
  ElectionMethod,
  type ElectionResult,
} from './election.js'

// Discovery System
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
export type {
  MuSig2SignerCriteria,
  MuSig2SigningRequestCriteria,
  MuSig2SignerAdvertisement,
  MuSig2SigningRequestAdvertisement,
  MuSig2DiscoveryConfig,
} from './discovery-types.js'

// Discovery Cache Interface (for external cache implementations)
export type {
  IDiscoveryCache,
  DiscoveryCacheEntry,
} from '../discovery/types.js'

// Session Lifecycle (Phase 3)
export { SessionLock, withSessionLock } from './session-lock.js'
export {
  SessionPersistence,
  InMemorySessionStorage,
  SessionRecoveryMessageType,
  type SerializedSession,
  type SerializedParticipant,
  type SessionStorage,
  type SessionRecoveryRequest,
  type SessionRecoveryResponse,
} from './session-persistence.js'
