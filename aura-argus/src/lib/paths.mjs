// 跨平台路径：缓存目录 / 状态目录。不假设 shell、不写死盘符。
import os from 'node:os';
import path from 'node:path';

const APP = 'aura-argus';

export function defaultCacheDir(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env.AURA_ARGUS_CACHE_DIR) return path.resolve(env.AURA_ARGUS_CACHE_DIR);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA || path.join(homedir, 'AppData', 'Local');
    return path.join(base, APP, 'cache');
  }
  const base = env.XDG_CACHE_HOME || path.join(homedir, '.cache');
  return path.join(base, APP, 'cache');
}

export function defaultSitesFile(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env.AURA_ARGUS_CONFIG_DIR) return path.join(path.resolve(expandHome(env.AURA_ARGUS_CONFIG_DIR, homedir)), 'sites.json');
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(base, APP, 'sites.json');
  }
  const base = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
  return path.join(base, APP, 'sites.json');
}

export function expandHome(input, homedir = os.homedir()) {
  if (!input) return input;
  if (input === '~') return homedir;
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir, input.slice(2));
  return input;
}
