import { PaymentProcessor } from './processor';

export class ManualProcessor implements PaymentProcessor {
  charge(): void {}
}
