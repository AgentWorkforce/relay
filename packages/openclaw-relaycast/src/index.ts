export type { GatewayConfig, InboundMessage, DeliveryResult } from './types.js';
export { InboundGateway, type GatewayOptions } from './gateway.js';
export {
  detectOpenClaw,
  loadGatewayConfig,
  saveGatewayConfig,
  type OpenClawDetection,
} from './config.js';
export { setup, type SetupOptions, type SetupResult } from './setup.js';
export { deliverMessage } from './inject.js';
