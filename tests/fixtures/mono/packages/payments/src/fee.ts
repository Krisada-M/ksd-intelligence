import { roundMoney } from '@fx/shared/money';

const legacy = require('../../shared/src/legacy.cjs');

export type Fee = { amount: number; currency: string };

export function calculateFee(amount: number): number;
export function calculateFee(amount: number, currency: string): number;
export function calculateFee(amount: number, currency?: string): number {
  void currency;
  roundMoney(amount);
  return legacy.toCents(amount) as number;
}

export function unusedHelper(): number {
  return 0;
}

function localOnly(): void {}
void localOnly;
