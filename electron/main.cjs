const { app, BrowserWindow, ipcMain, shell, Notification, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');
const { loadPreset, resolvePresetPath } = require('./preset.cjs');
const { derivePathsFromArmaExe, derivePathsFromSteamLibrary, validateGamePaths, detectGamePaths, ARMA_APP_ID } = require('./paths.cjs');
const arma = require('./arma.cjs');
const discord = require('./discord.cjs');
const { prepareAndLaunch } = require('./prepare.cjs');
const { getArmaProfileInfo, listPlayerProfiles } = require('./arma-profiles.cjs');
const { createPlayerProfile, FACE_NAMES } = require('./profile-create.cjs');
const guideContent = require('./guide-content.cjs');
const { resolveDiscordUserId } = require('./discord-resolve.cjs');
const { loginWithDiscord, getDiscordOAuthSetup } = require('./discord-auth.cjs');
const { resolveOnlineStatus, mergeOnlinePayload } = require('./server-query.cjs');
const { createPlaytimeTracker } = require('./rim-playtime.cjs');
const { checkForUpdates } = require('./updater.cjs');
const { downloadFile, verifySha512, applyPortableUpdate } = require('./update-install.cjs');
const { execSync } = require('child_process');

const APP_VERSION = require('../package.json').version;

const SERVER_HOST = '109.248.4.45';
const SERVER_PORT = 2302;
const BOT_API_URL = discord.DEFAULT_API;

const STORE_KEYS = new Set([
  'armaExe', 'steamPath', 'workshopDir', 'serverPassword', 'teamspeakPassword', 'playerName', 'activeProfileId',
  'discordUserId', 'discordUsername', 'discordOAuthLinked', 'extraLaunchArgs', 'blurAmount', 'scanlineIntensity', 'animationsEnabled',
  'battlEye', 'optimizedLaunch', 'screenMode', 'performancePreset', 'cpuCount', 'maxMem',
  'maxVram', 'exThreads', 'tutorialComplete', 'showEventAnnouncement', 'showEventCalendar',
  'eventNotificationsEnabled', 'showHolonetOnHome', 'presetPath',
  'skipIntro', 'skipLogos', 'staticMenuBackground', 'pathsConfigured', 'newbiePromptComplete',
]);

const store = new Store({
  defaults: {
    armaExe: '',
    steamPath: '',
    workshopDir: '',
    serverPassword: '',
    teamspeakPassword: 'StarFront',
    playerName: '',
    activeProfileId: '',
    discordUserId: '',
    discordUsername: '',
    discordOAuthLinked: false,
    extraLaunchArgs: '',
    blurAmount: 4,
    scanlineIntensity: 0.35,
    animationsEnabled: true,
    battlEye: true,
    optimizedLaunch: false,
    screenMode: 'borderless',
    performancePreset: 'high',
    cpuCount: 0,
    maxMem: 0,
    maxVram: 0,
    exThreads: 0,
    tutorialComplete: false,
    newbiePromptComplete: false,
    showEventAnnouncement: true,
    showEventCalendar: true,
    eventNotificationsEnabled: true,
    showHolonetOnHome: true,
    presetPath: '',
    skipIntro: false,
    skipLogos: false,
    staticMenuBackground: false,
    pathsConfigured: false,
    playtimeAccumulatedMs: 0,
    clientId: '',
  },
});

function ensureClientId() {
  let id = String(store.get('clientId') || '').trim();
  if (!id) {
    id = crypto.randomUUID();
    store.set('clientId', id);
  }
  return id;
}

ensureClientId();

if (store.get('skipLogosMigrated_v16') !== true) {
  // Старый дефолт skipLogos=true ломал интро/логотипы — сбрасываем один раз
  store.set('skipLogos', false);
  store.set('skipLogosMigrated_v16', true);
}

if (
  store.get('newbiePromptComplete') !== true &&
  store.get('pathsConfigured') === true &&
  store.get('tutorialComplete') === true
) {
  store.set('newbiePromptComplete', true);
}

let onlinePollTimer = null;
let cachedDiscordData = null;
let cachedPaths = null;
let pathsResolvedAt = 0;
let mainWindow = null;
let cachedMods = [];
let gameWatchTimer = null;
let playtimeTracker = null;
let armaRunningCache = { at: 0, value: false };
let appQuitting = false;

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', windowsHide: true });
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

function isArmaRunning(force = false) {
  if (!force && Date.now() - armaRunningCache.at < 4000) {
    return armaRunningCache.value;
  }
  let running = false;
  try {
    for (const exe of ['arma3_x64.exe', 'arma3_x64_profiling.exe', 'arma3.exe']) {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`, {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (out.toLowerCase().includes(exe)) {
        running = true;
        break;
      }
    }
  } catch {}
  armaRunningCache = { at: Date.now(), value: running };
  return running;
}

function watchGameProcess(pid, webContents) {
  if (gameWatchTimer) clearInterval(gameWatchTimer);
  if (!webContents) return;

  let seenRunning = false;
  const startedAt = Date.now();

  gameWatchTimer = setInterval(() => {
    const pidRunning = pid ? isProcessRunning(pid) : false;
    const armaRunning = isArmaRunning();

    if (pidRunning || armaRunning) {
      if (!seenRunning) {
        seenRunning = true;
        if (!webContents.isDestroyed()) {
          webContents.send('launch-running');
        }
      }
    }

    if (seenRunning && !pidRunning && !armaRunning) {
      clearInterval(gameWatchTimer);
      gameWatchTimer = null;
      if (!webContents.isDestroyed()) {
        webContents.send('launch-reset');
      }
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
      }
      return;
    }

    if (!seenRunning && Date.now() - startedAt > 120000 && !pidRunning && !armaRunning) {
      clearInterval(gameWatchTimer);
      gameWatchTimer = null;
    }
  }, 4000);
}

function startPlaytimeTracker() {
  if (playtimeTracker) return;
  playtimeTracker = createPlaytimeTracker({
    store,
    isArmaRunning,
    claimReward: async () => {
      const uid = await ensureDiscordUserId([], { allowResolve: false });
      if (!uid) return { success: false, error: 'not_linked' };
      return discord.claimPlaytimeRimPoint(uid, apiBase());
    },
    onPointsEarned: (result) => {
      if (cachedDiscordData?.profile) {
        cachedDiscordData.profile.rim_points = result.rim_points;
        cachedDiscordData = enrichDiscordData(cachedDiscordData);
        mainWindow?.webContents.send('discord-data', cachedDiscordData);
      }
      mainWindow?.webContents.send('rim-point-earned', result);
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'StarFront',
          body: `+${result.added || 1} STAR POINT за час в Arma 3 · баланс: ${result.rim_points ?? '?'}`,
        });
        n.show();
      }
    },
    onClaimFailed: (result) => {
      if (!Notification.isSupported()) return;
      let body = 'Не удалось начислить STAR POINT за время в игре.';
      if (result.error === 'not_linked') {
        body = 'Привяжите Discord в лаунчере — без этого STAR POINT за игру не начисляются.';
      } else if (result.error === 'endpoint_missing' || result.statusCode === 404) {
        body = 'Rim API: начисление за игру недоступно — перезапустите text_bot на сервере.';
      } else if (result.error) {
        body = `Rim API: ${result.error}`;
      }
      const n = new Notification({ title: 'StarFront', body });
      n.show();
    },
  });
  playtimeTracker.start();
}

function getLinkedDiscordUserId() {
  if (!store.get('discordOAuthLinked')) return '';
  const stored = store.get('discordUserId');
  return stored ? String(stored) : '';
}

async function ensureDiscordUserId(extraNames = [], { allowResolve = true } = {}) {
  const linked = getLinkedDiscordUserId();
  if (linked) return linked;

  if (!allowResolve) return '';

  const stored = store.get('discordUserId');
  if (stored && store.get('discordOAuthLinked')) return String(stored);

  const armaInfo = getArmaProfileInfo({
    playerName: store.get('playerName'),
    profileId: store.get('activeProfileId'),
  });
  const candidates = [
    armaInfo.displayName,
    store.get('playerName'),
    ...(Array.isArray(extraNames) ? extraNames : []),
  ]
    .map((n) => String(n || '').trim())
    .filter((n) => n && n !== '—');
  const unique = [...new Set(candidates)];

  if (unique.length) {
    try {
      const id = await resolveDiscordUserId(unique[0], apiBase(), unique.slice(1));
      if (id) {
        return id;
      }
    } catch (e) {
      console.error('resolve discord:', e);
    }
  }

  return '';
}

function apiBase() {
  return BOT_API_URL;
}

function maybeMigratePathsConfigured() {
  if (store.get('pathsConfigured')) return;
  const validation = validateGamePaths({
    armaExe: store.get('armaExe'),
    workshopDir: store.get('workshopDir'),
  });
  if (validation.valid) store.set('pathsConfigured', true);
}

function buildPathPayload(resolved) {
  const armaExe = store.get('armaExe') || resolved.armaExe || '';
  const steamPath = store.get('steamPath') || resolved.steamPath || '';
  const workshopDir = store.get('workshopDir') || resolved.workshopDir || '';
  const acfPath =
    resolved.acfPath ||
    (steamPath ? path.join(steamPath, 'steamapps', 'workshop', `appworkshop_${ARMA_APP_ID}.acf`) : '');
  const validation = validateGamePaths({ armaExe, workshopDir });
  return {
    armaExe,
    steamPath,
    workshopDir,
    acfPath,
    pathsValid: validation.valid,
    pathErrors: validation.errors,
  };
}

async function ensurePaths(force = false) {
  if (!force && cachedPaths && Date.now() - pathsResolvedAt < 60000) {
    return cachedPaths;
  }
  maybeMigratePathsConfigured();

  const stored = {
    armaExe: store.get('armaExe'),
    steamPath: store.get('steamPath'),
    workshopDir: store.get('workshopDir'),
  };
  const manual = store.get('pathsConfigured') === true;
  const resolved = await arma.autoResolvePaths(stored);

  if (manual) {
    cachedPaths = buildPathPayload(resolved);
  } else {
    cachedPaths = {
      ...buildPathPayload(resolved),
      suggested: {
        armaExe: resolved.armaExe || '',
        steamPath: resolved.steamPath || resolved.suggestedSteamPath || '',
        workshopDir: resolved.workshopDir || '',
      },
    };
  }

  pathsResolvedAt = Date.now();
  return cachedPaths;
}

function getConfig() {
  const p = cachedPaths || {};
  const armaInfo = getArmaProfileInfo({
    playerName: store.get('playerName'),
    profileId: store.get('activeProfileId'),
  });
  return {
    armaExe: store.get('armaExe') || p.armaExe,
    steamPath: store.get('steamPath') || p.steamPath,
    workshopDir: store.get('workshopDir') || p.workshopDir,
    acfPath: p.acfPath,
    serverHost: SERVER_HOST,
    serverPort: SERVER_PORT,
    serverPassword: store.get('serverPassword'),
    teamspeakPassword: store.get('teamspeakPassword') != null ? store.get('teamspeakPassword') : 'StarFront',
    playerName: store.get('playerName') || armaInfo.displayName,
    armaProfileName: armaInfo.displayName,
    extraLaunchArgs: store.get('extraLaunchArgs'),
    blurAmount: store.get('blurAmount'),
    scanlineIntensity: store.get('scanlineIntensity'),
    animationsEnabled: store.get('animationsEnabled'),
    battlEye: store.get('battlEye') !== false,
    optimizedLaunch: store.get('optimizedLaunch') === true,
    screenMode: store.get('screenMode') || 'borderless',
    performancePreset: store.get('performancePreset') || 'high',
    cpuCount: store.get('cpuCount') || 0,
    maxMem: store.get('maxMem') || 0,
    maxVram: store.get('maxVram') || 0,
    exThreads: store.get('exThreads') || 0,
    skipIntro: false,
    skipLogos: store.get('skipLogos') === true,
    staticMenuBackground: false,
  };
}

function settingsPayload() {
  const presetPath = getPresetPath();
  const pathInfo = cachedPaths || {};
  return {
    ...getConfig(),
    ...store.store,
    clientId: ensureClientId(),
    appVersion: APP_VERSION,
    presetPath,
    defaultPresetPath: resolvePresetPath({
      cwd: process.cwd(),
      resources: process.resourcesPath,
      dirname: __dirname,
    }),
    modCount: cachedMods.length,
    paths: pathInfo,
    pathsConfigured: store.get('pathsConfigured') === true,
    pathsValid: pathInfo.pathsValid === true,
    newbiePromptComplete: store.get('newbiePromptComplete') === true,
    tutorialComplete: store.get('tutorialComplete') === true,
    pathErrors: pathInfo.pathErrors || [],
    profiles: listPlayerProfiles().slice(0, 30),
    faceNames: FACE_NAMES,
    guideStatic: guideContent,
  };
}

function mergeProfile(discordData) {
  const armaInfo = getArmaProfileInfo({
    playerName: store.get('playerName'),
    profileId: store.get('activeProfileId'),
  });
  const d = discordData?.profile || {};
  const verified = Boolean(d.character_verified);
  const rankFromArma = !verified && armaInfo.rank && armaInfo.rank !== '—' ? armaInfo.rank : null;
  const discordFaction = d.faction && d.faction !== '—' ? d.faction : null;
  return {
    ...d,
    display_name: verified
      ? d.display_name || armaInfo.displayName || 'Гость'
      : armaInfo.displayName || d.display_name || 'Гость',
    in_game_name: verified
      ? d.in_game_name || armaInfo.inGameName
      : armaInfo.inGameName || d.in_game_name,
    rank: (d.rank && d.rank !== '—' ? d.rank : null) || rankFromArma || '—',
    faction: discordFaction || '—',
    role: (d.role && d.role !== '—' ? d.role : null) || rankFromArma || '—',
    specialty: d.specialty || null,
    character_verified: verified,
    rim_points: d.rim_points ?? 0,
    arma_profiles: armaInfo.profiles || [],
    active_profile_id: armaInfo.found ? armaInfo.profilePath : null,
  };
}

function enrichDiscordData(data) {
  if (!data) return data;
  return { ...data, profile: mergeProfile(data) };
}

function startOnlinePolling() {
  if (onlinePollTimer) clearInterval(onlinePollTimer);
  const poll = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const onlinePayload = await resolveOnlineStatus(SERVER_HOST, SERVER_PORT);
      if (cachedDiscordData) cachedDiscordData.online = onlinePayload;
      mainWindow.webContents.send('online-update', onlinePayload);
    } catch {}
  };
  poll();
  onlinePollTimer = setInterval(poll, 8000);
}

async function bootstrapDiscordData() {
  try {
    const localOnline = await resolveOnlineStatus(SERVER_HOST, SERVER_PORT);
    let directNews = [];
    let directHolonet = [];
    try {
      const { fetchNewsDirect, fetchHolonetDirect } = require('./discord-direct.cjs');
      [directNews, directHolonet] = await Promise.all([
        fetchNewsDirect().catch(() => []),
        fetchHolonetDirect().catch(() => []),
      ]);
    } catch {}

    cachedDiscordData = enrichDiscordData({
      success: true,
      online: localOnline,
      profile: {},
      news: directNews,
      holonet: directHolonet,
    });
    mainWindow?.webContents.send('discord-data', cachedDiscordData);
    startOnlinePolling();

    const armaInfo = getArmaProfileInfo({
      playerName: store.get('playerName'),
      profileId: store.get('activeProfileId'),
    });
    const playerName = armaInfo.displayName || store.get('playerName') || '';
    await ensureDiscordUserId();
    const discordUserId = store.get('discordUserId');

    const statusPromise = discord.fetchLauncherStatus(discordUserId, apiBase(), playerName);
    const full = await Promise.race([
      statusPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 9000)),
    ]).catch(() => null);

    if (full) {
      cachedDiscordData = enrichDiscordData(full);
      if (cachedDiscordData?.profile?.discord_id && store.get('discordOAuthLinked')) {
        store.set('discordUserId', cachedDiscordData.profile.discord_id);
      }
      cachedDiscordData.online = mergeOnlinePayload(cachedDiscordData.online, localOnline);
      mainWindow?.webContents.send('discord-data', cachedDiscordData);
    }
  } catch (e) {
    console.error(e);
    if (!onlinePollTimer) startOnlinePolling();
  }
}

function getPresetPath() {
  const custom = store.get('presetPath');
  if (custom && fs.existsSync(custom)) return custom;
  return resolvePresetPath({
    cwd: process.cwd(),
    resources: process.resourcesPath,
    dirname: __dirname,
  });
}

function loadModsList() {
  const presetPath = getPresetPath();
  if (!fs.existsSync(presetPath)) throw new Error(`Пресет не найден: ${presetPath}`);
  cachedMods = loadPreset(presetPath);
  return cachedMods;
}

function installYoutubeRefererFix() {
  // Packaged app loads from file:// — Chromium sends no Referer to YouTube iframes → Error 153.
  const filter = {
    urls: [
      '*://*.youtube.com/*',
      '*://*.youtube-nocookie.com/*',
      '*://*.googlevideo.com/*',
      '*://*.ytimg.com/*',
    ],
  };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders };
    const referer = headers.Referer || headers.referer || '';
    if (!referer || referer.startsWith('file://') || referer === 'null') {
      headers.Referer = 'https://www.youtube-nocookie.com/';
    }
    callback({ requestHeaders: headers });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    backgroundColor: '#020810',
    icon: path.join(__dirname, '..', 'public', 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow.on('close', (event) => {
    if (appQuitting || !isArmaRunning(true)) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

app.whenReady().then(async () => {
  installYoutubeRefererFix();
  try {
    loadModsList();
  } catch (e) {
    console.error(e);
  }
  await ensurePaths();
  createWindow();
  startPlaytimeTracker();
  mainWindow.webContents.once('did-finish-load', () => {
    void bootstrapDiscordData();
    void checkForUpdates(APP_VERSION)
      .then((info) => {
        if (info?.updateAvailable && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-available', info);
        }
      })
      .catch(() => {});
  });
});

app.on('before-quit', () => {
  appQuitting = true;
  if (onlinePollTimer) clearInterval(onlinePollTimer);
  if (gameWatchTimer) clearInterval(gameWatchTimer);
  playtimeTracker?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isArmaRunning(true)) app.quit();
});

ipcMain.handle('get-mods', () => {
  if (!cachedMods.length) loadModsList();
  return cachedMods;
});

ipcMain.handle('get-settings', async () => {
  await ensurePaths();
  return settingsPayload();
});

ipcMain.handle('save-settings', async (_, settings) => {
  const oldPreset = store.get('presetPath');
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && STORE_KEYS.has(key)) store.set(key, value);
  }
  // Интро всегда включено — игнорируем старые сохранённые флаги
  store.set('skipIntro', false);
  store.set('staticMenuBackground', false);
  store.set('battlEye', true);
  if (settings.extraLaunchArgs !== undefined) {
    const cleaned = String(settings.extraLaunchArgs || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((a) => {
        const low = a.toLowerCase();
        return !low.includes('skipintro') && !low.includes('world=empty') && low !== '-world=empty';
      })
      .join(' ');
    store.set('extraLaunchArgs', cleaned);
  }
  if (settings.serverPassword !== undefined) {
    store.set('serverPassword', String(settings.serverPassword || '').trim());
  }
  if (settings.teamspeakPassword !== undefined) {
    store.set('teamspeakPassword', String(settings.teamspeakPassword || '').trim());
  }
  if (settings.presetPath !== undefined && settings.presetPath !== oldPreset) {
    try {
      loadModsList();
    } catch (e) {
      console.error(e);
    }
  }
  await ensurePaths();
  const payload = settingsPayload();
  if (cachedDiscordData) {
    cachedDiscordData = enrichDiscordData({ ...cachedDiscordData });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('discord-data', cachedDiscordData);
    }
  }
  return payload;
});

ipcMain.handle('get-discord-user-id', async (_, extraNames, opts) => ensureDiscordUserId(extraNames, opts));

ipcMain.handle('discord-oauth-setup', async () => {
  try {
    return { success: true, ...(await getDiscordOAuthSetup(apiBase())) };
  } catch (e) {
    return { success: false, error: e.message || 'Ошибка' };
  }
});

ipcMain.handle('discord-auth-status', () => ({
  linked: Boolean(store.get('discordOAuthLinked') && store.get('discordUserId')),
  discordUserId: getLinkedDiscordUserId(),
  discordUsername: store.get('discordUsername') || '',
}));

ipcMain.handle('discord-auth-login', async () => {
  try {
    const result = await loginWithDiscord(apiBase(), shell, mainWindow);
    store.set('discordUserId', result.discordUserId);
    store.set('discordUsername', result.discordUsername);
    store.set('discordOAuthLinked', true);

    const response = {
      success: true,
      discordUserId: result.discordUserId,
      discordUsername: result.discordUsername,
      guildWarning: result.guildWarning || '',
    };

    setImmediate(async () => {
      try {
        const armaInfo = getArmaProfileInfo({
          playerName: store.get('playerName'),
          profileId: store.get('activeProfileId'),
        });
        const playerName = armaInfo.displayName || store.get('playerName') || '';
        const clientId = ensureClientId();
        discord.registerLauncherClient(clientId, result.discordUserId, apiBase()).catch(() => {});
        cachedDiscordData = enrichDiscordData(
          await discord.fetchLauncherStatus(result.discordUserId, apiBase(), playerName, clientId)
        );
        mainWindow?.webContents.send('discord-data', cachedDiscordData);
        mainWindow?.webContents.send('discord-auth-updated', response);
      } catch (e) {
        console.error('discord refresh after login:', e);
      }
    });

    return response;
  } catch (e) {
    return { success: false, error: e.message || 'Ошибка авторизации Discord' };
  }
});

ipcMain.handle('discord-auth-logout', async () => {
  store.set('discordUserId', '');
  store.set('discordUsername', '');
  store.set('discordOAuthLinked', false);
  return { success: true };
});

ipcMain.handle('create-profile', async (_, { nickname, faceIndex }) => {
  const result = createPlayerProfile({ nickname, faceIndex });
  if (result.ok && result.profile) {
    store.set('activeProfileId', result.profile.id);
    store.set('playerName', result.profile.displayName);
    if (!store.get('discordOAuthLinked')) {
      store.set('discordUserId', '');
    }
  }
  return result;
});

ipcMain.handle('get-guide', async () => {
  try {
    const remote = await discord.fetchGuide(apiBase());
    return { ...guideContent, remote };
  } catch {
    return { ...guideContent, remote: null };
  }
});

ipcMain.handle('get-events', () => discord.fetchEvents(apiBase()));
ipcMain.handle('create-donation', (_, payload) => discord.createDonation(payload, apiBase()));
ipcMain.handle('get-active-donation', (_, discordUserId) => discord.getActiveDonation(discordUserId, apiBase()));
ipcMain.handle('fetch-donation-messages', (_, orderId) => discord.fetchDonationMessages(orderId, apiBase()));
ipcMain.handle('donation-send', (_, orderId, payload) => discord.donationSend(orderId, payload, apiBase()));
ipcMain.handle('cancel-donation', (_, orderId, payload) => discord.cancelDonation(orderId, payload, apiBase()));
ipcMain.handle('check-donation-payment', (_, orderId, payload) =>
  discord.checkDonationPayment(orderId, payload, apiBase())
);
ipcMain.handle('get-active-leave', (_, discordUserId) => discord.fetchActiveLeaveRequest(discordUserId, apiBase()));
ipcMain.handle('create-leave-request', (_, payload) => discord.createLeaveRequest(payload, apiBase()));
ipcMain.handle('leave-send', (_, reqId, payload) => discord.sendLeaveMessage(reqId, payload, apiBase()));
ipcMain.handle('get-unit-list', () => discord.fetchUnitList(apiBase()));
ipcMain.handle('get-active-unit-application', (_, opts) =>
  discord.fetchActiveUnitApplication(opts, apiBase())
);
ipcMain.handle('create-unit-application', (_, payload) => discord.createUnitApplication(payload, apiBase()));
ipcMain.handle('unit-application-messages', (_, appId, discordUserId) =>
  discord.fetchUnitApplicationMessages(appId, discordUserId, apiBase())
);
ipcMain.handle('unit-application-send', (_, appId, payload) =>
  discord.sendUnitApplicationMessage(appId, payload, apiBase())
);
ipcMain.handle('withdraw-unit-application', (_, appId, payload) =>
  discord.withdrawUnitApplication(appId, payload, apiBase())
);
ipcMain.handle('submit-unit-role-request', (_, appId, payload) =>
  discord.submitUnitRoleRequest(appId, payload, apiBase())
);
ipcMain.handle('submit-character-verification', (_, payload) =>
  discord.submitCharacterVerification(payload, apiBase())
);
ipcMain.handle('get-character-verification', async () => {
  const uid = store.get('discordUserId');
  return discord.getCharacterVerification(uid, apiBase());
});
ipcMain.handle('select-character-verification', async (_, payload) => {
  const uid = store.get('discordUserId');
  return discord.selectCharacterVerification(
    { ...(payload || {}), discord_user_id: (payload && payload.discord_user_id) || uid },
    apiBase()
  );
});
ipcMain.handle('cancel-character-verification', async (_, payload) => {
  const uid = store.get('discordUserId');
  return discord.cancelCharacterVerification(
    { ...(payload || {}), discord_user_id: (payload && payload.discord_user_id) || uid },
    apiBase()
  );
});
ipcMain.handle('get-support-online', () => discord.fetchSupportOnline(apiBase()));
ipcMain.handle('get-active-ticket', (_, discordUserId) => discord.fetchActiveTicket(discordUserId, apiBase()));
ipcMain.handle('create-ticket', (_, payload) => discord.createTicket(payload, apiBase()));
ipcMain.handle('ticket-messages', (_, ticketId) => discord.fetchTicketMessages(ticketId, apiBase()));
ipcMain.handle('ticket-send', (_, ticketId, payload) => discord.sendTicketMessage(ticketId, payload, apiBase()));
ipcMain.handle('ticket-close', (_, ticketId, payload) => discord.closeTicket(ticketId, payload, apiBase()));
ipcMain.handle('ticket-rate', (_, ticketId, payload) => discord.rateTicket(ticketId, payload, apiBase()));
ipcMain.handle('submit-suggestion', (_, payload) => discord.submitSuggestion(payload, apiBase()));

ipcMain.handle('get-arma-profiles', () => listPlayerProfiles());

ipcMain.handle('fetch-discord-data', async () => {
  const armaInfo = getArmaProfileInfo({
    playerName: store.get('playerName'),
    profileId: store.get('activeProfileId'),
  });
  const playerName = armaInfo.displayName || store.get('playerName') || '';
  let discordUserId = await ensureDiscordUserId();
  const clientId = ensureClientId();

  cachedDiscordData = enrichDiscordData(
    await discord.fetchLauncherStatus(discordUserId, apiBase(), playerName, clientId)
  );

  const profileId = cachedDiscordData?.profile?.discord_id;
  if (profileId && store.get('discordOAuthLinked')) {
    store.set('discordUserId', profileId);
  } else if (!discordUserId && playerName && store.get('discordOAuthLinked')) {
    discordUserId = await ensureDiscordUserId([playerName]);
    if (discordUserId) {
      cachedDiscordData = enrichDiscordData(
        await discord.fetchLauncherStatus(discordUserId, apiBase(), playerName, clientId)
      );
    }
  }

  if (clientId) {
    discord.registerLauncherClient(clientId, getLinkedDiscordUserId(), apiBase()).catch(() => {});
  }

  const localOnline = await resolveOnlineStatus(SERVER_HOST, SERVER_PORT);
  cachedDiscordData.online = mergeOnlinePayload(cachedDiscordData.online, localOnline);

  return cachedDiscordData;
});

ipcMain.handle('get-discord-data', () => cachedDiscordData);

ipcMain.handle('prepare-launch', async (event) => {
  if (!cachedMods.length) loadModsList();
  await ensurePaths();
  const config = getConfig();

  const result = await prepareAndLaunch({
    mods: cachedMods,
    config,
    onProgress: (percent, message) => {
      event.sender.send('launch-progress', { percent, message });
    },
    onDiscordRefresh: async () => {
      const uid = await ensureDiscordUserId();
      const armaInfo = getArmaProfileInfo({
        playerName: store.get('playerName'),
        profileId: store.get('activeProfileId'),
      });
      const playerName = armaInfo.displayName || store.get('playerName') || '';
      cachedDiscordData = enrichDiscordData(
        await discord.fetchLauncherStatus(uid, apiBase(), playerName)
      );
    },
  });

  if (result.ok) {
    watchGameProcess(result.pid, event.sender);
  }

  return result;
});

ipcMain.handle('subscribe-mod', async (_, workshopId) => {
  await ensurePaths();
  await arma.openSteamSubscribe(workshopId, getConfig());
  return { ok: true };
});

ipcMain.handle('open-url', (_, url) => shell.openExternal(url));

ipcMain.handle('open-rp-rules-window', () => {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const rulesWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#020810',
    title: 'РП правила — StarFront',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (devUrl) {
    rulesWindow.loadURL(`${devUrl.replace(/\/$/, '')}/rp-rules.html`);
  } else {
    rulesWindow.loadFile(path.join(__dirname, '..', 'dist', 'rp-rules.html'));
  }
  return { ok: true };
});

function discordDeepLink(url) {
  const raw = String(url || '');
  const channelMatch = raw.match(/discord\.com\/channels\/(\d+)\/(\d+)/i);
  if (channelMatch) {
    return `discord://discord.com/channels/${channelMatch[1]}/${channelMatch[2]}`;
  }
  const inviteMatch =
    raw.match(/discord\.gg\/([A-Za-z0-9-]+)/i) || raw.match(/discord\.com\/invite\/([A-Za-z0-9-]+)/i);
  if (inviteMatch) return `discord://discord.com/invite/${inviteMatch[1]}`;
  return raw;
}

ipcMain.handle('open-discord-invite', (_, url) => {
  if (url) shell.openExternal(discordDeepLink(url));
  return { ok: true };
});

ipcMain.handle('auto-detect-game-paths', async (_, { save = false } = {}) => {
  const detected = await detectGamePaths();
  const validation = validateGamePaths(detected);
  const result = {
    success: validation.valid,
    canceled: false,
    ...detected,
    errors: validation.valid ? [] : validation.errors,
  };
  if (!save || !validation.valid) return result;

  store.set('armaExe', detected.armaExe);
  store.set('steamPath', detected.steamPath);
  store.set('workshopDir', detected.workshopDir);
  store.set('pathsConfigured', true);
  cachedPaths = null;
  pathsResolvedAt = 0;
  await ensurePaths(true);
  return { ...result, settings: settingsPayload() };
});

ipcMain.handle('pick-arma-exe', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите arma3_x64.exe',
    filters: [{ name: 'Arma 3', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { success: false, canceled: true };
  const derived = derivePathsFromArmaExe(result.filePaths[0]);
  const validation = validateGamePaths(derived);
  return { success: validation.valid, canceled: false, ...derived, errors: validation.errors };
});

ipcMain.handle('pick-steam-library', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку библиотеки Steam (где лежит steamapps)',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { success: false, canceled: true };
  const picked = result.filePaths[0];
  const libraryRoot = fs.existsSync(path.join(picked, 'steamapps')) ? picked : path.dirname(picked);
  const derived = derivePathsFromSteamLibrary(libraryRoot);
  const validation = validateGamePaths(derived);
  return { success: validation.valid, canceled: false, ...derived, errors: validation.errors };
});

ipcMain.handle('pick-workshop-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку Workshop модов Arma 3',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { success: false, canceled: true };
  const workshopDir = result.filePaths[0];
  const validation = validateGamePaths({ armaExe: store.get('armaExe'), workshopDir });
  return {
    success: validation.valid,
    canceled: false,
    workshopDir,
    errors: validation.errors,
  };
});

ipcMain.handle('save-game-paths', async (_, payload = {}) => {
  const armaExe = String(payload.armaExe || '').trim();
  let steamPath = String(payload.steamPath || '').trim();
  let workshopDir = String(payload.workshopDir || '').trim();

  if (armaExe && (!steamPath || !workshopDir)) {
    const derived = derivePathsFromArmaExe(armaExe);
    if (!steamPath) steamPath = derived.steamPath;
    if (!workshopDir) workshopDir = derived.workshopDir;
  }

  const validation = validateGamePaths({ armaExe, workshopDir });
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  store.set('armaExe', armaExe);
  store.set('steamPath', steamPath);
  store.set('workshopDir', workshopDir);
  store.set('pathsConfigured', true);
  cachedPaths = null;
  pathsResolvedAt = 0;
  await ensurePaths(true);
  return { success: true, settings: settingsPayload() };
});

ipcMain.handle('pick-preset-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите HTML-пресет Arma 3',
    filters: [{ name: 'HTML preset', extensions: ['html'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { success: false, canceled: true };
  }
  const presetPath = result.filePaths[0];
  store.set('presetPath', presetPath);
  loadModsList();
  return {
    success: true,
    presetPath,
    modCount: cachedMods.length,
    mods: cachedMods,
  };
});

ipcMain.handle('reset-preset-path', async () => {
  store.set('presetPath', '');
  try {
    loadModsList();
  } catch (e) {
    return { success: false, error: e.message || 'Не удалось загрузить встроенный пресет' };
  }
  return { success: true, presetPath: '', modCount: cachedMods.length };
});

ipcMain.handle('check-for-updates', async () => checkForUpdates(APP_VERSION));

ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('open-update-page', (_, url) => {
  const target = String(url || '').trim();
  if (target) shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle('download-update', async (event, updateInfo) => {
  const url = String(updateInfo?.downloadUrl || '').trim();
  if (!url) return { ok: false, error: 'Нет ссылки на загрузку' };

  const safeVersion = String(updateInfo?.remoteVersion || 'update').replace(/[^\w.-]+/g, '_');
  const tempPath = path.join(app.getPath('temp'), `StarFrontLauncher-${safeVersion}.exe`);

  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    await downloadFile(url, tempPath, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('update-download-progress', progress);
      }
    });
    if (updateInfo?.sha512 && !verifySha512(tempPath, updateInfo.sha512)) {
      fs.unlinkSync(tempPath);
      return { ok: false, error: 'Файл обновления повреждён (проверка sha512)' };
    }
    return { ok: true, path: tempPath };
  } catch (e) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    return { ok: false, error: e.message || 'Ошибка загрузки' };
  }
});

ipcMain.handle('apply-update', async (_, downloadedPath) => {
  const src = String(downloadedPath || '').trim();
  if (!src || !fs.existsSync(src)) {
    return { ok: false, error: 'Файл обновления не найден' };
  }
  appQuitting = true;
  applyPortableUpdate(src, process.execPath);
  setTimeout(() => app.quit(), 500);
  return { ok: true };
});

ipcMain.handle('show-notification', (_, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title: title || 'StarFront', body: body || '' });
    n.show();
  }
  return { ok: true };
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => {
  if (isArmaRunning(true) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    return;
  }
  mainWindow?.close();
});
