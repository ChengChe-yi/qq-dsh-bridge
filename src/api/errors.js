export class BridgeApiError extends Error {
  constructor(message, { status = 400, code = '' } = {}) {
    super(message);
    this.name = 'BridgeApiError';
    this.status = status;
    this.code = code;
  }
}
