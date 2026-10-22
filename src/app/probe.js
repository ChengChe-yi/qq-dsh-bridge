import { summarize } from '../util/format.js';

export async function probeOneBotHttp(http, logger) {
  try {
    const login = await http.getLoginInfo();
    const status = await http.probeStatus();
    logger.info('OneBot HTTP 动作通道正常', {
      selfQq: login?.user_id,
      nickname: login?.nickname,
      online: status.online,
      good: status.good,
    });
  } catch (error) {
    logger.warn('OneBot HTTP 探活失败', { error: String(error) });
  }
}

export async function probeDsh(dsh, logger) {
  try {
    const result = await dsh.probeStatus();
    logger.info('DSH 鉴权与 RPC 正常', { authority: dsh.authority, result: summarize(result) });
    return true;
  } catch (error) {
    logger.warn('DSH 探活失败', { error: String(error) });
    return false;
  }
}
