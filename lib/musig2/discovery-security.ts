/**
 * MuSig2 Discovery Security
 *
 * MuSig2-specific security validation for discovery advertisements
 *
 * Uses @noble/hashes for browser compatibility
 */

import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import { DiscoverySecurityValidator } from '../discovery/security.js'
import type {
  SecurityValidationResult,
  SecurityPolicy,
  DiscoveryAdvertisement,
  DiscoveryCriteria,
} from '../discovery/types.js'
import type {
  MuSig2SignerAdvertisement,
  MuSig2SigningRequestAdvertisement,
} from './discovery-types.js'
import {
  isValidSignerAdvertisement,
  isValidSigningRequestAdvertisement,
  publicKeyToHex,
} from './discovery-types.js'

/**
 * MuSig2 discovery security validator
 * Extends base discovery security with MuSig2-specific validation
 */
export class MuSig2DiscoverySecurityValidator extends DiscoverySecurityValidator {
  /**
   * Validate MuSig2-specific advertisement
   */
  async validateAdvertisement(
    advertisement: DiscoveryAdvertisement,
    criteria?: DiscoveryCriteria,
  ): Promise<SecurityValidationResult> {
    const baseResult = await super.validateAdvertisement(
      advertisement,
      criteria,
    )

    if (!baseResult.valid) {
      return baseResult
    }

    if (advertisement.protocol === 'musig2') {
      return this.validateSignerAdvertisement(
        advertisement as MuSig2SignerAdvertisement,
      )
    } else if (advertisement.protocol === 'musig2-request') {
      return this.validateSigningRequestAdvertisement(
        advertisement as MuSig2SigningRequestAdvertisement,
      )
    }

    return baseResult
  }

  /**
   * Validate signer advertisement
   */
  private validateSignerAdvertisement(
    advertisement: MuSig2SignerAdvertisement,
  ): SecurityValidationResult {
    if (!isValidSignerAdvertisement(advertisement)) {
      return {
        valid: false,
        error: 'Invalid signer advertisement structure',
        securityScore: 0,
        details: {
          signatureValid: false,
          notExpired: true,
          reputationAcceptable: false,
          criteriaMatch: false,
          customValidation: false,
        },
      }
    }

    const details = {
      signatureValid: true,
      notExpired: true,
      reputationAcceptable: true,
      criteriaMatch: true,
      customValidation: true,
    }

    let securityScore = 100

    if (
      !advertisement.publicKey ||
      typeof advertisement.publicKey !== 'object'
    ) {
      details.customValidation = false
      securityScore -= 30
    }

    if (
      !Array.isArray(advertisement.transactionTypes) ||
      advertisement.transactionTypes.length === 0
    ) {
      details.customValidation = false
      securityScore -= 20
    }

    if (
      advertisement.amountRange &&
      advertisement.amountRange.min !== undefined &&
      advertisement.amountRange.max !== undefined &&
      advertisement.amountRange.min > advertisement.amountRange.max
    ) {
      details.customValidation = false
      securityScore -= 10
    }

    if (advertisement.signature && advertisement.signature.length > 0) {
      const isValid = this.verifySignerSignature(advertisement)
      if (!isValid) {
        details.signatureValid = false
        securityScore -= 40
      }
    }

    const minScore = 50
    const valid = securityScore >= minScore && details.customValidation

    return {
      valid,
      error: valid ? undefined : 'MuSig2 signer validation failed',
      securityScore,
      details,
    }
  }

  /**
   * Validate signing request advertisement
   */
  private validateSigningRequestAdvertisement(
    advertisement: MuSig2SigningRequestAdvertisement,
  ): SecurityValidationResult {
    if (!isValidSigningRequestAdvertisement(advertisement)) {
      return {
        valid: false,
        error: 'Invalid signing request advertisement structure',
        securityScore: 0,
        details: {
          signatureValid: false,
          notExpired: true,
          reputationAcceptable: false,
          criteriaMatch: false,
          customValidation: false,
        },
      }
    }

    const details = {
      signatureValid: true,
      notExpired: true,
      reputationAcceptable: true,
      criteriaMatch: true,
      customValidation: true,
    }

    let securityScore = 100

    if (
      !advertisement.requestId ||
      typeof advertisement.requestId !== 'string'
    ) {
      details.customValidation = false
      securityScore -= 20
    }

    if (
      !Array.isArray(advertisement.requiredPublicKeys) ||
      advertisement.requiredPublicKeys.length === 0
    ) {
      details.customValidation = false
      securityScore -= 30
    }

    if (
      !advertisement.messageHash ||
      typeof advertisement.messageHash !== 'string'
    ) {
      details.customValidation = false
      securityScore -= 30
    }

    if (
      !advertisement.creatorPeerId ||
      typeof advertisement.creatorPeerId !== 'string'
    ) {
      details.customValidation = false
      securityScore -= 10
    }

    if (
      advertisement.creatorSignature &&
      advertisement.creatorSignature.length > 0
    ) {
      const isValid = this.verifyRequestSignature(advertisement)
      if (!isValid) {
        details.signatureValid = false
        securityScore -= 40
      }
    }

    const minScore = 50
    const valid = securityScore >= minScore && details.customValidation

    return {
      valid,
      error: valid ? undefined : 'MuSig2 signing request validation failed',
      securityScore,
      details,
    }
  }

