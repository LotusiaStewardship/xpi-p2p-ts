/**
 * MuSig2 Discovery Module
 *
 * Public exports for MuSig2 discovery functionality
 */

export { MuSig2Discovery } from './discovery-extension.js'
export {
  MuSig2DiscoverySecurityValidator,
  createMuSig2SecurityPolicy,
} from './discovery-security.js'
export type {
  MuSig2SignerCriteria,
  MuSig2SigningRequestCriteria,
  MuSig2SignerAdvertisement,
  MuSig2SigningRequestAdvertisement,
  MuSig2DiscoveryConfig,
} from './discovery-types.js'
export {
  DEFAULT_MUSIG2_DISCOVERY_CONFIG,
  isValidSignerAdvertisement,
  isValidSigningRequestAdvertisement,
  isValidSignerCriteria,
  isValidSigningRequestCriteria,
  publicKeyToHex,
  hexToPublicKey,
} from './discovery-types.js'
