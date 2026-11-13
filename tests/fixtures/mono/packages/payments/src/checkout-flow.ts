import { roundMoney } from '@fx/shared/money';
import type { PaymentProcessor } from './processor';

export function runCheckout(p: PaymentProcessor): void {
  p.charge();
}

export function normalizeAll(items: number[]): number[] {
  return items.map(roundMoney);
}

export async function lazyFee(amount: number): Promise<number> {
  const fee = await import('./fee');
  return fee.calculateFee(amount);
}
