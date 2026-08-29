export type RuntimeMode = 'offline' | 'field';

const FIELD_RUNTIME_DISABLED = 'FIELD_RUNTIME_DISABLED: The legacy field runtime can directly control I/O and is not a verified implementation of the closure contract.';

export function assertSupportedRuntimeMode(mode: RuntimeMode): void {
  if (mode !== 'offline' && mode !== 'field') throw new Error(FIELD_RUNTIME_DISABLED);
}

export function assertFieldRuntimeDisabled(): never {
  throw new Error(FIELD_RUNTIME_DISABLED);
}
