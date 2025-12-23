/**
 * MuSig2 Message Signing
 *
 * Provides cryptographic signing and verification for MuSig2 protocol messages
 * using Lotus Schnorr signatures.
 *
 * LOTUS-SPECIFIC IMPLEMENTATION:
 * - Uses 33-byte compressed public keys (not x-only like BIP340)
 * - Challenge hash: H(R.x || compressed(Q) || m)
 * - Big-endian signature encoding
 *
 * This module ensures all protocol messages are authenticated and cannot be
 * spoofed or tampered with.
 */

import type { P2PMessage } from '../types.js'
import { Hash } from 'xpi-ts/lib/bitcore/crypto/hash'
import { Schnorr } from 'xpi-ts/lib/bitcore/crypto/schnorr'
import { Signature } from 'xpi-ts/lib/bitcore/crypto/signature'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'

/**
 * Signed message with required signature fields
 * Uses Buffer for signature (matching P2PMessage.signature type)
 */
export interface SignedP2PMessage extends P2PMessage {
  /** Schnorr signature of the message (64 bytes) - required, not optional */
  signature: Buffer
  /** Public key of the signer (33 bytes compressed, hex-encoded) */
  signerPublicKey: string
}

/**
 * Message signing configuration
 */
export interface MessageSigningConfig {
  /** Whether to require signatures on all messages (default: true) */
  requireSignatures?: boolean
  /** Whether to include timestamp in signature data (default: true) */
  includeTimestamp?: boolean
  /** Maximum age of signed messages in milliseconds (default: 5 minutes) */
  maxMessageAge?: number
}

/**
 * Default message signing configuration
 */
export const DEFAULT_MESSAGE_SIGNING_CONFIG: Required<MessageSigningConfig> = {
  requireSignatures: true,
  includeTimestamp: true,
  maxMessageAge: 5 * 60 * 1000, // 5 minutes
}

/**
 * MuSig2 Message Signer
 *
 * Handles signing and verification of MuSig2 protocol messages using
 * Lotus Schnorr signatures.
 */
export class MuSig2MessageSigner {
  private readonly config: Required<MessageSigningConfig>

  constructor(config?: MessageSigningConfig) {
    this.config = {
      ...DEFAULT_MESSAGE_SIGNING_CONFIG,
      ...config,
    }
  }

  /**
   * Sign a MuSig2 protocol message using Lotus Schnorr
   *
   * @param message - The P2P message to sign
   * @param privateKey - The signer's private key
   * @returns Signed message with signature and public key attached
   */
  signMessage(message: P2PMessage, privateKey: PrivateKey): SignedP2PMessage {
    // Get the data to sign
    const signatureData = this.getSignatureData(message)

    // Hash the data
    const hash = Hash.sha256(signatureData)

    // Sign using Lotus Schnorr (big-endian)
    const signature = Schnorr.sign(hash, privateKey, 'big')

    // Serialize signature to Buffer (64 bytes = r + s)
    const sigBuffer = signature.toBuffer('schnorr')

    // Get compressed public key as hex
    const publicKey = privateKey.toPublicKey()
    const publicKeyHex = publicKey.toBuffer().toString('hex')

    return {
      ...message,
      signature: sigBuffer,
      signerPublicKey: publicKeyHex,
    }
  }

