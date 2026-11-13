import { PaymentProcessor } from './processor';

export class StripeProcessor implements PaymentProcessor {
  charge(): void {}
}
