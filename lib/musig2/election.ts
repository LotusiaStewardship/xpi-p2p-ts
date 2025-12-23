/**
 * Copyright 2025 The Lotusia Stewardship
 * Github: https://github.com/LotusiaStewardship
 * License: MIT
 */

/**
 * MuSig2 Coordinator Election
 *
 * Implements deterministic coordinator election for MuSig2 multi-party signing sessions.
 * The coordinator is responsible for:
 * - Collecting all partial signatures
 * - Constructing the final aggregated signature
 * - Building and broadcasting the transaction
 *
 * Election is deterministic and verifiable by all participants:
 * - Based on lexicographic ordering of public keys
 * - No communication needed
 * - Resistant to manipulation (requires control of private key)
 * - Consistent across all participants
 */

import { PublicKey } from 'xpi-ts/lib/bitcore/publickey'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * Election result containing coordinator information
 */
export interface ElectionResult {
  /** Index of the elected coordinator in the SORTED signers array (matches musigKeyAgg order) */
  coordinatorIndex: number
  /** Public key of the elected coordinator */
  coordinatorPublicKey: PublicKey
  /** All signers sorted lexicographically by their public keys (matches musigKeyAgg sorting) */
  sortedSigners: PublicKey[]
  /** Mapping from original index to sorted index */
  indexMapping: Map<number, number>
  /** Election proof (hash of sorted public keys) */
  electionProof: string
}

/**
 * Election method type
 */
export enum ElectionMethod {
  /** Lexicographic ordering of public keys (default) */
  LEXICOGRAPHIC = 'lexicographic',
  /** Hash-based selection (deterministic random) */
  HASH_BASED = 'hash-based',
  /** First signer in original order */
  FIRST_SIGNER = 'first-signer',
  /** Last signer in original order */
  LAST_SIGNER = 'last-signer',
}

/**
 * Elect a coordinator from a list of signers
 *
 * Uses deterministic election based on public key ordering.
 * This ensures all participants agree on the same coordinator
 * without requiring additional communication.
 *
 * @param signers - All participating signers' public keys
 * @param method - Election method (default: LEXICOGRAPHIC)
 * @returns Election result with coordinator information
 *
 * @example
 * ```typescript
 * const signers = [alice.publicKey, bob.publicKey, charlie.publicKey]
 * const election = electCoordinator(signers)
 * console.log('Coordinator:', election.coordinatorPublicKey.toString())
 * console.log('Coordinator index:', election.coordinatorIndex)
 * ```
 */
export function electCoordinator(
  signers: PublicKey[],
  method: ElectionMethod = ElectionMethod.LEXICOGRAPHIC,
): ElectionResult {
  if (signers.length === 0) {
    throw new Error('Cannot elect coordinator: no signers provided')
  }

  if (signers.length === 1) {
    return {
      coordinatorIndex: 0,
      coordinatorPublicKey: signers[0],
      sortedSigners: [signers[0]],
      indexMapping: new Map([[0, 0]]),
      electionProof: computeElectionProof(signers),
    }
  }

  switch (method) {
    case ElectionMethod.LEXICOGRAPHIC:
      return electByLexicographic(signers)
    case ElectionMethod.HASH_BASED:
      return electByHash(signers)
    case ElectionMethod.FIRST_SIGNER:
      return electFirstSigner(signers)
    case ElectionMethod.LAST_SIGNER:
      return electLastSigner(signers)
    default:
      throw new Error(`Unknown election method: ${method}`)
  }
}

/**
 * Elect coordinator by lexicographic ordering of public keys
 *
 * This is the recommended method as it:
 * - Is deterministic and verifiable
 * - Cannot be manipulated without controlling a specific private key
 * - Is consistent across all participants
 * - Requires no additional communication
 *
 * NOTE: Returns coordinator index in SORTED order (matching musigKeyAgg behavior)
 * Uses binary buffer comparison to match musigKeyAgg sorting exactly
 */
