import { PaymentService, calculateFee } from '@fx/payments';

export function chargeHandler(): void {
  new PaymentService().charge(10);
  calculateFee(10);
}
