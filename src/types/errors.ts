export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'DATABASE_ERROR'
  | 'PERMISSION_DENIED'
  | 'INSUFFICIENT_STOCK'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
  details?: string;
}

export class ClientAppError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: string;

  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.name = 'ClientAppError';
    this.code = payload.code;
    this.details = payload.details;
  }
}