function electByLexicographic(signers: PublicKey[]): ElectionResult {
  // Create array of [original index, public key, buffer] for sorting
  const indexed = signers.map((pk, idx) => ({
    originalIndex: idx,
    publicKey: pk,
    buffer: pk.toBuffer(),
  }))

  // Sort by binary buffer comparison (SAME as musigKeyAgg does)
  indexed.sort((a, b) => a.buffer.compare(b.buffer))

  // First in sorted order is the coordinator (index 0 in sorted array)
  const coordinator = indexed[0]
  const sortedSigners = indexed.map(item => item.publicKey)

  // Create index mapping (original index -> sorted index)
  const indexMapping = new Map<number, number>()
  indexed.forEach((item, sortedIdx) => {
    indexMapping.set(item.originalIndex, sortedIdx)
  })

  return {
    coordinatorIndex: 0, // Coordinator is always first in sorted order
    coordinatorPublicKey: coordinator.publicKey,
    sortedSigners,
    indexMapping,
    electionProof: computeElectionProof(signers),
  }
}

/**
 * Elect coordinator by hash-based selection
 *
 * Uses a hash of all public keys to deterministically select a coordinator.
 * This provides pseudo-random selection that is still deterministic.
 *
 * NOTE: Sorts keys first to match musigKeyAgg behavior, then applies hash selection
 */
function electByHash(signers: PublicKey[]): ElectionResult {
  // First, sort signers lexicographically (SAME as musigKeyAgg does)
  const indexed = signers.map((pk, idx) => ({
    originalIndex: idx,
    publicKey: pk,
    buffer: pk.toBuffer(),
  }))
  indexed.sort((a, b) => a.buffer.compare(b.buffer))

  const sortedSigners = indexed.map(item => item.publicKey)

  // Create index mapping (original index -> sorted index)
  const indexMapping = new Map<number, number>()
  indexed.forEach((item, sortedIdx) => {
    indexMapping.set(item.originalIndex, sortedIdx)
  })

  // Compute hash of all SORTED public keys concatenated
  const concatenated = sortedSigners.map(pk => pk.toString()).join('')
  const hash = Buffer.from(sha256(new TextEncoder().encode(concatenated)))

  // Use hash to select index in SORTED array
  const hashValue = hash.readUInt32BE(0)
  const coordinatorIndex = hashValue % sortedSigners.length

  return {
    coordinatorIndex, // Index in sorted array
    coordinatorPublicKey: sortedSigners[coordinatorIndex],
    sortedSigners,
    indexMapping,
    electionProof: computeElectionProof(signers),
  }
}

/**
 * Elect first signer as coordinator
 *
 * Simple method that always selects the first signer in SORTED order.
 * Useful for testing or when order is pre-agreed.
 *
 * NOTE: Sorts keys first to match musigKeyAgg behavior
 */
function electFirstSigner(signers: PublicKey[]): ElectionResult {
  // Sort signers lexicographically (SAME as musigKeyAgg does)
  const indexed = signers.map((pk, idx) => ({
    originalIndex: idx,
    publicKey: pk,
    buffer: pk.toBuffer(),
  }))
  indexed.sort((a, b) => a.buffer.compare(b.buffer))

  const sortedSigners = indexed.map(item => item.publicKey)

  // Create index mapping (original index -> sorted index)
  const indexMapping = new Map<number, number>()
  indexed.forEach((item, sortedIdx) => {
    indexMapping.set(item.originalIndex, sortedIdx)
  })

  return {
    coordinatorIndex: 0, // First in sorted array
    coordinatorPublicKey: sortedSigners[0],
    sortedSigners,
    indexMapping,
    electionProof: computeElectionProof(signers),
  }
}

/**
 * Elect last signer as coordinator
 *
 * Simple method that always selects the last signer in SORTED order.
 * Useful for testing or when order is pre-agreed.
 *
 * NOTE: Sorts keys first to match musigKeyAgg behavior
 */
