import { a } from './cycle-a';

export function b(): void {
  a();
}
