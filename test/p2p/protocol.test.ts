/**
 * P2P Protocol Tests
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { P2PProtocol } from '../../lib/protocol.js'
import { BaseMessageType } from '../../lib/types.js'

describe('P2P Protocol', () => {
  const protocol = new P2PProtocol()
  const peerId = 'test-peer-123'

  describe('Message Creation', () => {
    it('should create valid message', () => {
      const message = protocol.createMessage(
        'test-type',
        { data: 'test' },
        peerId,
      )

      assert.strictEqual(message.type, 'test-type')
      assert.strictEqual(message.from, peerId)
      assert.ok(message.timestamp)
      assert.ok(message.messageId)
      assert.deepStrictEqual(message.payload, { data: 'test' })
    })

    it('should create handshake message', () => {
      const message = protocol.createHandshake(peerId, { version: '1.0' })

      assert.strictEqual(message.type, BaseMessageType.PEER_HANDSHAKE)
      assert.strictEqual(message.from, peerId)
      assert.ok((message.payload as Record<string, unknown>).metadata)
    })

    it('should create heartbeat message', () => {
      const message = protocol.createHeartbeat(peerId)

      assert.strictEqual(message.type, BaseMessageType.PEER_HEARTBEAT)
      assert.strictEqual(message.from, peerId)
    })

    it('should create disconnect message', () => {
      const message = protocol.createDisconnect(peerId, 'test reason')

      assert.strictEqual(message.type, BaseMessageType.PEER_DISCONNECT)
      assert.strictEqual(
        (message.payload as Record<string, unknown>).reason,
        'test reason',
      )
    })
  })

  describe('Serialization', () => {
    it('should serialize and deserialize message', () => {
      const original = protocol.createMessage(
        'test',
        { foo: 'bar', num: 123 },
        peerId,
      )

      const serialized = protocol.serialize(original)
      assert.ok(Buffer.isBuffer(serialized))

      const deserialized = protocol.deserialize(serialized)
      assert.strictEqual(deserialized.type, original.type)
      assert.strictEqual(deserialized.from, original.from)
      assert.deepStrictEqual(deserialized.payload, original.payload)
    })

    it('should handle complex payloads', () => {
      const complexPayload = {
        nested: {
          data: [1, 2, 3],
          obj: { key: 'value' },
        },
        buffer: Buffer.from('test').toString('hex'),
      }

      const message = protocol.createMessage('complex', complexPayload, peerId)
      const serialized = protocol.serialize(message)
      const deserialized = protocol.deserialize(serialized)

      assert.deepStrictEqual(deserialized.payload, complexPayload)
    })
  })

  describe('Validation', () => {
    it('should validate valid message', () => {
      const message = protocol.createMessage('test', {}, peerId)
      assert.strictEqual(protocol.validateMessage(message), true)
    })

    it('should reject message without type', () => {
      const message = protocol.createMessage('test', {}, peerId)
      delete (message as unknown as Record<string, unknown>).type
      assert.strictEqual(protocol.validateMessage(message), false)
    })

    it('should reject message without from', () => {
      const message = protocol.createMessage('test', {}, peerId)
      delete (message as unknown as Record<string, unknown>).from
      assert.strictEqual(protocol.validateMessage(message), false)
    })

    it('should reject message with invalid timestamp', () => {
      const message = protocol.createMessage('test', {}, peerId)
      message.timestamp = Date.now() - 400000 // 6+ minutes old
      assert.strictEqual(protocol.validateMessage(message), false)
    })

    it('should validate message size', () => {
      const smallMessage = protocol.createMessage(
        'test',
        { data: 'small' },
        peerId,
      )
      assert.strictEqual(protocol.validateMessageSize(smallMessage, 1024), true)

      const largePayload = 'x'.repeat(10000)
      const largeMessage = protocol.createMessage(
        'test',
        { data: largePayload },
        peerId,
      )
      assert.strictEqual(
        protocol.validateMessageSize(largeMessage, 1024),
        false,
      )
    })
  })

  describe('Message Hashing', () => {
    it('should compute consistent hash', () => {
      const message = protocol.createMessage('test', {}, peerId)
      const hash1 = protocol.computeMessageHash(message)
      const hash2 = protocol.computeMessageHash(message)

      assert.strictEqual(hash1, hash2)
      assert.strictEqual(hash1.length, 64) // SHA256 hex
    })

    it('should produce different hashes for different messages', () => {
      const message1 = protocol.createMessage('test1', {}, peerId)
      const message2 = protocol.createMessage('test2', {}, peerId)

      const hash1 = protocol.computeMessageHash(message1)
      const hash2 = protocol.computeMessageHash(message2)

      assert.notStrictEqual(hash1, hash2)
    })
  })
})
