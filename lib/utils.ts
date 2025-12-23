/**
 * P2P Utilities
 */

import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id'
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { PrivateKey as Libp2pPrivateKey } from '@libp2p/interface'
import { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'

/**
 * Create libp2p PeerId from Lotus PrivateKey
 *
 * Note: This creates a random PeerId for now.
 * In production, you may want deterministic PeerId generation from private key
 */
export async function createPeerIdFromPrivateKey(privateKey: PrivateKey) {
  // For now, create random Ed25519 PeerId
  // TODO: Implement deterministic derivation from private key if needed
  const keyPair = await generateKeyPair('Ed25519')
  return peerIdFromPrivateKey(keyPair)
}

/**
 * Create random PeerId
 */
export async function createRandomPeerId() {
  const keyPair = await generateKeyPair('Ed25519')
  return peerIdFromPrivateKey(keyPair)
}

/**
 * Parse PeerId from string
 */
export function parsePeerId(peerIdStr: string) {
  return peerIdFromString(peerIdStr)
}

/**
 * Serialize PeerId to string
 */
export function serializePeerId(peerId: PeerId): string {
  return peerId.toString()
}

/**
 * Convert multiaddr string to array
 */
export function parseMultiaddrs(addrs: string | string[]): string[] {
  if (typeof addrs === 'string') {
    return [addrs]
  }
  return addrs
}

/**
 * Wait for an event to fire on an EventEmitter
 * Useful for async coordination in protocols
 *
 * Supports both regular EventEmitters and strongly-typed event emitters.
 *
 * Note: Uses `any` types to support both string-based and strongly-typed
 * event emitters. TypeScript's type system doesn't allow a fully type-safe
 * implementation that works with both patterns without this compromise.
 */
export function waitForEvent<T = unknown>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter: { once: (event: any, listener: any) => void },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
  timeoutMs?: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined = undefined
    // ONLY set a timeout if argument provided
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${String(event)}`))
      }, timeoutMs)
    }
    emitter.once(event, (data: T) => {
      clearTimeout(timeout)
      resolve(data)
    })
  })
}

// ============================================================================
// P2P Identity Management
// ============================================================================

/**
 * Generate a new Ed25519 private key for P2P identity
 * This creates a random keypair suitable for libp2p peer identity
 */
export async function generateP2PPrivateKey(): Promise<Libp2pPrivateKey> {
  return generateKeyPair('Ed25519')
}

/**
 * Restore a P2P private key from raw bytes
 * Use this to restore a previously saved identity
 *
 * @param rawBytes - The raw private key bytes (typically 32 bytes for Ed25519)
 */
export function restoreP2PPrivateKey(rawBytes: Uint8Array): Libp2pPrivateKey {
  return privateKeyFromRaw(rawBytes)
}

/**
 * Get the raw bytes from a P2P private key for storage
 * Use this to save the identity for later restoration
 *
 * @param privateKey - The libp2p private key
 * @returns Raw bytes that can be stored and later restored
 */
export function getP2PPrivateKeyBytes(
  privateKey: Libp2pPrivateKey,
): Uint8Array {
  return privateKey.raw
}
