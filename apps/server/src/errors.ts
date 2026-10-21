export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 404 | 409 | 501 = 400,
  ) {
    super(message);
  }
}

export class NotImplementedError extends ApiError {
  constructor(message: string) {
    super("NOT_IMPLEMENTED", message, 501);
  }
}

export function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new ApiError("NOT_FOUND", `${label} not found`, 404);
  }
  return value;
}
