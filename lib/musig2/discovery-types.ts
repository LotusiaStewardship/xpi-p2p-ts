/**
 * MuSig2 Discovery Types
 *
 * MuSig2-specific extensions for the P2P discovery layer
 */

import type { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import type {
  DiscoveryCriteria,
  DiscoveryAdvertisement,
} from '../discovery/types.js'
import type { TransactionType } from './types.js'

// ============================================================================
// MuSig2 Discovery Criteria
// ============================================================================

/**
 * Criteria for discovering MuSig2 signers
 */
export interface MuSig2SignerCriteria extends DiscoveryCriteria {
  protocol: 'musig2'

  /** Types of transactions signer can participate in */
  transactionTypes?: TransactionType[]

  /** Minimum amount willing to sign (satoshis) */
  minAmount?: number

  /** Maximum amount willing to sign (satoshis) */
  maxAmount?: number

  /** Required specific public keys (if known) */
  requiredPublicKeys?: string[]

  /** Minimum maturation period for burn-based identities (blocks) */
  minMaturation?: number

  /** Minimum total burned (satoshis, for burn-based identities) */
  minTotalBurned?: number
}

/**
 * Criteria for discovering MuSig2 signing requests
 */
export interface MuSig2SigningRequestCriteria extends DiscoveryCriteria {
  protocol: 'musig2-request'

  /** Filter by transaction type */
  transactionType?: TransactionType

  /** Filter by transaction amount range (satoshis) */
  amountRange?: {
    min?: number
    max?: number
  }

  /** Only find requests that include specific public keys */
  includesPublicKeys?: string[]

  /** Only find requests from specific creator peer IDs */
  creatorPeerIds?: string[]

  /** Filter by expiration (only return requests expiring after this timestamp) */
  expiresAfter?: number
}

// ============================================================================
// MuSig2 Discovery Advertisements
// ============================================================================

/**
 * MuSig2 signer advertisement
 * Announces signer availability and capabilities
 */
export interface MuSig2SignerAdvertisement extends DiscoveryAdvertisement {
  protocol: 'musig2'

  /** Signer's public key */
  publicKey: PublicKey

  /** Transaction types willing to sign */
  transactionTypes: TransactionType[]

  /** Amount range (satoshis) */
  amountRange?: {
    min?: number
    max?: number
  }

  /** Signer-specific metadata */
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
}

/**
 * MuSig2 signing request advertisement
 * Announces need for signatures from specific public keys
 */
export interface MuSig2SigningRequestAdvertisement
  extends DiscoveryAdvertisement {
  protocol: 'musig2-request'

  /** Unique request ID */
  requestId: string

  /** Required public keys (ALL must sign - MuSig2 is n-of-n) */
  requiredPublicKeys: string[]

  /** Message/transaction hash to sign */
  messageHash: string

  /** Creator peer ID */
  creatorPeerId: string

  /** Creator public key */
  creatorPublicKey: string

  /** Request-specific metadata */
  requestMetadata?: {
    /** Transaction hex (for context) */
    transactionHex?: string

    /** Transaction amount (satoshis) */
    amount?: number

    /** Transaction type */
    transactionType?: TransactionType

    /** Purpose description */
    purpose?: string

    /** Current participants (dynamically updated) */
    joinedParticipants?: Array<{
      index: number
      peerId: string
      publicKey: string
      joinedAt: number
    }>
  }

  /** Creator signature proving legitimacy */
  creatorSignature: Buffer
}

// ============================================================================
// Type Conversion Utilities
// ============================================================================

/**
 * Convert PublicKey to hex string
 */
export function publicKeyToHex(publicKey: PublicKey): string {
  return publicKey.toString()
}

/**
 * Convert hex string to PublicKey placeholder
 * (Actual implementation would need PublicKey.fromString)
 */
export function hexToPublicKey(hex: string): string {
  return hex
}

/**
 * Validate MuSig2 signer criteria
 */
export function isValidSignerCriteria(
  criteria: Partial<MuSig2SignerCriteria>,
): criteria is MuSig2SignerCriteria {
  return criteria.protocol === 'musig2'
}

/**
 * Validate MuSig2 signing request criteria
 */
export function isValidSigningRequestCriteria(
  criteria: Partial<MuSig2SigningRequestCriteria>,
): criteria is MuSig2SigningRequestCriteria {
  return criteria.protocol === 'musig2-request'
}

/**
 * Validate MuSig2 signer advertisement
 */
export function isValidSignerAdvertisement(
  ad: Partial<MuSig2SignerAdvertisement>,
): ad is MuSig2SignerAdvertisement {
  return (
    ad.protocol === 'musig2' &&
    typeof ad.id === 'string' &&
    ad.publicKey !== undefined &&
    Array.isArray(ad.transactionTypes)
  )
}

/**
 * Validate MuSig2 signing request advertisement
 */
export function isValidSigningRequestAdvertisement(
  ad: Partial<MuSig2SigningRequestAdvertisement>,
): ad is MuSig2SigningRequestAdvertisement {
  return (
    ad.protocol === 'musig2-request' &&
    typeof ad.requestId === 'string' &&
    Array.isArray(ad.requiredPublicKeys) &&
    ad.requiredPublicKeys.length > 0 &&
    typeof ad.messageHash === 'string' &&
    typeof ad.creatorPeerId === 'string'
  )
}

// ============================================================================
// MuSig2 Discovery Configuration
// ============================================================================

/**
 * MuSig2 discovery configuration
 */
export interface MuSig2DiscoveryConfig {
  /** DHT key prefix for signer advertisements */
  signerKeyPrefix?: string

  /** DHT key prefix for signing requests */
  requestKeyPrefix?: string

  /** Default signer advertisement TTL (milliseconds) */
  signerTTL?: number

  /** Default signing request TTL (milliseconds) */
  requestTTL?: number

  /** Enable burn-based identity validation */
  enableBurnValidation?: boolean

  /** Minimum burn amount for identity validation (satoshis) */
  minBurnAmount?: number

  /** Chronik API URL for burn validation */
  chronikUrl?: string | string[]

  /** Enable automatic signer refresh */
  enableAutoRefresh?: boolean

  /** Signer refresh interval (milliseconds) */
  signerRefreshInterval?: number

  /** Maximum concurrent signing requests to advertise */
  maxConcurrentRequests?: number
}

/**
 * Default MuSig2 discovery configuration
 */
export const DEFAULT_MUSIG2_DISCOVERY_CONFIG: Required<MuSig2DiscoveryConfig> =
  {
    signerKeyPrefix: 'musig2:signer:',
    requestKeyPrefix: 'musig2:request:',
    signerTTL: 30 * 60 * 1000, // 30 minutes
    requestTTL: 10 * 60 * 1000, // 10 minutes
    enableBurnValidation: false,
    minBurnAmount: 50_000_000, // 50 XPI
    chronikUrl: 'https://chronik.lotusia.org',
    enableAutoRefresh: true,
    signerRefreshInterval: 20 * 60 * 1000, // 20 minutes
    maxConcurrentRequests: 5,
  }