function electLastSigner(signers: PublicKey[]): ElectionResult {
  // Sort signers lexicographically (SAME as musigKeyAgg does)
  const indexed = signers.map((pk, idx) => ({
    originalIndex: idx,
    publicKey: pk,
    buffer: pk.toBuffer(),
  }))
  indexed.sort((a, b) => a.buffer.compare(b.buffer))

  const sortedSigners = indexed.map(item => item.publicKey)
  const coordinatorIndex = sortedSigners.length - 1

  // Create index mapping (original index -> sorted index)
  const indexMapping = new Map<number, number>()
  indexed.forEach((item, sortedIdx) => {
    indexMapping.set(item.originalIndex, sortedIdx)
  })

  return {
    coordinatorIndex, // Last in sorted array
    coordinatorPublicKey: sortedSigners[coordinatorIndex],
    sortedSigners,
    indexMapping,
    electionProof: computeElectionProof(signers),
  }
}

/**
 * Compute election proof
 *
 * Creates a hash of all public keys to prove the election was based on
 * the correct set of participants.
 */
function computeElectionProof(signers: PublicKey[]): string {
  const concatenated = signers
    .map(pk => pk.toString())
    .sort()
    .join('')
  return bytesToHex(sha256(new TextEncoder().encode(concatenated)))
}

/**
 * Verify election result
 *
 * Validates that an election result is correct for a given set of signers.
 *
 * @param signers - All participating signers' public keys
 * @param result - Election result to verify
 * @param method - Election method used (default: LEXICOGRAPHIC)
 * @returns True if election result is valid
 */
export function verifyElectionResult(
  signers: PublicKey[],
  result: ElectionResult,
  method: ElectionMethod = ElectionMethod.LEXICOGRAPHIC,
): boolean {
  // Re-run election
  const expectedResult = electCoordinator(signers, method)

  // Compare results
  return (
    expectedResult.coordinatorIndex === result.coordinatorIndex &&
    expectedResult.electionProof === result.electionProof
  )
}

/**
 * Check if a specific signer is the coordinator
 *
 * @param signers - All participating signers' public keys
 * @param signerIndex - Index of the signer to check
 * @param method - Election method (default: LEXICOGRAPHIC)
 * @returns True if the signer at signerIndex is the coordinator
 */
export function isCoordinator(
  signers: PublicKey[],
  signerIndex: number,
  method: ElectionMethod = ElectionMethod.LEXICOGRAPHIC,
): boolean {
  if (signerIndex < 0 || signerIndex >= signers.length) {
    return false
  }

  const election = electCoordinator(signers, method)
  return election.coordinatorIndex === signerIndex
}

/**
 * Get coordinator public key
 *
 * @param signers - All participating signers' public keys
 * @param method - Election method (default: LEXICOGRAPHIC)
 * @returns Public key of the elected coordinator
 */
export function getCoordinatorPublicKey(
  signers: PublicKey[],
  method: ElectionMethod = ElectionMethod.LEXICOGRAPHIC,
): PublicKey {
  const election = electCoordinator(signers, method)
  return election.coordinatorPublicKey
}

/**
 * Get backup coordinator (failover mechanism)
 *
 * If the primary coordinator fails to broadcast, this function determines
 * the next coordinator in line based on the election method.
 *
 * @param signers - All participating signers' public keys
 * @param currentCoordinatorIndex - Current coordinator's index
 * @param method - Election method (default: LEXICOGRAPHIC)
 * @returns Index of the backup coordinator, or null if no backup available
 *
 * @example
 * ```typescript
 * const election = electCoordinator(signers)
 * const backup = getBackupCoordinator(signers, election.coordinatorIndex)
 * if (backup !== null && backup === myIndex) {
 *   // I am the backup coordinator, take over
 *   await broadcastTransaction(tx)
 * }
 * ```
 */
export function getBackupCoordinator(
  signers: PublicKey[],
  currentCoordinatorIndex: number,
  method: ElectionMethod = ElectionMethod.LEXICOGRAPHIC,
): number | null {
  if (signers.length === 1) {
    return null // No backup available with single signer
  }

  switch (method) {
    case ElectionMethod.LEXICOGRAPHIC:
      return getBackupForLexicographic(signers, currentCoordinatorIndex)
    case ElectionMethod.HASH_BASED:
      return getBackupForHashBased(signers, currentCoordinatorIndex)
    case ElectionMethod.FIRST_SIGNER:
      return getBackupForFirstSigner(signers, currentCoordinatorIndex)
    case ElectionMethod.LAST_SIGNER:
      return getBackupForLastSigner(signers, currentCoordinatorIndex)
    default:
      throw new Error(`Unknown election method: ${method}`)
  }
}

