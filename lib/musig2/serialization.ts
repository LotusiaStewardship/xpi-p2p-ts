/**
 * Copyright 2025 The Lotusia Stewardship
 * Github: https://github.com/LotusiaStewardship
 * License: MIT
 */

/**
 * MuSig2 P2P Serialization Utilities
 *
 * Converts MuSig2 objects (Point, BN, PublicKey) to/from network-safe formats
 * Supports MuSig2 specification with ν ≥ 2 nonces
 */

import { Point } from 'xpi-ts/lib/bitcore/crypto/point'
import { BN } from 'xpi-ts/lib/bitcore/crypto/bn'
import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import {
  DeserializationError,
  SerializationError,
  ErrorCode,
} from './errors.js'

// ============================================================================
// Point Serialization (33-byte compressed format)
// ============================================================================

/**
 * Serialize a Point to compressed format (hex string)
 */
export function serializePoint(point: Point): string {
  try {
    const compressed = Point.pointToCompressed(point)
    return compressed.toString('hex')
  } catch (error) {
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'Point',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize a compressed Point from hex string
 * @throws {DeserializationError} If the input is malformed
 */
export function deserializePoint(hex: string): Point {
  try {
    // Validate hex string format
    if (typeof hex !== 'string') {
      throw new DeserializationError(
        'Input must be a string',
        'point',
        typeof hex,
      )
    }

    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new DeserializationError(
        'Invalid hex string format',
        'point',
        hex.substring(0, 20),
      )
    }

    const buffer = Buffer.from(hex, 'hex')
    if (buffer.length !== 33) {
      throw new DeserializationError(
        `Expected 33 bytes, got ${buffer.length}`,
        'point',
        buffer.length,
      )
    }

    const prefix = buffer[0]
    if (prefix !== 0x02 && prefix !== 0x03) {
      throw new DeserializationError(
        `Invalid prefix: expected 0x02 or 0x03, got 0x${prefix.toString(16)}`,
        'point',
        prefix,
      )
    }

    const odd = prefix === 0x03
    const x = new BN(buffer.slice(1), 'be')
    return Point.fromX(odd, x)
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    // Wrap unexpected errors
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'point',
      hex?.substring(0, 20),
    )
  }
}

// ============================================================================
// Multi-Nonce Serialization (MuSig2 ν ≥ 2 support)
// ============================================================================

/**
 * Serialize multiple public nonces to network format
 * Supports MuSig2 specification with ν ≥ 2 nonces
 */
