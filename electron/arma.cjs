const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const { autoResolvePaths, ARMA_APP_ID, parseLibraryFolders } = require('./paths.cjs');

const PERFORMANCE_PRESETS = {
  low: { cpuCount: 4, exThreads: 2, maxMem: 4096, maxVram: 1024, hugePages: false },
  medium: { cpuCount: 8, exThreads: 4, maxMem: 8192, maxVram: 2048, hugePages: false },
  high: { cpuCount: 12, exThreads: 5, maxMem: 16384, maxVram: 3072, hugePages: false },
  ultra: { cpuCount: 16, exThreads: 7, maxMem: 32768, maxVram: 4096, hugePages: false },
};

/** Параметры, которые ломают интро StarFront / меню и часто дают Cannot load mipmap … noise_raw.paa */
const BANNED_LAUNCH_ARGS = new Set([
  '-skipintro',
  '-nosplash',
  '-world=empty',
  '-worldempty',
  '-nobattleye',
  '-hugepages',
]);

function performanceArgs(config) {
  const preset = PERFORMANCE_PRESETS[config.performancePreset] || PERFORMANCE_PRESETS.high;
  const cpu = config.cpuCount || preset.cpuCount;
  const mem = config.maxMem || preset.maxMem;
  const vram = config.maxVram || preset.maxVram;
  // Без -hugePages: на многих ПК без SeLockMemoryPrivilege процесс «висит» без окна
  return [
    '-cpuCount=' + cpu,
    '-exThreads=' + (config.exThreads || preset.exThreads),
    '-maxMem=' + mem,
    '-maxVram=' + vram,
    '-enableHT',
  ];
}

function normalizeArgKey(arg) {
  const raw = String(arg || '').trim();
  if (!raw) return '';
  const eq = raw.indexOf('=');
  const key = (eq >= 0 ? raw.slice(0, eq) : raw).toLowerCase();
  return key.startsWith('-') ? key : `-${key}`;
}

function isBannedLaunchArg(arg, { allowNoSplash = false } = {}) {
  const key = normalizeArgKey(arg);
  if (!key) return true;
  if (key === '-nosplash') return !allowNoSplash;
  if (key === '-world' && /=?\s*empty$/i.test(String(arg).replace(/\s+/g, ''))) return true;
  if (BANNED_LAUNCH_ARGS.has(key)) return true;
  if (key === '-world' && String(arg).toLowerCase().includes('empty')) return true;
  return false;
}

