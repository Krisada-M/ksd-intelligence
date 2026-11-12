import { calculateFee } from './fee';

export default class PaymentService {
  charge(amount: number): number {
    return calculateFee(amount);
  }
}
