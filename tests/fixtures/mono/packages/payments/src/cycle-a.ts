import { b } from './cycle-b';

export function a(): void {
  b();
}
