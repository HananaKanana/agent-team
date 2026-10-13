// 业务错误：code 供程序判断，message 是给模型看的中文句子，包含下一步该怎么做。
// code: NOT_FOUND | BAD_STATE | LEASE_LOST | NOT_YOURS | INVALID | NEEDS_USER
export class AteamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AteamError';
    this.code = code;
  }
}
