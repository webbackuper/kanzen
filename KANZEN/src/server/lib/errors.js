export class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export const badRequest = (m = 'Requête invalide') => new HttpError(400, m, 'BAD_REQUEST');
export const unauthorized = (m = 'Authentification requise') => new HttpError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'Accès refusé') => new HttpError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Introuvable') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m = 'Conflit') => new HttpError(409, m, 'CONFLICT');
