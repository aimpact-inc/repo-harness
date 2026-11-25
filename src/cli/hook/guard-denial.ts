export interface Denial {
  readonly guard: string;
  readonly reason: string;
  readonly fix: string;
  /** The user can authorize the call locally (I2) on a host that supports an approval prompt. */
  readonly askable?: true;
}