export function serializePublicNonces(nonces: Point[]): {
  [key: string]: string
} {
  try {
    if (!Array.isArray(nonces)) {
      throw new SerializationError(
        'Nonces must be an array',
        'Point[]',
        'Invalid input type',
      )
    }

    if (nonces.length < 2) {
      throw new SerializationError(
        'MuSig2 requires at least 2 nonces (ν ≥ 2)',
        'Point[]',
        'Insufficient nonce count',
      )
    }

    const nonceMap: { [key: string]: string } = {}

    // Serialize each nonce with r1, r2, r3, r4... naming
    nonces.forEach((nonce, index) => {
      if (!(nonce instanceof Point)) {
        throw new SerializationError(
          `Invalid nonce at index ${index}: expected Point`,
          'Point',
          'Invalid object type',
        )
      }
      nonceMap[`r${index + 1}`] = serializePoint(nonce)
    })

    return nonceMap
  } catch (error) {
    if (error instanceof SerializationError) {
      throw error
    }
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'Point[]',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize multiple public nonces from network format
 * Supports MuSig2 specification with ν ≥ 2 nonces
 */
export function deserializePublicNonces(nonceMap: {
  [key: string]: string
}): Point[] {
  try {
    if (!nonceMap || typeof nonceMap !== 'object') {
      throw new DeserializationError(
        'Input must be an object',
        'publicNonces',
        typeof nonceMap,
      )
    }

    // Extract nonce keys and sort them to ensure order
    const nonceKeys = Object.keys(nonceMap)
      .filter(key => /^r\d+$/.test(key)) // Match r1, r2, r3, etc.
      .sort((a, b) => {
        const numA = parseInt(a.substring(1))
        const numB = parseInt(b.substring(1))
        return numA - numB
      })

    if (nonceKeys.length < 2) {
      throw new DeserializationError(
        'MuSig2 requires at least 2 nonces (ν ≥ 2)',
        'publicNonces',
        nonceKeys.length,
      )
    }

    const nonces: Point[] = []

    for (const key of nonceKeys) {
      const hexValue = nonceMap[key]
      if (!hexValue || typeof hexValue !== 'string') {
        throw new DeserializationError(
          `Missing or invalid nonce for key: ${key}`,
          ErrorCode.MALFORMED_DATA,
          'publicNonces',
        )
      }

      try {
        const point = deserializePoint(hexValue)
        nonces.push(point)
      } catch (error) {
        throw new DeserializationError(
          `Failed to deserialize nonce ${key}: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.MALFORMED_DATA,
          'publicNonces',
        )
      }
    }

    return nonces
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'publicNonces',
    )
  }
}

// ============================================================================
// BN Serialization (32-byte big-endian)
// ============================================================================

/**
 * Serialize a BN to hex string (32 bytes, big-endian)
 */
export function serializeBN(bn: BN): string {
  try {
    if (!(bn instanceof BN)) {
      throw new SerializationError(
        'Input must be a BN instance',
        'BN',
        'Invalid object type',
      )
    }

    return bn.toBuffer({ endian: 'big', size: 32 }).toString('hex')
  } catch (error) {
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'BN',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize a BN from hex string
 * @throws {DeserializationError} If the input is malformed
 */
export function deserializeBN(hex: string): BN {
  try {
    // Validate hex string format
    if (typeof hex !== 'string') {
      throw new DeserializationError('Input must be a string', 'bn', typeof hex)
    }

    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new DeserializationError(
        'Invalid hex string format',
        'bn',
        hex.substring(0, 20),
      )
    }

    const buffer = Buffer.from(hex, 'hex')
    return new BN(buffer, 'be')
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    // Wrap unexpected errors
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'bn',
      hex?.substring(0, 20),
    )
  }
}

// ============================================================================
// PublicKey Serialization (compressed format for network efficiency)
// ============================================================================

/**
 * Serialize a PublicKey to compressed format (hex string)
 */
export function serializePublicKey(publicKey: PublicKey): string {
  try {
    if (!(publicKey instanceof PublicKey)) {
      throw new SerializationError(
        'Input must be a PublicKey instance',
        'PublicKey',
        'Invalid object type',
      )
    }

    return publicKey.toBuffer().toString('hex')
  } catch (error) {
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'PublicKey',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize a PublicKey from compressed format
 * @throws {DeserializationError} If the input is malformed
 */
export function deserializePublicKey(hex: string): PublicKey {
  try {
    // Validate hex string format
    if (typeof hex !== 'string') {
      throw new DeserializationError(
        'Input must be a string',
        'publicKey',
        typeof hex,
      )
    }

    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new DeserializationError(
        'Invalid hex string format',
        'publicKey',
        hex.substring(0, 20),
      )
    }

    const buffer = Buffer.from(hex, 'hex')

    // PublicKey should be 33 bytes (compressed) or 65 bytes (uncompressed)
    if (buffer.length !== 33 && buffer.length !== 65) {
      throw new DeserializationError(
        `Invalid public key length: expected 33 or 65 bytes, got ${buffer.length}`,
        'publicKey',
        buffer.length,
      )
    }

    return new PublicKey(buffer)
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    // Wrap unexpected errors (e.g., from PublicKey constructor)
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'publicKey',
      hex?.substring(0, 20),
    )
  }
}

// ============================================================================
// Message Buffer Serialization
// ============================================================================

/**
 * Serialize a message Buffer to hex string
 */
export function serializeMessage(message: Buffer): string {
  try {
    if (!Buffer.isBuffer(message)) {
      throw new SerializationError(
        'Input must be a Buffer',
        'Buffer',
        'Invalid object type',
      )
    }

    return message.toString('hex')
  } catch (error) {
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'Buffer',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize a message from hex string
 * @throws {DeserializationError} If the input is malformed
 */
export function deserializeMessage(hex: string): Buffer {
  try {
    // Validate hex string format
    if (typeof hex !== 'string') {
      throw new DeserializationError(
        'Input must be a string',
        'message',
        typeof hex,
      )
    }

    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      throw new DeserializationError(
        'Invalid hex string format',
        'message',
        hex.substring(0, 20),
      )
    }

    return Buffer.from(hex, 'hex')
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    // Wrap unexpected errors
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'message',
      hex?.substring(0, 20),
    )
  }
}

// ============================================================================
// Signature Serialization (64-byte: 32-byte r + 32-byte s)
// ============================================================================

/**
 * Serialized signature format for network transmission
 */
export interface SerializedSignature {
  r: string // 32-byte hex
  s: string // 32-byte hex
}

/**
 * Serialize a signature buffer to r,s components
 */
export function serializeSignature(signature: Buffer): SerializedSignature {
  try {
    if (!Buffer.isBuffer(signature)) {
      throw new SerializationError(
        'Input must be a Buffer',
        'Signature',
        'Invalid object type',
      )
    }

    if (signature.length !== 64) {
      throw new SerializationError(
        `Expected 64-byte signature, got ${signature.length} bytes`,
        'Signature',
        'Invalid length',
      )
    }

    return {
      r: signature.subarray(0, 32).toString('hex'),
      s: signature.subarray(32, 64).toString('hex'),
    }
  } catch (error) {
    if (error instanceof SerializationError) {
      throw error
    }
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'Signature',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize signature from r,s components
 * @throws {DeserializationError} If the input is malformed
 */
export function deserializeSignature(sig: SerializedSignature): Buffer {
  try {
    if (!sig || typeof sig !== 'object') {
      throw new DeserializationError(
        'Input must be an object with r and s properties',
        'signature',
        typeof sig,
      )
    }

    if (typeof sig.r !== 'string' || typeof sig.s !== 'string') {
      throw new DeserializationError(
        'Signature r and s must be strings',
        'signature',
        { r: typeof sig.r, s: typeof sig.s },
      )
    }

    if (!/^[0-9a-fA-F]+$/.test(sig.r) || !/^[0-9a-fA-F]+$/.test(sig.s)) {
      throw new DeserializationError(
        'Invalid hex string format in signature',
        'signature',
        { r: sig.r.substring(0, 10), s: sig.s.substring(0, 10) },
      )
    }

    const rBuffer = Buffer.from(sig.r, 'hex')
    const sBuffer = Buffer.from(sig.s, 'hex')

    if (rBuffer.length !== 32 || sBuffer.length !== 32) {
      throw new DeserializationError(
        `Invalid signature component length: r=${rBuffer.length}, s=${sBuffer.length}`,
        'signature',
        { rLen: rBuffer.length, sLen: sBuffer.length },
      )
    }

    return Buffer.concat([rBuffer, sBuffer])
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'signature',
    )
  }
}

// ============================================================================
// PublicKey Array Serialization (for signers list)
// ============================================================================

/**
 * Serialize an array of PublicKeys to hex strings
 */
export function serializePublicKeys(publicKeys: PublicKey[]): string[] {
  try {
    if (!Array.isArray(publicKeys)) {
      throw new SerializationError(
        'Input must be an array',
        'PublicKey[]',
        'Invalid input type',
      )
    }

    return publicKeys.map((pk, index) => {
      if (!(pk instanceof PublicKey)) {
        throw new SerializationError(
          `Invalid public key at index ${index}: expected PublicKey`,
          'PublicKey',
          'Invalid object type',
        )
      }
      return serializePublicKey(pk)
    })
  } catch (error) {
    if (error instanceof SerializationError) {
      throw error
    }
    throw new SerializationError(
      error instanceof Error ? error.message : String(error),
      'PublicKey[]',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}

/**
 * Deserialize an array of hex strings to PublicKeys
 * @throws {DeserializationError} If any input is malformed
 */
export function deserializePublicKeys(hexStrings: string[]): PublicKey[] {
  try {
    if (!Array.isArray(hexStrings)) {
      throw new DeserializationError(
        'Input must be an array',
        'publicKeys',
        typeof hexStrings,
      )
    }

    return hexStrings.map((hex, index) => {
      try {
        return deserializePublicKey(hex)
      } catch (error) {
        throw new DeserializationError(
          `Failed to deserialize public key at index ${index}: ${error instanceof Error ? error.message : String(error)}`,
          'publicKeys',
          hex?.substring(0, 20),
        )
      }
    })
  } catch (error) {
    if (error instanceof DeserializationError) {
      throw error
    }
    throw new DeserializationError(
      error instanceof Error ? error.message : String(error),
      'publicKeys',
    )
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Validate hex string format
 */
export function validateHexString(
  hex: string,
  expectedLength?: number,
): boolean {
  if (typeof hex !== 'string') {
    return false
  }

  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    return false
  }

  if (expectedLength !== undefined) {
    const buffer = Buffer.from(hex, 'hex')
    return buffer.length === expectedLength
  }

  return true
}

/**
 * Get the serialization format info for debugging
 */
export function getSerializationInfo(): {
  pointFormat: string
  bnFormat: string
  publicKeyFormat: string
  supportedNonceCount: { min: number; max: number }
} {
  return {
    pointFormat: '33-byte compressed hex',
    bnFormat: '32-byte big-endian hex',
    publicKeyFormat: '33-byte compressed or 65-byte uncompressed hex',
    supportedNonceCount: { min: 2, max: 10 }, // ν ≥ 2, reasonable upper limit
  }
}