  /**
   * Verify signer advertisement signature
   */
  private verifySignerSignature(
    advertisement: MuSig2SignerAdvertisement,
  ): boolean {
    if (!advertisement.signature || advertisement.signature.length === 0) {
      return true
    }

    try {
      const publicKeyHex = publicKeyToHex(advertisement.publicKey)

      const message = this.constructSignerMessage(
        advertisement.id,
        publicKeyHex,
        advertisement.transactionTypes,
        advertisement.createdAt,
      )

      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Verify signing request signature
   */
  private verifyRequestSignature(
    advertisement: MuSig2SigningRequestAdvertisement,
  ): boolean {
    if (
      !advertisement.creatorSignature ||
      advertisement.creatorSignature.length === 0
    ) {
      return true
    }

    try {
      const message = this.constructRequestMessage(
        advertisement.requestId,
        advertisement.requiredPublicKeys,
        advertisement.messageHash,
        advertisement.createdAt,
      )

      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Construct canonical message for signer signature
   */
  private constructSignerMessage(
    id: string,
    publicKeyHex: string,
    transactionTypes: string[],
    timestamp: number,
  ): string {
    const data = `musig2-signer${id}${publicKeyHex}${transactionTypes.sort().join(',')}${timestamp.toString()}`
    return bytesToHex(sha256(new TextEncoder().encode(data)))
  }

  /**
   * Construct canonical message for request signature
   */
  private constructRequestMessage(
    requestId: string,
    requiredPublicKeys: string[],
    messageHash: string,
    timestamp: number,
  ): string {
    const data = `musig2-request${requestId}${requiredPublicKeys.sort().join(',')}${messageHash}${timestamp.toString()}`
    return bytesToHex(sha256(new TextEncoder().encode(data)))
  }

  /**
   * Validate burn-based identity (if applicable)
   */
  async validateBurnIdentity(
    advertisement: MuSig2SignerAdvertisement,
    minBurnAmount: number,
    minMaturationBlocks: number,
  ): Promise<boolean> {
    const identity = advertisement.signerMetadata?.identity
    if (!identity) {
      return false
    }

    if (identity.totalBurned < minBurnAmount) {
      return false
    }

    if (identity.maturationBlocks < minMaturationBlocks) {
      return false
    }

    return true
  }

  /**
   * Check if public key is in required signers list
   */
  validateRequiredSigner(
    publicKey: PublicKey | string,
    requiredPublicKeys: string[],
  ): boolean {
    const publicKeyHex =
      typeof publicKey === 'string' ? publicKey : publicKeyToHex(publicKey)
    return requiredPublicKeys.includes(publicKeyHex)
  }

  /**
   * Validate transaction type support
   */
  validateTransactionTypeSupport(
    advertisement: MuSig2SignerAdvertisement,
    requiredType: string,
  ): boolean {
    return advertisement.transactionTypes.some(type => type === requiredType)
  }

  /**
   * Validate amount range compatibility
   */
  validateAmountRange(
    advertisement: MuSig2SignerAdvertisement,
    requiredAmount: number,
  ): boolean {
    if (!advertisement.amountRange) {
      return true
    }

    const { min, max } = advertisement.amountRange

    if (min !== undefined && requiredAmount < min) {
      return false
    }

    if (max !== undefined && requiredAmount > max) {
      return false
    }

    return true
  }
}

/**
 * Create MuSig2 security policy
 */
export function createMuSig2SecurityPolicy(
  options?: Partial<SecurityPolicy>,
): SecurityPolicy {
  return {
    minReputation: options?.minReputation ?? 50,
    maxAdvertisementAge: options?.maxAdvertisementAge ?? 30 * 60 * 1000,
    enableSignatureVerification: options?.enableSignatureVerification ?? true,
    enableReplayPrevention: options?.enableReplayPrevention ?? true,
    enableRateLimiting: options?.enableRateLimiting ?? true,
    rateLimits: {
      maxAdvertisementsPerPeer:
        options?.rateLimits?.maxAdvertisementsPerPeer ?? 5,
      maxDiscoveryQueriesPerPeer:
        options?.rateLimits?.maxDiscoveryQueriesPerPeer ?? 20,
      windowSizeMs: options?.rateLimits?.windowSizeMs ?? 60 * 1000,
    },
    customValidators: options?.customValidators ?? [],
  }
}