function sanitizeExtraArgs(extra, { allowNoSplash = false } = {}) {
  const parts = String(extra || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.filter((a) => !isBannedLaunchArg(a, { allowNoSplash }));
}

function resolveArmaExe(config) {
  const base = config.armaExe;
  const dir = path.dirname(base);
  const profiling = path.join(dir, 'arma3_x64_profiling.exe');
  // profiling только при явном «Оптимизированный запуск» — иначе ломается интро/ассеты
  if (config.optimizedLaunch === true && fs.existsSync(profiling)) return profiling;
  if (fs.existsSync(base)) return base;
  if (fs.existsSync(profiling)) return profiling;
  return base;
}

function removeSteamAppId(armaDir) {
  // steam_appid.txt в Steam-установке Arma ломает запуск: процесс висит без окна
  try {
    const file = path.join(armaDir, 'steam_appid.txt');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

async function ensureSteamRunning(config) {
  try {
    const { ensureSteamClient } = require('./steam-workshop.cjs');
    await ensureSteamClient(config);
  } catch {
    /* ignore */
  }
}

function syncWorkshopWithArma(config) {
  const result = { modFolders: 0, installedIds: [] };
  if (!fs.existsSync(config.workshopDir)) return result;
  try {
    const ids = fs.readdirSync(config.workshopDir).filter((id) => /^\d+$/.test(id));
    result.modFolders = ids.length;
    result.installedIds = ids;
  } catch {}
  if (fs.existsSync(config.acfPath)) {
    result.acfMtime = fs.statSync(config.acfPath).mtimeMs;
  }
  return result;
}

function getWorkshopLibraries(config) {
  const libs = [];
  const add = (root) => {
    if (!root) return;
    for (const lib of parseLibraryFolders(root)) {
      if (!libs.includes(lib)) libs.push(lib);
    }
  };
  add(config.steamPath);
  if (config.workshopDir) {
    const marker = `${path.sep}steamapps${path.sep}workshop${path.sep}content${path.sep}`;
    const idx = config.workshopDir.toLowerCase().lastIndexOf(marker.toLowerCase());
    if (idx > 0) add(config.workshopDir.slice(0, idx));
  }
  return libs;
}

function locateModFolder(workshopId, config) {
  for (const lib of getWorkshopLibraries(config)) {
    const folder = path.join(lib, 'steamapps', 'workshop', 'content', ARMA_APP_ID, workshopId);
    if (fs.existsSync(folder)) {
      return {
        folder,
        acfPath: path.join(lib, 'steamapps', 'workshop', `appworkshop_${ARMA_APP_ID}.acf`),
      };
    }
  }
  const fallback = path.join(config.workshopDir || '', workshopId);
  if (config.workshopDir && fs.existsSync(fallback)) {
    return {
      folder: fallback,
      acfPath: config.acfPath,
    };
  }
  return null;
}

function parseAllAcfTimes(config) {
  const map = new Map();
  for (const lib of getWorkshopLibraries(config)) {
    const acfPath = path.join(lib, 'steamapps', 'workshop', `appworkshop_${ARMA_APP_ID}.acf`);
    for (const [id, time] of parseAcfTimes(acfPath)) {
      map.set(id, time);
    }
  }
  if (config.acfPath) {
    for (const [id, time] of parseAcfTimes(config.acfPath)) {
      if (!map.has(id)) map.set(id, time);
    }
  }
  return map;
}

function findModRoot(workshopFolder) {
  if (!fs.existsSync(workshopFolder)) return null;
  const queue = [workshopFolder];
  for (let depth = 0; depth < 5 && queue.length; depth++) {
    const levelCount = queue.length;
    for (let i = 0; i < levelCount; i++) {
      const dir = queue.shift();
      try {
        if (fs.existsSync(path.join(dir, 'addons'))) return dir;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
        }
      } catch {}
    }
  }
  return workshopFolder;
}

function parseAcfTimes(acfPath) {
  const map = new Map();
  if (!fs.existsSync(acfPath)) return map;
  const text = fs.readFileSync(acfPath, 'utf8');
  const re = /"(\d+)"\s*\{[^}]*"timeupdated"\s+"(\d+)"/gis;
  let m;
  while ((m = re.exec(text)) !== null) {
    map.set(m[1], parseInt(m[2], 10));
  }
  return map;
}

function fetchSteamFileDetails(ids) {
  return new Promise((resolve) => {
    if (!ids.length) return resolve({});
    const body = new URLSearchParams();
    body.set('itemcount', String(ids.length));
    ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

    const req = https.request(
      {
        hostname: 'api.steampowered.com',
        path: '/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body.toString()),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const out = {};
            for (const item of json?.response?.publishedfiledetails || []) {
              out[item.publishedfileid] = {
                title: item.title,
                timeUpdated: parseInt(item.time_updated, 10) || 0,
              };
            }
            resolve(out);
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on('error', () => resolve({}));
    req.write(body.toString());
    req.end();
  });
}

let modCheckCache = { key: '', at: 0, results: null };

async function checkMods(mods, config, { force = false } = {}) {
  syncWorkshopWithArma(config);
  const workshopDir = config.workshopDir;
  if (!fs.existsSync(workshopDir)) {
    return mods.map((m) => ({ ...m, status: 'missing', path: null }));
  }

  const acfMtime = fs.existsSync(config.acfPath) ? fs.statSync(config.acfPath).mtimeMs : 0;
  const cacheKey = `${workshopDir}:${acfMtime}:${mods.length}`;
  if (!force && modCheckCache.key === cacheKey && modCheckCache.results && Date.now() - modCheckCache.at < 300000) {
    return modCheckCache.results;
  }

  const acfTimes = parseAllAcfTimes(config);
  const remote = await fetchSteamFileDetails(mods.map((m) => m.workshopId));

  const results = mods.map((mod) => {
    const located = locateModFolder(mod.workshopId, config);
    const folder = located?.folder || path.join(workshopDir, mod.workshopId);
    const exists = Boolean(located && fs.existsSync(folder));
    const modPath = exists ? findModRoot(folder) : null;
    const localTime = acfTimes.get(mod.workshopId) || 0;
    const remoteTime = remote[mod.workshopId]?.timeUpdated || 0;
    let status = 'missing';
    if (exists && modPath) {
      status = remoteTime > localTime + 120 ? 'outdated' : 'ok';
    } else if (exists) {
      status = 'missing';
    }
    return { ...mod, status, path: modPath, localTime, remoteTime, folder };
  });

  modCheckCache = { key: cacheKey, at: Date.now(), results };
  return results;
}

function buildModParam(modResults) {
  return modResults
    .filter((m) => m.status !== 'missing' && m.path)
    .map((m) => m.path)
    .join(';');
}

function buildLaunchArgs(config, modParam) {
  const allowNoSplash = config.skipLogos === true;
  const args = [];

  // Логотипы BI: только по явному флагу. Оптимизированный запуск их НЕ пропускает.
  if (allowNoSplash) args.push('-noSplash');

  // Perf-флаги только при «Оптимизированный запуск» — иначе лишние -maxMem/-cpuCount
  // иногда дают долгий чёрный экран / «висящий» процесс без окна
  if (config.optimizedLaunch === true) {
    args.push('-noPause', ...performanceArgs(config));
  }

  const mode = config.screenMode || 'borderless';
  if (mode === 'windowed') args.push('-window');
  else if (mode === 'fullscreen') args.push('-fullscreen');
  else args.push('-noBorder');

  if (modParam) args.push(`-mod=${modParam}`);
  const name = String(config.playerName || config.armaProfileName || '').trim();
  // -name выбирает профиль; пробелы допустимы как один argv (spawn без shell)
  if (name) args.push(`-name=${name}`);

  if (config.serverHost) {
    args.push(`-connect=${config.serverHost}`);
    if (config.serverPort) args.push(`-port=${config.serverPort}`);
  }

  const password = String(config.serverPassword || '').trim();
  if (password) args.push(`-password=${password}`);

  // Сервер StarFront с BattlEye — -noBattlEye даёт SEH/краш при входе
  // (флаг в настройках больше не отключает BE при подключении к серверу)

  args.push(...sanitizeExtraArgs(config.extraLaunchArgs, { allowNoSplash }));

  // Финальная страховка от запрещённых флагов (в т.ч. из старых пресетов)
  return args.filter((a) => !isBannedLaunchArg(a, { allowNoSplash }));
}

async function launchGame(config, modParam) {
  const armaExe = resolveArmaExe(config);
  if (!fs.existsSync(armaExe)) {
    throw new Error('Arma 3 не найдена. Установите игру через Steam.');
  }
  const armaDir = path.dirname(armaExe);
  removeSteamAppId(armaDir);
  await ensureSteamRunning(config);

  const args = buildLaunchArgs(config, modParam);

  return new Promise((resolve, reject) => {
    // Без windowsHide — иначе GUI иногда не появляется и процесс «висит» в фоне
    const child = spawn(armaExe, args, {
      cwd: armaDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        ...process.env,
        SteamAppId: String(ARMA_APP_ID),
        SteamGameId: String(ARMA_APP_ID),
      },
    });

    child.on('error', (err) => {
      reject(new Error(err?.message || 'Не удалось запустить Arma 3'));
    });

    const pid = child.pid;
    if (!pid) {
      reject(new Error('Arma 3 не стартовала (нет PID)'));
      return;
    }
    child.unref();
    resolve({
      ok: true,
      exe: path.basename(armaExe),
      pid,
      viaSteam: false,
      args,
    });
  });
}

async function openSteamSubscribe(workshopIds, config = {}) {
  const { syncWorkshopItems } = require('./steam-workshop.cjs');
  const ids = Array.isArray(workshopIds) ? workshopIds : [workshopIds];
  return syncWorkshopItems(ids, config);
}

module.exports = {
  autoResolvePaths,
  syncWorkshopWithArma,
  resolveArmaExe,
  checkMods,
  buildModParam,
  buildLaunchArgs,
  launchGame,
  openSteamSubscribe,
  findModRoot,
  ARMA_APP_ID,
  PERFORMANCE_PRESETS,
};
