import { useEffect, useState } from 'react';

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="setting-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

export default function SettingsPanel({ settings, onSave, onBack, api, discord, onOpenVerify }) {
  const [form, setForm] = useState({ ...settings });
  const [newNick, setNewNick] = useState('');
  const [newFace, setNewFace] = useState(0);
  const [profileMsg, setProfileMsg] = useState('');
  const [discordLinked, setDiscordLinked] = useState(false);
  const [discordUserId, setDiscordUserId] = useState('');
  const [discordUsername, setDiscordUsername] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authStatus, setAuthStatus] = useState('');
  const [authError, setAuthError] = useState('');
  const [presetMsg, setPresetMsg] = useState('');
  const [pathMsg, setPathMsg] = useState('');
  const [pathBusy, setPathBusy] = useState(false);
  const [characters, setCharacters] = useState(() => discord?.character_verifications || []);
  const [charMsg, setCharMsg] = useState('');
  const [charBusy, setCharBusy] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const profiles = form.profiles || [];
  const paths = form.paths || {};
  const faceNames = form.faceNames || [];

  const statusLabel = (s) =>
    ({ approved: 'Верифицирован', pending: 'Ожидает', rejected: 'Отклонён', superseded: 'Заменён' }[s] || s || '—');

  useEffect(() => {
    setForm((f) => ({ ...f, ...settings, clientId: settings.clientId || f.clientId }));
  }, [settings]);

  useEffect(() => {
    if (discord?.character_verifications) {
      setCharacters(discord.character_verifications);
    }
  }, [discord?.character_verifications]);

  useEffect(() => {
    (async () => {
      try {
        const auth = await api.getDiscordAuthStatus?.();
        if (auth) {
          setDiscordLinked(Boolean(auth.linked));
          setDiscordUserId(auth.discordUserId || '');
          setDiscordUsername(auth.discordUsername || '');
        }
        const res = await api.getCharacterVerification?.();
        if (res?.verifications) setCharacters(res.verifications);
      } catch {}
    })();
  }, [api]);

  const refreshCharacters = async () => {
    try {
      const res = await api.getCharacterVerification?.();
      if (res?.verifications) setCharacters(res.verifications);
      await api.fetchDiscordData?.();
    } catch {}
  };

  const selectCharacter = async (ver) => {
    if (!ver?.id || ver.status !== 'approved') return;
    setCharBusy(true);
    setCharMsg('');
    try {
      const res = await api.selectCharacterVerification?.({
        discord_user_id: discordUserId,
        verification_id: ver.id,
      });
      if (!res?.success) {
        setCharMsg(res?.error || 'Не удалось выбрать персонажа');
        return;
      }
      if (res.verifications) setCharacters(res.verifications);
      setCharMsg(`Активный: ${ver.character_nick || ver.profile_nickname}`);
      await api.fetchDiscordData?.();
    } catch (e) {
      setCharMsg(e?.message || 'Ошибка');
    } finally {
      setCharBusy(false);
    }
  };

  const createProfile = async () => {
    setProfileMsg('');
    const res = await api.createProfile({ nickname: newNick, faceIndex: newFace });
    if (res.ok) {
      setProfileMsg(`Профиль «${res.profile.displayName}» создан`);
      set('activeProfileId', res.profile.id);
      set('playerName', res.profile.displayName);
      const s = await api.getSettings();
      setForm((f) => ({ ...f, ...s, profiles: s.profiles }));
      setNewNick('');
    } else {
      setProfileMsg(res.error || 'Ошибка');
    }
  };

  const loginDiscord = async () => {
    setAuthLoading(true);
    setAuthError('');
    setAuthStatus('Откроется браузер Discord…');
    try {
      const res = await api.loginDiscord();
      if (!res?.success) {
        setAuthError(res?.error || 'Не удалось привязать Discord');
        setAuthStatus('');
        return;
      }
      setDiscordLinked(true);
      setDiscordUserId(res.discordUserId || '');
      setDiscordUsername(res.discordUsername || '');
      setAuthStatus(`Привязано: ${res.discordUsername || res.discordUserId}`);
      await api.fetchDiscordData?.();
    } catch (e) {
      setAuthError(e.message || 'Ошибка авторизации Discord');
      setAuthStatus('');
    } finally {
      setAuthLoading(false);
    }
  };

  const logoutDiscord = async () => {
    setAuthLoading(true);
    setAuthError('');
    try {
      await api.logoutDiscord?.();
      setDiscordLinked(false);
      setDiscordUserId('');
      setDiscordUsername('');
      setAuthStatus('Discord отвязан');
      window.location.reload();
    } catch (e) {
      setAuthError(e.message || 'Ошибка');
    } finally {
      setAuthLoading(false);
    }
  };

  const pickPreset = async () => {
    setPresetMsg('');
    const res = await api.pickPresetFile?.();
    if (res?.canceled) return;
    if (!res?.success) {
      setPresetMsg(res?.error || 'Не удалось загрузить пресет');
      return;
    }
    set('presetPath', res.presetPath);
    set('modCount', res.modCount);
    setPresetMsg(`Загружено модов: ${res.modCount}`);
  };

  const resetPreset = async () => {
    setPresetMsg('');
    const res = await api.resetPresetPath?.();
    if (!res?.success) {
      setPresetMsg(res?.error || 'Ошибка');
      return;
    }
    set('presetPath', '');
    set('modCount', res.modCount);
    setPresetMsg(`Встроенный пресет · модов: ${res.modCount}`);
  };

  const autoDetectPaths = async () => {
    setPathMsg('');
    setPathBusy(true);
    try {
      const res = await api.autoDetectGamePaths?.({ save: true });
      if (!res?.success) {
        setPathMsg(res?.errors?.join(' · ') || 'Arma 3 не найдена автоматически');
        return;
      }
      if (res.settings) {
        setForm((f) => ({ ...f, ...res.settings, paths: res.settings.paths }));
      } else {
        setForm((f) => ({
          ...f,
          armaExe: res.armaExe,
          steamPath: res.steamPath,
          workshopDir: res.workshopDir,
          paths: { ...paths, armaExe: res.armaExe, steamPath: res.steamPath, workshopDir: res.workshopDir },
        }));
      }
      setPathMsg('Пути найдены автоматически');
    } catch (e) {
      setPathMsg(e.message || 'Ошибка автопоиска');
    } finally {
      setPathBusy(false);
    }
  };

  const pickArmaExe = async () => {
    setPathMsg('');
    const res = await api.pickArmaExe?.();
    if (res?.canceled) return;
    if (!res?.success && res?.errors?.length) {
      setPathMsg(res.errors.join(' · '));
      return;
    }
    const saved = await api.saveGamePaths?.({
      armaExe: res.armaExe,
      steamPath: res.steamPath,
      workshopDir: res.workshopDir,
    });
    if (!saved?.success) {
      setPathMsg(saved?.errors?.join(' · ') || 'Не удалось сохранить');
      return;
    }
    setForm((f) => ({ ...f, ...saved.settings, paths: saved.settings.paths }));
    setPathMsg('Пути Arma 3 сохранены');
  };

  const pickSteamLibrary = async () => {
    setPathMsg('');
    const res = await api.pickSteamLibrary?.();
    if (res?.canceled) return;
    const saved = await api.saveGamePaths?.({
      armaExe: res.armaExe || form.armaExe || paths.armaExe,
      steamPath: res.steamPath,
      workshopDir: res.workshopDir,
    });
    if (!saved?.success) {
      setPathMsg(saved?.errors?.join(' · ') || 'Не удалось сохранить');
      return;
    }
    setForm((f) => ({ ...f, ...saved.settings, paths: saved.settings.paths }));
    setPathMsg('Папка Steam сохранена');
  };

  const pickWorkshopFolder = async () => {
    setPathMsg('');
    const res = await api.pickWorkshopFolder?.();
    if (res?.canceled) return;
    const saved = await api.saveGamePaths?.({
      armaExe: form.armaExe || paths.armaExe,
      steamPath: form.steamPath || paths.steamPath,
      workshopDir: res.workshopDir,
    });
    if (!saved?.success) {
      setPathMsg(saved?.errors?.join(' · ') || 'Не удалось сохранить');
      return;
    }
    setForm((f) => ({ ...f, ...saved.settings, paths: saved.settings.paths }));
    setPathMsg('Папка Workshop сохранена');
  };

  return (
    <div className="settings-overlay">
      <section className="settings-panel">
        <header className="settings-header">
          <button type="button" className="btn-ghost-sm" onClick={onBack}>
            ← Назад
          </button>
          <h2>НАСТРОЙКИ</h2>
        </header>

        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(form);
          }}
        >
          <div className="settings-block">
            <h3>Профиль Arma 3</h3>
            <p className="block-hint">Из «Документы → Arma 3 — Other Profiles». Звание по Уставу ВАР.</p>
            <label className="field">
              <span>Активный профиль</span>
              <select
                value={form.activeProfileId || ''}
                onChange={(e) => {
                  const id = e.target.value;
                  set('activeProfileId', id);
                  const p = profiles.find((x) => x.id === id);
                  if (p) set('playerName', p.displayName);
                }}
              >
                <option value="">Авто (последний)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} — {p.rank}
                  </option>
                ))}
              </select>
            </label>

            <div className="profile-create">
              <h4>Новый профиль</h4>
              <label className="field">
                <span>Никнейм</span>
                <input value={newNick} onChange={(e) => setNewNick(e.target.value)} placeholder="CT 1234 Nickname" />
              </label>
              <label className="field">
                <span>Лицо: {faceNames[newFace] || `#${newFace + 1}`}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, faceNames.length - 1)}
                  value={newFace}
                  onChange={(e) => setNewFace(parseInt(e.target.value, 10))}
                />
              </label>
              <button type="button" className="btn-ghost-sm" onClick={createProfile}>
                Создать профиль
              </button>
              {profileMsg && <p className="block-hint">{profileMsg}</p>}
            </div>
          </div>

          <div className="settings-block">
            <h3>ID клиента</h3>
            <p className="block-hint">
              Уникальный ID этой установки лаунчера. Передайте его модератору для зачисления STAR POINT
              (`/add_star_point`).
            </p>
            <div className="settings-actions-row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <code className="client-id-code">{form.clientId || '—'}</code>
              <button
                type="button"
                className="btn-ghost-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(String(form.clientId || ''));
                    setPathMsg('ID клиента скопирован');
                  } catch {
                    setPathMsg('Не удалось скопировать');
                  }
                }}
              >
                Копировать
              </button>
            </div>
          </div>

          <div className="settings-block">
            <h3>Discord</h3>
            <p className="block-hint">
              Привязка нужна для заявок в подразделение и доната. Откроется браузер — подтвердите вход на сервере StarFront.
            </p>
            {discordLinked ? (
              <p className="form-success">
                Аккаунт: <strong>{discordUsername || discordUserId}</strong>
              </p>
            ) : (
              <p className="block-hint">Discord не привязан</p>
            )}
            {authError && <p className="form-error">{authError}</p>}
            <div className="settings-actions-row">
              <button type="button" className="btn-save discord-login-btn" disabled={authLoading} onClick={loginDiscord}>
                {authLoading ? 'Авторизация…' : discordLinked ? 'Перепривязать Discord' : 'Привязать Discord'}
              </button>
              {discordLinked && (
                <button type="button" className="btn-ghost-sm" disabled={authLoading} onClick={logoutDiscord}>
                  Отвязать
                </button>
              )}
            </div>
          </div>

          <div className="settings-block">
            <h3>Персонажи</h3>
            <p className="block-hint">
              Список верифицированных и ожидающих. Активный персонаж отображается на карточке игрока.
            </p>
            {!discordLinked ? (
              <p className="block-hint">Сначала привяжите Discord</p>
            ) : characters.length === 0 ? (
              <p className="block-hint">Пока нет заявок — верифицируйте первого персонажа</p>
            ) : (
              <ul className="character-verify-list">
                {characters.map((v) => {
                  const active = Number(v.is_active) === 1 && v.status === 'approved';
                  const nick = v.character_nick || v.profile_nickname || `Заявка #${v.id}`;
                  return (
                    <li key={v.id} className={`character-verify-item${active ? ' is-active' : ''}`}>
                      <div className="character-verify-main">
                        <strong>{nick}</strong>
                        <span className={`character-verify-status status-${v.status || 'unknown'}`}>
                          {statusLabel(v.status)}
                          {active ? ' · активный' : ''}
                        </span>
                        <span className="character-verify-meta">
                          {v.faction || '—'}
                          {v.rank ? ` · ${v.rank}` : ''}
                        </span>
                      </div>
                      <div className="character-verify-actions">
                        {v.status === 'approved' && !active && (
                          <button
                            type="button"
                            className="btn-ghost-sm"
                            disabled={charBusy}
                            onClick={() => selectCharacter(v)}
                          >
                            Выбрать
                          </button>
                        )}
                        {v.status === 'approved' && (
                          <button
                            type="button"
                            className="btn-ghost-sm"
                            disabled={charBusy}
                            onClick={() => onOpenVerify?.({ mode: 'reverify', prefill: v })}
                          >
                            Переверифицировать
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="settings-actions-row">
              <button
                type="button"
                className="btn-save"
                disabled={!discordLinked}
                onClick={() =>
                  onOpenVerify?.({
                    mode: characters.some((c) => c.status === 'approved') ? 'additional' : 'new',
                    prefill: null,
                  })
                }
              >
                {characters.some((c) => c.status === 'approved')
                  ? 'Верифицировать ещё'
                  : 'Верифицировать персонажа'}
              </button>
              <button type="button" className="btn-ghost-sm" disabled={!discordLinked || charBusy} onClick={refreshCharacters}>
                Обновить
              </button>
            </div>
            {charMsg && <p className="block-hint">{charMsg}</p>}
          </div>

          <div className="settings-block">
            <h3>Пресет модов</h3>
            <p className="block-hint">HTML-пресет Arma 3 Workshop (.html). По умолчанию — встроенный rim_preset.</p>
            <div className="path-row">
              <span>Файл</span>
              <code>{form.presetPath || 'Встроенный пресет'}</code>
            </div>
            <p className="block-hint">Модов в пресете: {form.modCount ?? '—'}</p>
            <div className="settings-actions-row">
              <button type="button" className="btn-ghost-sm" onClick={pickPreset}>
                Выбрать файл…
              </button>
              {form.presetPath && (
                <button type="button" className="btn-ghost-sm" onClick={resetPreset}>
                  Сбросить на встроенный
                </button>
              )}
            </div>
            {presetMsg && <p className="block-hint">{presetMsg}</p>}
          </div>

          <div className="settings-block paths-block">
            <h3>Пути Arma 3 / Steam</h3>
            <p className="block-hint">Вручную или кнопка «Авто» — поиск по Steam на всех дисках.</p>
            <div className="settings-actions-row">
              <button type="button" className="btn-ghost-sm path-setup-auto-btn" disabled={pathBusy} onClick={autoDetectPaths}>
                {pathBusy ? 'Поиск…' : 'Авто'}
              </button>
            </div>
            <div className="path-row">
              <span>Arma 3</span>
              <code>{paths.armaExe || form.armaExe || '—'}</code>
            </div>
            <div className="path-row">
              <span>Steam</span>
              <code>{paths.steamPath || form.steamPath || '—'}</code>
            </div>
            <div className="path-row">
              <span>Workshop</span>
              <code>{paths.workshopDir || form.workshopDir || '—'}</code>
            </div>
            <div className="settings-actions-row">
              <button type="button" className="btn-ghost-sm" onClick={pickArmaExe}>
                Выбрать exe…
              </button>
              <button type="button" className="btn-ghost-sm" onClick={pickSteamLibrary}>
                Папка Steam…
              </button>
              <button type="button" className="btn-ghost-sm" onClick={pickWorkshopFolder}>
                Папка Workshop…
              </button>
            </div>
            {pathMsg && <p className="block-hint">{pathMsg}</p>}
          </div>

          <div className="settings-block">
            <h3>Запуск игры</h3>
            <label className="field">
              <span>Пароль сервера Arma</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.serverPassword || ''}
                onChange={(e) => set('serverPassword', e.target.value)}
                placeholder="Пароль сервера"
              />
            </label>
            <Toggle
              checked={form.autoConnectServer === true}
              onChange={(v) => set('autoConnectServer', v)}
              label="Сразу подключаться к серверу"
              hint="Выкл = сначала интро и меню (рекомендуется). Вкл = -connect без интро"
            />
            <p className="block-hint">
              Сервер: 109.248.4.45:2302 · пароль из поля выше. При выключенном автоподключении зайдите через
              мультиплеер Arma после интро.
            </p>
            <label className="field">
              <span>Пароль TeamSpeak</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.teamspeakPassword ?? 'StarFront'}
                onChange={(e) => set('teamspeakPassword', e.target.value)}
                placeholder="Пароль TS (если есть)"
              />
            </label>
            <p className="block-hint">
              Подключение к TS при запуске: адрес StarFront · порт 10026. Пустое поле — без пароля.
            </p>
            <label className="field">
              <span>Режим экрана</span>
              <select value={form.screenMode || 'borderless'} onChange={(e) => set('screenMode', e.target.value)}>
                <option value="borderless">Без рамки</option>
                <option value="windowed">Окно</option>
                <option value="fullscreen">Полный экран</option>
              </select>
            </label>
            <label className="field">
              <span>Мощность ПК / нагрузка на игру</span>
              <select
                value={form.performancePreset || 'high'}
                onChange={(e) => set('performancePreset', e.target.value)}
              >
                <option value="low">Низкая — 4 ядра, 4 GB RAM</option>
                <option value="medium">Средняя — 8 ядер, 8 GB</option>
                <option value="high">Высокая — 12 ядер, 16 GB</option>
                <option value="ultra">Ультра — 16 ядер, 32 GB</option>
              </select>
            </label>
            <p className="block-hint">BattlEye всегда включён — сервер StarFront требует античит.</p>
            <Toggle
              checked={form.optimizedLaunch === true}
              onChange={(v) => set('optimizedLaunch', v)}
              label="Оптимизированный запуск"
              hint="profiling.exe + CPU/RAM — интро и логотипы не отключаются"
            />
            <Toggle
              checked={form.skipLogos === true}
              onChange={(v) => set('skipLogos', v)}
              label="Пропускать логотипы Bohemia"
              hint="Только -noSplash. Интро StarFront не затрагивается"
            />
          </div>

          <div className="settings-block">
            <h3>Интерфейс</h3>
            <label className="field range-field">
              <span>Размытие: {form.blurAmount ?? 12}px</span>
              <input
                type="range"
                min={0}
                max={24}
                value={form.blurAmount ?? 12}
                onChange={(e) => set('blurAmount', parseInt(e.target.value, 10))}
              />
            </label>
            <label className="field range-field">
              <span>Сканлайны: {Math.round((form.scanlineIntensity ?? 0.35) * 100)}%</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((form.scanlineIntensity ?? 0.35) * 100)}
                onChange={(e) => set('scanlineIntensity', parseInt(e.target.value, 10) / 100)}
              />
            </label>
            <Toggle
              checked={form.animationsEnabled !== false}
              onChange={(v) => set('animationsEnabled', v)}
              label="Анимации"
            />
            <Toggle
              checked={form.showEventAnnouncement !== false}
              onChange={(v) => set('showEventAnnouncement', v)}
              label="Анонс ивентов"
              hint="Баннер объявлений на главном экране"
            />
            <Toggle
              checked={form.showEventCalendar !== false}
              onChange={(v) => set('showEventCalendar', v)}
              label="Календарь ивентов"
              hint="Ближайший ивент и кнопка календаря"
            />
            <Toggle
              checked={form.showHolonetOnHome !== false}
              onChange={(v) => set('showHolonetOnHome', v)}
              label="Holonet на главной"
              hint="Слайдер галактических новостей. Если выкл — только кнопка HOLONET"
            />
            <Toggle
              checked={form.eventNotificationsEnabled !== false}
              onChange={(v) => set('eventNotificationsEnabled', v)}
              label="Уведомления об ивентах"
              hint="Звук и окно поверх всех программ при старте ивента"
            />
          </div>

          <button type="submit" className="btn-save">
            СОХРАНИТЬ
          </button>
        </form>
        <p className="settings-footer">
          TeamSpeak: адрес <strong>StarFront</strong> · порт 10026 · пароль из настроек · Arma: 109.248.4.45:2302
        </p>
      </section>
    </div>
  );
}
