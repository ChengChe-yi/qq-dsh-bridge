import fs from 'node:fs';
import path from 'node:path';

export function createDecideLog({ file, logger } = {}) {
  if (!file) return { write() {} };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    logger?.debug('决策日志目录建不出来', { file, error: String(error) });
    return { write() {} };
  }

  return {
    write(row) {
      try {
        fs.appendFile(file, `${JSON.stringify(row)}\n`, (error) => {
          if (error) logger?.debug('决策日志写入失败', { error: String(error) });
        });
      } catch (error) {
        logger?.debug('决策日志写入失败', { error: String(error) });
      }
    },
  };
}
