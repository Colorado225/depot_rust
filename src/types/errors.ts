export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'DATABASE_ERROR'
  | 'PERMISSION_DENIED'
  | 'INSUFFICIENT_STOCK'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  // LOT 10 : 95/95, garde-fou contre tout retour du pont HTTP desktop.
  | 'NOT_IMPLEMENTED_IN_RUST';

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
