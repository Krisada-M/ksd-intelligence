import { calculateFee as fee } from '@fx/payments';
import type { Fee } from '@fx/payments';

export function submit(): Fee {
  return { amount: fee(10), currency: 'USD' };
}