/**
 * Get backup coordinator for lexicographic method
 *
 * Backup is the next signer in lexicographic order after the current coordinator
 */
function getBackupForLexicographic(
  signers: PublicKey[],
  currentCoordinatorIndex: number,
): number | null {
  // Create array of [original index, public key, hex string] for sorting
  const indexed = signers.map((pk, idx) => ({
    originalIndex: idx,
    publicKey: pk,
    hex: pk.toString(),
  }))

  // Sort by hex string (lexicographic order)
  indexed.sort((a, b) => a.hex.localeCompare(b.hex))

  // Find current coordinator in sorted list
  const currentSortedIndex = indexed.findIndex(
    item => item.originalIndex === currentCoordinatorIndex,
  )

  if (currentSortedIndex === -1) {
    throw new Error('Current coordinator not found in signers list')
  }

  // Next in sorted order (wrap around if at end)
  const nextSortedIndex = (currentSortedIndex + 1) % indexed.length
  return indexed[nextSortedIndex].originalIndex
}

/**
 * Get backup coordinator for hash-based method
 *
 * Backup is determined by (current + 1) % n to ensure we cycle through all signers
 */
function getBackupForHashBased(
  signers: PublicKey[],
  currentCoordinatorIndex: number,
): number | null {
  // For hash-based with failover, we cycle through indices
  // This ensures deterministic and exhaustive failover
  return (currentCoordinatorIndex + 1) % signers.length
}

/**
 * Get backup coordinator for first-signer method
 *
 * Backup progresses through signers in order: 0 -> 1 -> 2 -> ...
 */
function getBackupForFirstSigner(
  signers: PublicKey[],
  currentCoordinatorIndex: number,
): number | null {
  // Next signer in order
  const nextIndex = currentCoordinatorIndex + 1
  if (nextIndex >= signers.length) {
    return null // No more backups available
  }
  return nextIndex
}

/**
 * Get backup coordinator for last-signer method
 *
 * Backup progresses backwards through signers: (n-1) -> (n-2) -> (n-3) -> ...
 */
function getBackupForLastSigner(
  signers: PublicKey[],
  currentCoordinatorIndex: number,
): number | null {
  // Previous signer in order
  const nextIndex = currentCoordinatorIndex - 1
  if (nextIndex < 0) {
    return null // No more backups available
  }
  return nextIndex
}

/**
 * Get all backup coordinators in priority order
 *
 * Returns an ordered list of backup coordinator indices for failover.
 *
 * @param signers - All participating signers' public keys
 * @param method - Election method (default: LEXICOGRAPHIC)
 * @returns Array of coordinator indices in priority order (primary first, then backups)
 *
 * @example
 * ```typescript
 * const coordinators = getCoordinatorPriorityList(signers)
 * // coordinators = [2, 4, 0, 1, 3] // Primary is index 2, first backup is 4, etc.
 *
 * // Check if I'm a coordinator (primary or backup)
 * const myPriority = coordinators.indexOf(myIndex)
 * if (myPriority !== -1) {
 *   console.log(`I am coordinator with priority ${myPriority}`)
 * }
 * ```
 */
export function getCoordinatorPriorityList(
  signers: PublicKey[],
  method: ElectionMethod = ElectionMethod.LEXICOGRAPHIC,
): number[] {
  const election = electCoordinator(signers, method)
  const priorityList: number[] = [election.coordinatorIndex]

  let currentIndex = election.coordinatorIndex
  while (true) {
    const backup = getBackupCoordinator(signers, currentIndex, method)
    if (backup === null || priorityList.includes(backup)) {
      break // No more backups or we've cycled back
    }
    priorityList.push(backup)
    currentIndex = backup
  }

  return priorityList
}