  /**
   * Verify message signature using Lotus Schnorr
   *
   * @param message - The signed message to verify
   * @param expectedPublicKey - Optional expected public key (if not provided, uses message's signerPublicKey)
   * @returns True if signature is valid, false otherwise
   */
  verifyMessage(
    message: SignedP2PMessage,
    expectedPublicKey?: PublicKey,
  ): boolean {
    // Check if signature exists
    if (!message.signature) {
      console.warn('[MessageSigning] Message has no signature')
      return false
    }

    // Get the public key to verify against
    let publicKey: PublicKey
    if (expectedPublicKey) {
      publicKey = expectedPublicKey
    } else if (message.signerPublicKey) {
      try {
        publicKey = PublicKey.fromString(message.signerPublicKey)
      } catch (error) {
        console.warn('[MessageSigning] Invalid signer public key in message')
        return false
      }
    } else {
      console.warn('[MessageSigning] No public key available for verification')
      return false
    }

    // Verify the public key matches if both are provided
    if (expectedPublicKey && message.signerPublicKey) {
      const messagePublicKey = PublicKey.fromString(message.signerPublicKey)
      if (
        expectedPublicKey.toBuffer().toString('hex') !==
        messagePublicKey.toBuffer().toString('hex')
      ) {
        console.warn('[MessageSigning] Public key mismatch')
        return false
      }
    }

    try {
      // Get the data that was signed (without signature fields)
      const signatureData = this.getSignatureData(message)

      // Hash the data
      const hash = Hash.sha256(signatureData)

      // Parse signature from Buffer
      const signature = Signature.fromBuffer(message.signature)
      signature.isSchnorr = true

      // Verify using Lotus Schnorr (big-endian)
      return Schnorr.verify(hash, signature, publicKey, 'big')
    } catch (error) {
      console.warn('[MessageSigning] Signature verification failed:', error)
      return false
    }
  }

  /**
   * Check if a message has a valid signature structure
   * (does not verify the signature, just checks presence)
   */
  hasSignature(message: P2PMessage): message is SignedP2PMessage {
    const signed = message as unknown as SignedP2PMessage
    return (
      Buffer.isBuffer(signed.signature) &&
      signed.signature.length === 64 && // 64 bytes for Schnorr signature
      typeof signed.signerPublicKey === 'string' &&
      (signed.signerPublicKey.length === 66 || // 33 bytes compressed = 66 hex chars
        signed.signerPublicKey.length === 130) // 65 bytes uncompressed = 130 hex chars
    )
  }

  /**
   * Strip signature from a signed message
   * Useful for re-signing or comparing message content
   */
  stripSignature(message: SignedP2PMessage): P2PMessage {
    const { signature: _sig, signerPublicKey: _pk, ...baseMessage } = message
    void _sig
    void _pk
    return baseMessage as P2PMessage
  }

  /**
   * Get the data to be signed for a message
   *
   * The signature covers:
   * - Message type
   * - Sender peer ID (from field)
   * - Message ID
   * - Payload (JSON stringified)
   * - Timestamp (if enabled)
   *
   * This ensures the entire message content is authenticated.
   */
  private getSignatureData(message: P2PMessage): Buffer {
    const parts: Buffer[] = []

    // Message type
    parts.push(Buffer.from(message.type || ''))

    // Sender peer ID
    parts.push(Buffer.from(message.from || ''))

    // Message ID
    parts.push(Buffer.from(message.messageId || ''))

    // Payload - serialize consistently
    if (message.payload !== undefined) {
      const payloadStr =
        typeof message.payload === 'string'
          ? message.payload
          : JSON.stringify(message.payload)
      parts.push(Buffer.from(payloadStr))
    }

    // Timestamp (if enabled and present)
    if (this.config.includeTimestamp && message.timestamp !== undefined) {
      parts.push(Buffer.from(message.timestamp.toString()))
    }

    return Buffer.concat(parts)
  }

  /**
   * Validate message age based on timestamp
   *
   * @param message - Message to validate
   * @returns True if message is within acceptable age, false if too old
   */
  validateMessageAge(message: P2PMessage): boolean {
    if (!message.timestamp) {
      return true // No timestamp to validate
    }

    const now = Date.now()
    const age = Math.abs(now - message.timestamp)

    return age <= this.config.maxMessageAge
  }

  /**
   * Get configuration
   */
  getConfig(): Required<MessageSigningConfig> {
    return { ...this.config }
  }
}

/**
 * Create a message signer with default configuration
 */
export function createMessageSigner(
  config?: MessageSigningConfig,
): MuSig2MessageSigner {
  return new MuSig2MessageSigner(config)
}
