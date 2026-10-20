/** Errors raised by policy validation and executor lifecycle checks. */
export class PolicyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PolicyError'; }
}

/** The shared provider interface cannot perform this operation. */
export class NotImplementedError extends PolicyError {
  constructor(message: string) { super('NOT_IMPLEMENTED', message); this.name = 'NotImplementedError'; }
}
