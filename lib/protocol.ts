/**
 * P2P Message Protocol
 *
 * Handles message serialization, deserialization, and validation
 */

import { Hash } from 'xpi-ts/lib/bitcore/crypto/hash'
import { Random } from 'xpi-ts/lib/bitcore/crypto/random'
import { P2PMessage, BaseMessageType } from './types.js'

/**
 * Protocol message handler
 */
export class P2PProtocol {
  /**
   * Create a new P2P message
   */
  createMessage<T = unknown>(
    type: string,
    payload: T,
    from: string,
    options?: {
      to?: string
      protocol?: string
      signature?: Buffer
    },
  ): P2PMessage<T> {
    const messageId = this._generateMessageId()

    return {
      type,
      from,
      to: options?.to,
      payload,
      timestamp: Date.now(),
      messageId,
      signature: options?.signature,
      protocol: options?.protocol,
    }
  }

  /**
   * Serialize message to buffer
   */
  serialize(message: P2PMessage): Buffer {
    try {
      const json = JSON.stringify(message)
      return Buffer.from(json, 'utf8')
    } catch (error) {
      throw new Error(`Failed to serialize message: ${error}`)
    }
  }

  /**
   * Deserialize buffer to message
   */
  deserialize(data: Buffer): P2PMessage {
    try {
      const json = data.toString('utf8')
      const message = JSON.parse(json) as P2PMessage
      return message
    } catch (error) {
      throw new Error(`Failed to deserialize message: ${error}`)
    }
  }

  /**
   * Validate message structure
   */
  validateMessage(message: P2PMessage): boolean {
    // Required fields
    if (!message.type || typeof message.type !== 'string') {
      return false
    }

    if (!message.from || typeof message.from !== 'string') {
      return false
    }

    if (!message.timestamp || typeof message.timestamp !== 'number') {
      return false
    }

    if (!message.messageId || typeof message.messageId !== 'string') {
      return false
    }

    // Timestamp not too old or in future
    const now = Date.now()
    const maxAge = 300000 // 5 minutes
    if (Math.abs(now - message.timestamp) > maxAge) {
      return false
    }

    return true
  }

  /**
   * Validate message size
   */
  validateMessageSize(
    message: P2PMessage,
    maxSize: number = 1024 * 1024,
  ): boolean {
    const serialized = this.serialize(message)
    return serialized.length <= maxSize
  }

  /**
   * Compute message hash (for deduplication)
   */
  computeMessageHash(message: P2PMessage): string {
    const data = Buffer.concat([
      Buffer.from(message.type),
      Buffer.from(message.from),
      Buffer.from(message.to || ''),
      Buffer.from(message.messageId),
    ])
    return Hash.hmac(
      Hash.sha256,
      data,
      Buffer.from('lotus-lib-p2p-message-hash-key'),
    ).toString('hex')
  }

  /**
   * Create handshake message
   */
  createHandshake(
    peerId: string,
    metadata?: Record<string, unknown>,
  ): P2PMessage {
    return this.createMessage(
      BaseMessageType.PEER_HANDSHAKE,
      {
        peerId,
        timestamp: Date.now(),
        metadata,
      },
      peerId,
    )
  }

  /**
   * Create heartbeat message
   */
  createHeartbeat(peerId: string): P2PMessage {
    return this.createMessage(
      BaseMessageType.PEER_HEARTBEAT,
      {
        timestamp: Date.now(),
      },
      peerId,
    )
  }

  /**
   * Create disconnect message
   */
  createDisconnect(peerId: string, reason?: string): P2PMessage {
    return this.createMessage(
      BaseMessageType.PEER_DISCONNECT,
      {
        reason,
        timestamp: Date.now(),
      },
      peerId,
    )
  }

  /**
   * Create error message
   */
  createError(peerId: string, error: string, context?: unknown): P2PMessage {
    return this.createMessage(
      BaseMessageType.ERROR,
      {
        error,
        context,
        timestamp: Date.now(),
      },
      peerId,
    )
  }

  /**
   * Generate unique message ID
   */
  private _generateMessageId(): string {
    const timestamp = Date.now().toString(36)
    const random = Random.getRandomBuffer(8).toString('hex')
    return `${timestamp}-${random}`
  }
}
