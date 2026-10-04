export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (msg: string, code = 'CONFLICT', details?: unknown) => new AppError(409, code, msg, details);
