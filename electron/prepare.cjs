const arma = require('./arma.cjs');
const { ensureTeamSpeak } = require('./teamspeak.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollModsReady(mods, config, missingIds, onProgress, maxWaitMs = 900000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const checked = await arma.checkMods(mods, config, { force: true });
    const stillMissing = checked.filter((m) => m.status === 'missing');
    const done = missingIds.length - stillMissing.length;
    onProgress(
      Math.min(85, 45 + Math.round((done / Math.max(missingIds.length, 1)) * 40)),
      `Загрузка модов в Steam… (${done}/${missingIds.length})`
    );
    if (!stillMissing.length) return checked;
    await sleep(10000);
  }
  return arma.checkMods(mods, config, { force: true });
}

function formatMissingNames(mods) {
  return mods
    .slice(0, 6)
    .map((m) => m.name || m.workshopId)
    .join(', ');
}

async function prepareAndLaunch({ mods, config, onProgress, onDiscordRefresh }) {
  onProgress(3, 'Проверка путей Arma 3…');
  if (!config.armaExe || !config.workshopDir) {
    return { ok: false, error: 'Укажите пути к Arma 3 и Workshop в настройках лаунчера.' };
  }
  if (!config.acfPath && config.steamPath) {
    config.acfPath = require('path').join(
      config.steamPath,
      'steamapps',
      'workshop',
      `appworkshop_${require('./paths.cjs').ARMA_APP_ID}.acf`
    );
  }

  if (onDiscordRefresh) {
    onDiscordRefresh().catch(() => {});
  }

  // Старый runtime @SF_CHAR_MENU больше не используется — подчистить, если остался
  try {
    require('./sfcm-menu.cjs').cleanupMenuMod();
  } catch {}

  onProgress(10, 'Синхронизация с Arma 3…');
  arma.syncWorkshopWithArma(config);

  onProgress(18, 'Проверка модов…');
  let checked = await arma.checkMods(mods, config, { force: true });
  let missing = checked.filter((m) => m.status === 'missing');
  const outdated = checked.filter((m) => m.status === 'outdated');

  const toSync = [...new Set([...outdated, ...missing].map((m) => m.workshopId))];
  if (toSync.length) {
    onProgress(28, `Загрузка ${toSync.length} мод(ов) через Steam…`);
    await arma.openSteamSubscribe(toSync, config);
    onProgress(34, 'Steam качает моды — подождите…');
    await sleep(15000);
    checked = await arma.checkMods(mods, config, { force: true });
    missing = checked.filter((m) => m.status === 'missing');
  }

  if (missing.length) {
    onProgress(36, `Повтор для ${missing.length} мод(ов)…`);
    await arma.openSteamSubscribe(
      missing.map((m) => m.workshopId),
      config
    );
    await sleep(15000);
    checked = await arma.checkMods(mods, config, { force: true });
    missing = checked.filter((m) => m.status === 'missing');
  }

  if (missing.length) {
    onProgress(40, 'Ожидание загрузки модов…');
    checked = await pollModsReady(
      mods,
      config,
      missing.map((m) => m.workshopId),
      onProgress
    );
    const stillMissing = checked.filter((m) => m.status === 'missing');
    if (stillMissing.length) {
      return {
        ok: false,
        error: `Не установлено модов: ${stillMissing.length} (${formatMissingNames(stillMissing)}). Откройте Steam → Загрузки и дождитесь окончания.`,
        mods: checked,
        missing: stillMissing,
      };
    }
  }

  const stillOutdated = checked.filter((m) => m.status === 'outdated');
  if (stillOutdated.length) {
    onProgress(88, 'Часть модов ещё обновляется — запуск с установленными…');
    await sleep(1500);
  }

  onProgress(90, 'TeamSpeak и TFAR…');
  try {
    const ts = await ensureTeamSpeak({
      workshopDir: config.workshopDir,
      onProgress: (msg) => onProgress(91, msg),
      password: config.teamspeakPassword,
    });
    if (ts.warnings?.length) {
      onProgress(92, ts.warnings[0]);
    }
  } catch (e) {
    onProgress(92, `TeamSpeak: ${e.message || 'пропуск'}`);
  }

  onProgress(95, 'Запуск Arma 3…');
  const modParam = arma.buildModParam(checked);
  const skipped = checked.filter((m) => m.status === 'missing' || !m.path);
  if (skipped.length) {
    onProgress(94, `В запуск без ${skipped.length} мод(ов) — проверьте Steam`);
  }
  const launchResult = await arma.launchGame(config, modParam);
  onProgress(100, 'Игра запускается');
  return {
    ok: true,
    pid: launchResult.pid,
    modCount: modParam.split(';').filter(Boolean).length,
  };
}

module.exports = { prepareAndLaunch };
