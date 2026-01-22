/**
 * Browser Agent Module
 *
 * Integrates browser-use (https://github.com/browser-use/browser-use)
 * with agent-relay for web automation capabilities.
 *
 * @example
 * ```typescript
 * import { BrowserWrapper } from 'agent-relay/browser';
 *
 * const browser = new BrowserWrapper({
 *   name: 'Browser',
 *   model: 'gpt-4o',
 *   headless: true,
 * });
 *
 * await browser.start();
 * ```
 */

export { BrowserWrapper, type BrowserWrapperConfig } from './browser-wrapper.js';
