/**
 * P2P Discovery Module
 *
 * Public exports for the discovery system
 */

// Type exports
export type {
  DiscoveryCriteria,
  DiscoveryAdvertisement,
  DiscoveryOptions,
  DiscoverySubscription,
  SubscriptionOptions,
  SecurityValidationResult,
  ReputationData,
  SecurityPolicy,
  IDiscoveryAdvertiser,
  IDiscoveryDiscoverer,
  // Cache interface types (Phase 3)
  IDiscoveryCache,
  DiscoveryCacheEntry,
} from './types.js'

// Cache implementation
export { InMemoryDiscoveryCache } from './types.js'

// Class and enum exports
export { DHTAdvertiser } from './dht-advertiser.js'

export { DHTDiscoverer } from './dht-discoverer.js'

export {
  DiscoverySecurityValidator,
  createSecurityPolicy,
  musig2Validator,
  locationValidator,
  capabilityValidator,
} from './security.js'

export {
  DiscoveryError,
  DiscoveryErrorType,
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_SECURITY_POLICY,
} from './types.js'

// ============================================================================
// Factory Functions
// ============================================================================

import type { P2PCoordinator } from '../coordinator.js'
import { DHTAdvertiser } from './dht-advertiser.js'
import { DHTDiscoverer } from './dht-discoverer.js'
import { DiscoverySecurityValidator, createSecurityPolicy } from './security.js'
import type {
  DiscoveryOptions,
  SecurityPolicy,
  IDiscoveryCache,
} from './types.js'
import type { PrivateKey } from 'xpi-ts/lib/bitcore/privatekey'

/**
 * Create a discovery advertiser
 */
export function createAdvertiser(
  coordinator: P2PCoordinator,
  options?: {
    signingKey?: PrivateKey
    defaultOptions?: Partial<DiscoveryOptions>
    securityPolicy?: Partial<SecurityPolicy>
  },
): DHTAdvertiser {
  const advertiser = new DHTAdvertiser(coordinator, options?.signingKey)
  return advertiser
}

/**
 * Create a discovery discoverer
 *
 * @param coordinator - The P2P coordinator
 * @param options - Configuration options
 * @param externalCache - Optional external cache for persistence
 */
export function createDiscoverer(
  coordinator: P2PCoordinator,
  options?: {
    defaultOptions?: Partial<DiscoveryOptions>
    securityPolicy?: Partial<SecurityPolicy>
  },
  externalCache?: IDiscoveryCache,
): DHTDiscoverer {
  const discoverer = new DHTDiscoverer(coordinator, externalCache)
  return discoverer
}

/**
 * Create a security validator
 */
export function createSecurityValidator(
  coordinator: P2PCoordinator,
  protocol?: string,
  policyOverrides?: Partial<SecurityPolicy>,
): DiscoverySecurityValidator {
  const policy = protocol
    ? createSecurityPolicy(protocol, policyOverrides)
    : { ...policyOverrides }

  return new DiscoverySecurityValidator(coordinator, policy)
}

/**
 * Create a complete discovery system
 */
export function createDiscoverySystem(
  coordinator: P2PCoordinator,
  protocol: string,
  options?: {
    defaultOptions?: Partial<DiscoveryOptions>
    securityPolicy?: Partial<SecurityPolicy>
  },
): {
  advertiser: DHTAdvertiser
  discoverer: DHTDiscoverer
  security: DiscoverySecurityValidator
  start: () => Promise<void>
  stop: () => Promise<void>
} {
  const advertiser = createAdvertiser(coordinator, options)
  const discoverer = createDiscoverer(coordinator, options)
  const security = createSecurityValidator(
    coordinator,
    protocol,
    options?.securityPolicy,
  )

  return {
    advertiser,
    discoverer,
    security,
    async start(): Promise<void> {
      await Promise.all([advertiser.start(), discoverer.start()])
      security.start()
    },
    async stop(): Promise<void> {
      await Promise.all([advertiser.stop(), discoverer.stop()])
      security.stop()
    },
  }
}
