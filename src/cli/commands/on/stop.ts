import { stopServices } from './services.js';

export async function goOffTheRelay(deps: { log?: (...args: unknown[]) => void } | undefined): Promise<void> {
  await stopServices();
  const message = 'Off the relay.';
  if (deps?.log) {
    deps.log(message);
    return;
  }
  console.log(message);
}
