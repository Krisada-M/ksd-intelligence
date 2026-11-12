import { chargeHandler } from './charge';

export function loadHandler(name: string): Promise<unknown> {
  return import(`./handlers/${name}`);
}

const registry: Record<string, () => void> = { charge: chargeHandler };

export function run(key: string): void {
  registry[key]();
}
