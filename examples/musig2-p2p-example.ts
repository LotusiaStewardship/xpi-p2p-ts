/**
 * MuSig2 P2P Coordination Example
 *
 * Demonstrates how to use the MuSig2 P2P coordination layer for
 * decentralized multi-party signing sessions
 */

import { waitForEvent, ConnectionEvent, P2PCoordinator } from '../lib/index.js'
import { MuSig2P2PCoordinator, MuSig2Event } from '../lib/musig2/index.js'
import { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'

/**
 * Example: 2-of-2 MuSig2 Signing Session over P2P
 *
 * Alice and Bob coordinate a multi-signature signing session
 * without a central server, using P2P infrastructure.
 */
async function main() {
  console.log('=== MuSig2 P2P Coordination Example ===\n')

  // Step 1: Create P2P coordinators for Alice and Bob
  console.log('Step 1: Creating P2P coordinators...')

  const alice = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/0'], // Random port
    enableDHT: true,
    enableDHTServer: true, // Enable DHT server for session discovery
  })

  const bob = new P2PCoordinator({
    listen: ['/ip4/127.0.0.1/tcp/0'], // Random port
    enableDHT: true,
    enableDHTServer: true,
  })

  await alice.start()
  await bob.start()

  console.log('Alice Peer ID:', alice.peerId)
  console.log('Bob Peer ID:', bob.peerId)
  console.log()

  // Step 2: Connect peers
  console.log('Step 2: Connecting peers...')

  const bobConnectPromise = waitForEvent(bob, ConnectionEvent.CONNECTED)
  const bobAddrs = bob.libp2pNode.getMultiaddrs()
  await alice.connectToPeer(bobAddrs[0].toString())
  await bobConnectPromise

  console.log('Peers connected!')
  console.log()

  // Step 3: Create keys and message
  console.log('Step 3: Creating keys and message...')

  const aliceKey = new PrivateKey()
  const bobKey = new PrivateKey()
  const message = Buffer.from('Test transaction to sign with MuSig2', 'utf8')

  console.log('Alice Public Key:', aliceKey.publicKey.toString())
  console.log('Bob Public Key:', bobKey.publicKey.toString())
  console.log('Message to sign:', message.toString('utf8'))
  console.log()

  // Step 4: Create MuSig2 coordinators and sessions
  console.log('Step 4: Creating MuSig2 sessions...')

  // Create MuSig2 coordinators wrapping the P2P coordinators
  const aliceMuSig = new MuSig2P2PCoordinator(alice)
  const bobMuSig = new MuSig2P2PCoordinator(bob)

  // Listen for session events
  aliceMuSig.on(MuSig2Event.SESSION_CREATED, (sessionId: string) => {
    console.log(`[Alice] Session created: ${sessionId}`)
  })

  aliceMuSig.on(MuSig2Event.NONCES_COMPLETE, (sessionId: string) => {
    console.log(`[Alice] All nonces received for session: ${sessionId}`)
  })

  aliceMuSig.on(MuSig2Event.SESSION_COMPLETE, (sessionId: string) => {
    console.log(`[Alice] Session complete: ${sessionId}`)
  })

  bobMuSig.on(MuSig2Event.PARTICIPANT_JOINED, (sessionId: string) => {
    console.log(`[Bob] Joined session: ${sessionId}`)
  })

  bobMuSig.on(MuSig2Event.NONCES_COMPLETE, (sessionId: string) => {
    console.log(`[Bob] All nonces received for session: ${sessionId}`)
  })

  bobMuSig.on(MuSig2Event.SESSION_COMPLETE, (sessionId: string) => {
    console.log(`[Bob] Session complete: ${sessionId}`)
  })

  const aliceSessionId = await aliceMuSig.createSession(
    [aliceKey.publicKey, bobKey.publicKey],
    aliceKey,
    message,
    { description: 'Example MuSig2 P2P signing session' },
  )

  console.log('Alice Session ID:', aliceSessionId)

  // Step 5: Bob creates his session (in real scenario, would discover via DHT)
  console.log('\nStep 5: Bob creates his session...')

  // Note: In a real scenario with proper DHT setup, Bob would discover the session
  // For this example, Bob creates a matching session since DHT may not work in localhost
  // In production with public nodes, DHT discovery would work automatically
  // The session IDs should match because they're derived from signers + message

  console.log('(Note: In production, Bob would discover session via DHT)')
  console.log(
    '(For this example, Bob creates matching session with same signers+message)',
  )

  const bobSessionId = await bobMuSig.createSession(
    [aliceKey.publicKey, bobKey.publicKey],
    bobKey,
    message,
    { description: 'Example MuSig2 P2P signing session' },
  )

  console.log('Bob Session ID:', bobSessionId)

  // Verify session IDs match (deterministic based on signers + message)
  if (aliceSessionId === bobSessionId) {
    console.log(
      '✅ Session IDs match! Both parties are coordinating the same session.',
    )
  } else {
    console.error('❌ ERROR: Session IDs do not match!')
    return
  }

  const sessionId = aliceSessionId
  console.log()

  // Step 6: Start Round 1 (Nonce Exchange)
  console.log('Step 6: Starting Round 1 (Nonce Exchange)...')

  // Both participants generate and share nonces
  // Note: Since we're not using DHT discovery for participant tracking in this example,
  // the nonces won't be automatically broadcast to peers. In a production environment
  // with proper DHT setup, participants would be tracked automatically.
  //
  // For this example, we'll demonstrate the local session management capabilities
  await aliceMuSig.shareNonces(sessionId, aliceKey)
  await bobMuSig.shareNonces(sessionId, bobKey)

  console.log('[Alice] Generated and broadcasted nonces')
  console.log('[Bob] Generated and broadcasted nonces')

  console.log()

  console.log('Note: This example demonstrates the MuSig2 P2P coordinator API.')
  console.log('In a production environment with proper DHT and multiple nodes,')
  console.log('nonces would be automatically exchanged via P2P messaging.')
  console.log(
    'For full end-to-end P2P coordination, see the integration tests.',
  )
  console.log()

  // Step 7: Cleanup
  console.log('Step 7: Cleaning up...')

  await aliceMuSig.stop()
  await bobMuSig.stop()

  console.log('✅ Example complete!')
  console.log('\nThis example demonstrated:')
  console.log('  - MuSig2P2PCoordinator creation (extends P2PCoordinator)')
  console.log('  - Peer connection via libp2p')
  console.log('  - Session creation with automatic ID generation')
  console.log('  - Session event handling')
  console.log('  - Round 1 nonce generation')
  console.log(
    '\nFor full P2P coordination with automatic nonce/signature exchange,',
  )
  console.log('see test/p2p/musig2/integration.test.ts')
}

// Run the example
main().catch(console.error)
