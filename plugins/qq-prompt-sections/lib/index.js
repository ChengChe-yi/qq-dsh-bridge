

import fs from 'node:fs';
import path from 'node:path';


const name = 'qq-prompt-sections';


const inject = ['systemPrompt'];


const SECTIONS = Object.freeze([
  { id: 'qq:intro', file: '1-intro.md', order: 100 },
  { id: 'qq:read-format', file: '2-read-format.md', order: 200 },
  { id: 'qq:safety', file: '3-safety.md', order: 300 },
  { id: 'qq:qq-tools', file: '4-qq-tools.md', order: 400 },
  { id: 'qq:role-hint', file: '0-role-hint.md', order: 10 },
  { id: 'qq:anchor', file: '5-anchor.md', order: 10300 },
]);




function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}


function loadRoleCard(config) {
  const rolesDir = config?.rolesDir;
  const stateFile = config?.currentRoleFile;
  if (!rolesDir || !stateFile) return '';

  const cur = readJson(stateFile);
  const roleName = String(cur?.role ?? '').trim();
  if (!roleName) return '';

  const safe = path.basename(roleName);
  try {
    return fs.readFileSync(path.join(rolesDir, `${safe}.md`), 'utf8').trim();
  } catch {
    return '';
  }
}

function readSection(dir, file) {
  try {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    return text;
  } catch (error) {
    throw new Error(
      `qq-prompt-sections: 读不到 ${path.join(dir, file)}（${error.code ?? error.message}）。`
      + '这个文件承载的是防提示词注入的规则，缺失必须显式失败，不能静默跳过。',
    );
  }
}


function fillIntro(text, config, context) {
  const rt = config?.runtimeFile ? readJson(config.runtimeFile) : null;
  const selfQq = String(rt?.selfQq ?? '').trim();

  const bcfg = config?.bridgeConfigFile ? readJson(config.bridgeConfigFile) : null;
  const ownerQq = String(bcfg?.owner?.qq ?? '').trim();

  void context; 

  return text
    .replaceAll('{selfQq}', selfQq || '(未知)')
    .replaceAll('{ownerQq}', ownerQq || '(未知)');
}

function apply(ctx, config) {
  const dir = String(config?.dir ?? '').trim();
  if (!dir) {
    throw new Error(
      'qq-prompt-sections: 必须配置 `dir`（存放 prompts/*.md 的目录）。'
      + '当前需要 0-role-hint.md / 1-intro.md / 2-read-format.md / 3-safety.md / 4-qq-tools.md / 5-anchor.md。',
    );
  }

  for (const { id, file, order } of SECTIONS) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: id,
        order,
        interpolate: false,
        text: (context) => {
          const raw = readSection(dir, file);
          return id === 'qq:intro' ? fillIntro(raw, config, context) : raw;
        },
      }),
      `qq-prompt-sections.${id}`,
    );
  }

  {
    const [id, order] = ['qq:role-card', 11];
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: id,
        order,
        interpolate: false,
        text: () => loadRoleCard(config),
      }),
      `qq-prompt-sections.${id}`,
    );
  }
}

export { apply, inject, name, SECTIONS, loadRoleCard };
