const vscode = require("vscode");
const path = require("path");

let currentPanel;
let latestWeather = null;
let latestCalendarItems = [];
let latestTodos = [];
let weatherTimer;
let extensionContext;

const CALENDAR_CACHE_KEY = "dashboard.calendarItems.v4";
const SUBSCRIPTION_CACHE_KEY = "dashboard.calendarSubscriptions.v3";
const TODO_CACHE_KEY = "dashboard.todos.v1";
const DASHBOARD_VIEW_TYPE = "ningkDashboard";
const DASHBOARD_TITLE = "Dashboard";
const AUTO_OPEN_DELAY_MS = 500;
const AUTO_OPEN_SESSION_KEY = "dashboard.autoOpenedSession.v1";

function activate(context) {
  extensionContext = context;
  latestTodos = getTodos();

  context.subscriptions.push(
    vscode.commands.registerCommand("ningkDashboard.open", () =>
      openDashboard(context),
    ),
    vscode.commands.registerCommand("ningkDashboard.refresh", async () => {
      await refreshAll(true);
      postDashboardState();
    }),
    vscode.commands.registerCommand("ningkDashboard.manageCalendars", async () => {
      await manageCalendarSubscriptions();
      latestCalendarItems = await loadCalendarItems(true);
      postDashboardState();
    }),
    vscode.commands.registerCommand("ningkDashboard.addProject", async () => {
      await addProject();
      postDashboardState();
    }),
    vscode.window.registerWebviewPanelSerializer(DASHBOARD_VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        setupDashboardPanel(panel, context);
        await refreshAll(false);
        postDashboardState();
      },
    }),
  );

  scheduleAutoOpen(context);

  weatherTimer = setInterval(async () => {
    await refreshWeather();
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: "weather", payload: latestWeather });
    }
  }, 30 * 60 * 1000);

  context.subscriptions.push({ dispose: () => clearInterval(weatherTimer) });
}

function deactivate() {}

function getDashboardConfig() {
  const config = vscode.workspace.getConfiguration("ningkDashboard");
  const projects = config.get("projects", []);
  const calendarItems = config.get("calendarItems", []);
  const calendarSubscriptions = config.get("calendarSubscriptions", []);

  return {
    weatherLocation: config.get("weatherLocation", "auto"),
    city: config.get("city", "Yidu"),
    latitude: config.get("latitude", 30.378327),
    longitude: config.get("longitude", 111.450006),
    temperatureUnit: config.get("temperatureUnit", "celsius"),
    calendarRegion: config.get("calendarRegion", "auto"),
    projects: Array.isArray(projects) ? projects : [],
    calendarItems: Array.isArray(calendarItems) ? calendarItems : [],
    calendarSubscriptions: Array.isArray(calendarSubscriptions)
      ? calendarSubscriptions
      : [],
  };
}

async function refreshAll(force = false) {
  await Promise.all([refreshWeather(force), loadCalendarItems(force)]);
  latestTodos = getTodos();
}

function postDashboardState() {
  if (!currentPanel) return;
  currentPanel.webview.postMessage({ type: "config", payload: getDashboardConfig() });
  currentPanel.webview.postMessage({ type: "weather", payload: latestWeather });
  currentPanel.webview.postMessage({ type: "calendarItems", payload: latestCalendarItems });
  currentPanel.webview.postMessage({ type: "todos", payload: latestTodos });
}

function scheduleAutoOpen(context) {
  if (!vscode.workspace.getConfiguration("ningkDashboard").get("autoOpen", true)) {
    return;
  }
  if (hasAutoOpenedThisSession(context)) {
    return;
  }

  const autoOpenTimer = setTimeout(async () => {
    if (hasAutoOpenedThisSession(context)) {
      return;
    }
    await markAutoOpenedThisSession(context);
    if (!currentPanel && !hasOpenDashboardTab()) {
      openDashboard(context);
    }
  }, AUTO_OPEN_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(autoOpenTimer) });
}

function hasAutoOpenedThisSession(context) {
  return context.workspaceState.get(AUTO_OPEN_SESSION_KEY) === getAutoOpenSessionId();
}

async function markAutoOpenedThisSession(context) {
  await context.workspaceState.update(AUTO_OPEN_SESSION_KEY, getAutoOpenSessionId());
}

function getAutoOpenSessionId() {
  return vscode.env.sessionId || "unknown";
}

function openDashboard(context) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    postDashboardState();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    DASHBOARD_VIEW_TYPE,
    DASHBOARD_TITLE,
    vscode.ViewColumn.One,
    getWebviewOptions(),
  );

  setupDashboardPanel(panel, context);
}

function setupDashboardPanel(panel, context) {
  currentPanel = panel;
  currentPanel.webview.options = getWebviewOptions();
  currentPanel.iconPath = new vscode.ThemeIcon("home");
  currentPanel.webview.html = getHtml(currentPanel.webview);

  currentPanel.webview.onDidReceiveMessage(async (message) => {
    if (!message || !message.type) return;

    if (message.type === "ready") {
      currentPanel.webview.postMessage({ type: "config", payload: getDashboardConfig() });
      currentPanel.webview.postMessage({
        type: "weather",
        payload: { loading: true, city: getDashboardConfig().city },
      });
      await refreshAll(false);
      postDashboardState();
      return;
    }

    if (message.type === "openProject") {
      const projectPath = String(message.path || "").trim();
      if (!projectPath) return;
      try {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          projectPathToUri(projectPath),
          false,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          "Failed to open project: " + (error?.message || String(error)),
        );
      }
      return;
    }

    if (message.type === "refreshAll") {
      await refreshAll(true);
      postDashboardState();
      return;
    }

    if (message.type === "manageCalendars") {
      await vscode.commands.executeCommand("ningkDashboard.manageCalendars");
      return;
    }

    if (message.type === "addProject") {
      await vscode.commands.executeCommand("ningkDashboard.addProject");
      return;
    }

    if (message.type === "openCalendarItem") {
      await openCalendarItem(message.item);
      return;
    }

    if (message.type === "addTodo") {
      await addTodo(message.text);
      postDashboardState();
      return;
    }

    if (message.type === "toggleTodo") {
      await toggleTodo(message.id);
      postDashboardState();
      return;
    }

    if (message.type === "deleteTodo") {
      await deleteTodo(message.id);
      postDashboardState();
    }
  });

  currentPanel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
  });
}

function getWebviewOptions() {
  return { enableScripts: true, retainContextWhenHidden: true };
}

function hasOpenDashboardTab() {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input?.viewType === DASHBOARD_VIEW_TYPE),
  );
}

function projectPathToUri(projectPath) {
  const p = projectPath.trim();
  if (p.startsWith("wsl://")) {
    const rest = p.slice("wsl://".length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex < 0) throw new Error("Invalid WSL path: " + p);
    return vscode.Uri.parse(
      "vscode-remote://wsl+" +
        encodeURIComponent(rest.slice(0, slashIndex)) +
        rest.slice(slashIndex),
    );
  }
  if (p.startsWith("vscode-remote://") || p.startsWith("file://")) {
    return vscode.Uri.parse(p);
  }
  return vscode.Uri.file(p);
}

function uriToProjectPath(uri) {
  if (!uri) return "";
  if (uri.scheme === "file") return uri.fsPath.replace(/\\/g, "/");
  return uri.toString();
}

async function addProject() {
  const config = vscode.workspace.getConfiguration("ningkDashboard");
  const cfg = getDashboardConfig();
  const mode = await vscode.window.showQuickPick(
    [
      { label: "$(folder-opened) Choose Folder", value: "folder" },
      { label: "$(edit) Enter Path Manually", value: "manual" },
    ],
    { placeHolder: "Add a project to Ningk Dashboard" },
  );
  if (!mode) return;

  let projectPath = "";
  if (mode.value === "folder") {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Add Project",
      title: "Choose project folder",
    });
    if (!picked || !picked.length) return;
    projectPath = uriToProjectPath(picked[0]);
  } else {
    const input = await vscode.window.showInputBox({
      title: "Project path or URI",
      prompt: "Supports local paths, file://, vscode-remote://, and wsl://Ubuntu/path",
      placeHolder: "D:/Projects/MyProject",
    });
    if (!input) return;
    projectPath = input.trim();
  }

  const defaultName = path.basename(projectPath.replace(/[\\/]+$/, "")) || "Project";
  const name = await vscode.window.showInputBox({
    title: "Project name",
    value: defaultName,
    prompt: "This name appears in the Dashboard project list",
  });
  if (!name) return;

  const next = [
    ...cfg.projects.filter((project) => project && project.path !== projectPath),
    { name: name.trim(), path: projectPath },
  ];
  await config.update("projects", next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Added project to Ningk Dashboard: " + name.trim());
}

async function openCalendarItem(item) {
  if (!item || !item.title) return;
  if (item.url && /^https?:\/\//i.test(item.url)) {
    await vscode.env.openExternal(vscode.Uri.parse(item.url));
    return;
  }

  const details = [
    item.date,
    item.source,
    item.location ? "地点：" + item.location : "",
  ].filter(Boolean);
  vscode.window.showInformationMessage(item.title + (details.length ? " · " + details.join(" · ") : ""));
}

function getTodos() {
  const todos = extensionContext?.globalState.get(TODO_CACHE_KEY, []);
  return Array.isArray(todos) ? todos : [];
}

async function saveTodos(todos) {
  latestTodos = todos;
  await extensionContext?.globalState.update(TODO_CACHE_KEY, todos);
}

async function addTodo(text) {
  const title = String(text || "").trim();
  if (!title) return;
  const todos = getTodos();
  todos.unshift({
    id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
    title,
    done: false,
    createdAt: new Date().toISOString(),
  });
  await saveTodos(todos);
}

async function toggleTodo(id) {
  const todos = getTodos().map((todo) =>
    todo.id === id ? { ...todo, done: !todo.done } : todo,
  );
  await saveTodos(todos);
}

async function deleteTodo(id) {
  await saveTodos(getTodos().filter((todo) => todo.id !== id));
}

async function manageCalendarSubscriptions() {
  const config = vscode.workspace.getConfiguration("ningkDashboard");
  const cfg = getDashboardConfig();
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(cloud-download) 添加网络日历订阅", action: "add" },
      { label: "$(globe) 启用中国大陆节假日", action: "enable-cn" },
      { label: "$(circle-slash) 关闭内置节假日", action: "disable-region" },
      { label: "$(trash) 移除日历订阅", action: "remove" },
      { label: "$(settings-gear) 打开日历设置", action: "settings" },
    ],
    { placeHolder: "管理 Dashboard 日历" },
  );
  if (!action) return;

  if (action.action === "add") {
    const url = await vscode.window.showInputBox({
      title: "添加网络日历订阅",
      prompt: "输入 .ics / iCalendar 订阅地址",
      placeHolder: "https://example.com/calendar.ics",
      validateInput: (value) =>
        /^https?:\/\//i.test(String(value).trim())
          ? undefined
          : "请输入 http(s) 开头的订阅地址",
    });
    if (!url) return;

    const name = await vscode.window.showInputBox({
      title: "日历名称",
      value: "我的日历",
      prompt: "这个名称会显示为日程来源",
    });
    if (!name) return;

    const typePick = await vscode.window.showQuickPick(
      [
        { label: "日程", value: "event" },
        { label: "节假日", value: "holiday" },
        { label: "纪念日", value: "anniversary" },
      ],
      { placeHolder: "选择默认分类" },
    );

    await config.update(
      "calendarSubscriptions",
      [
        ...cfg.calendarSubscriptions,
        {
          name,
          url: url.trim(),
          type: typePick?.value || "event",
          enabled: true,
        },
      ],
      vscode.ConfigurationTarget.Global,
    );
    vscode.window.showInformationMessage("已添加日历订阅：" + name);
    return;
  }

  if (action.action === "enable-cn") {
    await config.update("calendarRegion", "cn", vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("已启用中国大陆节假日。");
    return;
  }

  if (action.action === "disable-region") {
    await config.update("calendarRegion", "off", vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("已关闭内置节假日。");
    return;
  }

  if (action.action === "settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:ningk.ningk-dashboard calendar",
    );
    return;
  }

  if (action.action === "remove") {
    if (!cfg.calendarSubscriptions.length) {
      vscode.window.showInformationMessage("暂无可移除的日历订阅。");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      cfg.calendarSubscriptions.map((item, index) => ({
        label: item.name || item.url,
        description: item.url,
        index,
      })),
      { placeHolder: "选择要移除的订阅" },
    );
    if (!selected) return;

    await config.update(
      "calendarSubscriptions",
      cfg.calendarSubscriptions.filter((_, index) => index !== selected.index),
      vscode.ConfigurationTarget.Global,
    );
    vscode.window.showInformationMessage("已移除日历订阅：" + selected.label);
  }
}

async function loadCalendarItems(force = false) {
  const cfg = getDashboardConfig();
  const region = await resolveCalendarRegion(cfg.calendarRegion);
  const now = new Date();
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  latestCalendarItems = dedupeCalendarItems([
    ...getBuiltInCalendarItems(years, region),
    ...getCustomCalendarItems(cfg.calendarItems),
    ...(await fetchRemoteCalendarItems(years, region, force)),
    ...(await fetchSubscriptionCalendarItems(years, cfg.calendarSubscriptions, force)),
  ]);
  return latestCalendarItems;
}

async function resolveCalendarRegion(region) {
  if (region === "auto") {
    const lang = vscode.env.language || "";
    return lang.startsWith("zh") ? "cn" : "off";
  }
  return region;
}

function getCustomCalendarItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && item.date && item.title)
    .map((item) => ({
      date: normalizeDateKey(item.date),
      title: String(item.title),
      type: normalizeCalendarType(item.type),
      source: item.source ? String(item.source) : "自定义",
      color: item.color ? String(item.color) : undefined,
      url: item.url ? String(item.url) : undefined,
    }))
    .filter((item) => item.date);
}

function getBuiltInCalendarItems(years, region) {
  if (region !== "cn") return [];
  const fixed = years.flatMap((year) => [
    { date: year + "-01-01", title: "元旦", type: "holiday", source: "中国大陆节假日" },
    { date: year + "-05-01", title: "劳动节", type: "holiday", source: "中国大陆节假日" },
    { date: year + "-06-01", title: "儿童节", type: "anniversary", source: "中国大陆节假日" },
    { date: year + "-10-01", title: "国庆节", type: "holiday", source: "中国大陆节假日" },
    { date: year + "-10-02", title: "国庆节", type: "holiday", source: "中国大陆节假日" },
    { date: year + "-10-03", title: "国庆节", type: "holiday", source: "中国大陆节假日" },
  ]);
  const movable = [
    { date: "2026-02-17", title: "春节", type: "holiday", source: "中国大陆节假日" },
    { date: "2026-02-18", title: "春节", type: "holiday", source: "中国大陆节假日" },
    { date: "2026-02-19", title: "春节", type: "holiday", source: "中国大陆节假日" },
    { date: "2026-04-04", title: "清明节", type: "holiday", source: "中国大陆节假日" },
    { date: "2026-06-19", title: "端午节", type: "holiday", source: "中国大陆节假日" },
    { date: "2026-09-25", title: "中秋节", type: "holiday", source: "中国大陆节假日" },
  ];
  const wantedYears = new Set(years.map(String));
  return [
    ...fixed,
    ...movable.filter((item) => wantedYears.has(item.date.slice(0, 4))),
  ];
}

async function fetchRemoteCalendarItems(years, region, force = false) {
  if (region !== "cn" || !extensionContext?.globalState) return [];
  const cache = extensionContext.globalState.get(CALENDAR_CACHE_KEY);
  const key = region + ":" + years.join(",");
  const now = Date.now();
  if (!force && cache?.key === key && now - Number(cache.cachedAt || 0) < 86400000) {
    return Array.isArray(cache.items) ? cache.items : [];
  }

  const items = [];
  for (const year of years) {
    try {
      const json = await fetchJsonWithTimeout(
        "https://timor.tech/api/holiday/year/" + year,
        5000,
      );
      if (!json || json.code !== 0 || !json.holiday) continue;
      for (const [date, info] of Object.entries(json.holiday)) {
        const title = info?.name || info?.holiday || info?.text;
        if (!title) continue;
        items.push({
          date,
          title: String(title),
          type: info?.holiday === false ? "event" : "holiday",
          source: "中国大陆节假日",
        });
      }
    } catch (_) {
      // Built-in fixed holidays are still shown.
    }
  }

  await extensionContext.globalState.update(CALENDAR_CACHE_KEY, {
    key,
    cachedAt: now,
    items,
  });
  return items;
}

async function fetchSubscriptionCalendarItems(years, subscriptions, force = false) {
  const enabled = Array.isArray(subscriptions)
    ? subscriptions.filter((item) => item && item.enabled !== false && item.url)
    : [];
  if (!enabled.length || !extensionContext?.globalState) return [];

  const cache = extensionContext.globalState.get(SUBSCRIPTION_CACHE_KEY) || {};
  const nextCache = { ...cache };
  const now = Date.now();
  const result = [];

  for (const subscription of enabled) {
    const url = String(subscription.url).trim();
    const cached = cache[url];
    let text = "";

    if (!force && cached && now - Number(cached.cachedAt || 0) < 21600000) {
      text = String(cached.text || "");
    } else {
      try {
        text = await fetchTextWithTimeout(url, 7000);
        nextCache[url] = { cachedAt: now, text };
      } catch (_) {
        text = String(cached?.text || "");
        if (!text) continue;
      }
    }

    result.push(
      ...parseIcsCalendar(text, years, {
        name: subscription.name || "订阅日历",
        type: subscription.type || "event",
        color: subscription.color,
      }),
    );
  }

  await extensionContext.globalState.update(SUBSCRIPTION_CACHE_KEY, nextCache);
  return result;
}

function parseIcsCalendar(text, years, source) {
  if (!text || typeof text !== "string") return [];
  const wantedYears = new Set(years.map(Number));
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const events = unfolded.split(/BEGIN:VEVENT/i).slice(1);
  const items = [];

  for (const eventText of events) {
    const block = eventText.split(/END:VEVENT/i)[0] || "";
    const fields = parseIcsFields(block);
    const parsedDate = parseIcsDate(fields["DTSTART;VALUE=DATE"] || fields.DTSTART);
    if (!parsedDate) continue;

    const summary = decodeIcsText(fields.SUMMARY || fields.DESCRIPTION || "日程");
    const categories = String(fields.CATEGORIES || "").toLowerCase();
    const type =
      categories.includes("birthday") || categories.includes("anniversary")
        ? "anniversary"
        : normalizeCalendarType(source.type);

    const baseItem = {
      title: summary,
      type,
      source: source.name,
      color: source.color,
      url: fields.URL ? decodeIcsText(fields.URL) : undefined,
      location: fields.LOCATION ? decodeIcsText(fields.LOCATION) : undefined,
    };

    if (/FREQ=YEARLY/i.test(fields.RRULE || "")) {
      for (const year of wantedYears) {
        items.push({
          ...baseItem,
          date: formatDateKey(new Date(year, parsedDate.month, parsedDate.day)),
        });
      }
      continue;
    }

    if (!wantedYears.has(parsedDate.year)) continue;
    items.push({
      ...baseItem,
      date: formatDateKey(new Date(parsedDate.year, parsedDate.month, parsedDate.day)),
    });
  }

  return items;
}

function parseIcsFields(block) {
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const rawKey = line.slice(0, idx).toUpperCase();
    const value = line.slice(idx + 1);
    fields[rawKey] = value;
    const key = rawKey.split(";")[0];
    if (!fields[key]) fields[key] = value;
  }
  return fields;
}

function parseIcsDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  };
}

function decodeIcsText(value) {
  return String(value || "")
    .replace(/\\n/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function normalizeCalendarType(type) {
  const value = String(type || "event").toLowerCase();
  if (value === "birthday") return "anniversary";
  return ["holiday", "anniversary", "task"].includes(value) ? value : "event";
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = parseIcsDate(text.replace(/-/g, ""));
  return parsed ? formatDateKey(new Date(parsed.year, parsed.month, parsed.day)) : "";
}

function formatDateKey(date) {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

function dedupeCalendarItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || !item.date || !item.title) continue;
    const key = `${item.date}|${item.title}|${item.type || "event"}|${item.source || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.title).localeCompare(String(b.title)),
  );
}

async function refreshWeather(forceNotify = false) {
  const cfg = getDashboardConfig();
  if (cfg.weatherLocation === "off") {
    latestWeather = {
      ok: false,
      disabled: true,
      city: "Weather",
      message: "Weather disabled",
      updatedAt: new Date().toISOString(),
    };
    return;
  }

  const unit = cfg.temperatureUnit === "fahrenheit" ? "fahrenheit" : "celsius";
  const unitParam = unit === "fahrenheit" ? "&temperature_unit=fahrenheit" : "";
  const loc = await resolveWeatherLocation(cfg, forceNotify);
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    encodeURIComponent(loc.latitude) +
    "&longitude=" +
    encodeURIComponent(loc.longitude) +
    "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto" +
    unitParam;

  try {
    const json = await fetchJsonWithTimeout(url, 3500);
    latestWeather = {
      ok: true,
      city: loc.city,
      temperature: json.current?.temperature_2m,
      humidity: json.current?.relative_humidity_2m,
      unit: unit === "fahrenheit" ? "°F" : "°C",
      weatherCode: json.current?.weather_code,
      windSpeed: json.current?.wind_speed_10m,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    latestWeather = {
      ok: false,
      city: loc.city || cfg.city,
      detail: String(error?.message || error),
      updatedAt: new Date().toISOString(),
    };
    if (forceNotify) {
      vscode.window.showWarningMessage(
        "Dashboard weather refresh failed: " + latestWeather.detail,
      );
    }
  }
}

async function resolveWeatherLocation(cfg, forceRefresh = false) {
  const fallback = {
    city: cfg.city || "Yidu",
    latitude: Number(cfg.latitude) || 30.378327,
    longitude: Number(cfg.longitude) || 111.450006,
  };
  if (cfg.weatherLocation === "manual") return fallback;

  const cacheKey = "weather.autoLocation.v1";
  if (forceRefresh) {
    await extensionContext?.globalState.update(cacheKey, undefined);
  }
  const cached = extensionContext?.globalState.get(cacheKey);
  const now = Date.now();
  if (cached?.latitude && cached?.longitude && now - Number(cached.cachedAt || 0) < 21600000) {
    return cached;
  }

  const sources = [
    {
      url: "https://ipapi.co/json/",
      parse: (j) => ({
        city: [j.city, j.region, j.country_name].filter(Boolean).join(", ") || fallback.city,
        latitude: Number(j.latitude),
        longitude: Number(j.longitude),
      }),
    },
    {
      url: "https://ipwho.is/",
      parse: (j) => ({
        city: [j.city, j.region, j.country].filter(Boolean).join(", ") || fallback.city,
        latitude: Number(j.latitude),
        longitude: Number(j.longitude),
      }),
    },
  ];

  for (const source of sources) {
    try {
      const parsed = source.parse(await fetchJsonWithTimeout(source.url, 1800));
      if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
        const loc = { ...parsed, cachedAt: now };
        await extensionContext?.globalState.update(cacheKey, loc);
        return loc;
      }
    } catch (_) {
      // Fall back to configured location.
    }
  }

  return fallback;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  return JSON.parse(await fetchTextWithTimeout(url, timeoutMs, "application/json"));
}

async function fetchTextWithTimeout(url, timeoutMs, accept = "text/calendar, text/plain, */*") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept, "user-agent": "ningk-dashboard" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function getHtml(webview) {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    "img-src " + webview.cspSource + " https: data:",
    "style-src " + webview.cspSource + " 'unsafe-inline'",
    "script-src 'nonce-" + nonce + "'",
    "font-src data:",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ningk Dashboard</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --sidebar: var(--vscode-sideBar-background);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, var(--vscode-editor-background) 12%);
      --panel2: color-mix(in srgb, var(--vscode-sideBar-background) 76%, var(--vscode-editor-background) 24%);
      --border: color-mix(in srgb, var(--vscode-widget-border, var(--vscode-panel-border)) 76%, transparent);
      --accent: var(--vscode-focusBorder, var(--vscode-button-background));
      --button: var(--vscode-button-background);
      --buttonFg: var(--vscode-button-foreground);
      --hover: var(--vscode-list-hoverBackground);
      --holiday: #f36f7f;
      --anniversary: #56c88d;
      --event: color-mix(in srgb, var(--accent) 84%, #7db7ff 16%);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--fg);
      background:
        radial-gradient(circle at 76% 6%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 34rem),
        var(--bg);
      font-family: var(--vscode-font-family), "Segoe UI", "Microsoft YaHei", sans-serif;
      overflow: hidden;
    }
    button, input { font: inherit; }
    .app {
      display: grid;
      grid-template-columns: clamp(220px, 20vw, 330px) minmax(0, 1fr);
      height: 100vh;
      min-width: 0;
    }
    aside {
      min-width: 0;
      padding: clamp(18px, 2vw, 28px);
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--sidebar) 94%, transparent);
      overflow: auto;
    }
    main { min-width: 0; overflow: auto; padding: clamp(16px, 2vw, 30px); }
    .side-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .side-add { min-width: 30px; min-height: 30px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg); background: var(--panel2); cursor: pointer; }
    .side-title { font-size: 19px; font-weight: 750; }
    .side-kicker { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .projects { display: grid; gap: 6px; }
    .project {
      width: 100%;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      padding: 10px 8px;
      text-align: left;
    }
    .project:hover { background: var(--hover); }
    .folder { width: 16px; height: 12px; border-radius: 3px; background: var(--event); position: relative; }
    .folder:before { content: ""; position: absolute; top: -4px; left: 2px; width: 9px; height: 5px; border-radius: 3px 3px 0 0; background: inherit; }
    .pname { font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ppath { grid-column: 2; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: -4px; }
    .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
    .btn {
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--fg);
      background: var(--panel2);
      cursor: pointer;
      min-height: 32px;
      padding: 5px 11px;
    }
    .btn.primary { color: var(--buttonFg); background: var(--button); border-color: color-mix(in srgb, var(--button) 80%, var(--border)); }
    .layout {
      display: grid;
      grid-template-columns: minmax(420px, 1.25fr) minmax(280px, .75fr);
      gap: clamp(14px, 1.6vw, 22px);
      align-items: start;
    }
    .stack { display: grid; gap: clamp(14px, 1.6vw, 22px); }
    .top {
      display: grid;
      grid-template-columns: repeat(2, minmax(260px, 1fr));
      gap: clamp(14px, 1.6vw, 22px);
      margin-bottom: clamp(14px, 1.6vw, 22px);
    }
    .card { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); box-shadow: 0 18px 34px rgba(0,0,0,.16); overflow: hidden; }
    .time-card, .weather-card { min-height: clamp(132px, 16vh, 188px); padding: clamp(18px, 2vw, 28px); }
    #clock { font-size: clamp(42px, 5.2vw, 72px); line-height: 1; font-weight: 760; letter-spacing: 0; }
    #date { margin-top: 12px; color: var(--muted); font-size: clamp(15px, 1.4vw, 20px); }
    .weather-card { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 18px; align-items: start; }
    .weather-icon { font-size: clamp(38px, 4vw, 56px); line-height: 1; }
    .weather-temp { font-size: clamp(30px, 3.2vw, 42px); font-weight: 760; }
    .weather-desc { margin-left: 8px; font-size: 16px; font-weight: 650; }
    .weather-extra, .weather-city { color: var(--muted); margin-top: 8px; font-size: 13px; }
    .calendar-card { padding: clamp(16px, 1.8vw, 24px) clamp(14px, 1.6vw, 22px) 0; }
    .cal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .cal-title { font-size: clamp(20px, 2vw, 26px); font-weight: 760; }
    .cal-actions { display: flex; gap: 7px; }
    .cal-actions button { min-width: 32px; min-height: 30px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg); background: var(--panel2); cursor: pointer; }
    .weekdays, .days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .weekdays div { color: var(--muted); font-size: 13px; text-align: center; padding-bottom: 12px; font-weight: 650; }
    .day { min-height: clamp(64px, 8.6vh, 96px); padding: 5px; display: flex; flex-direction: column; align-items: center; gap: 3px; border-radius: 8px; min-width: 0; border: 1px solid transparent; }
    .day[data-date] { cursor: pointer; }
    .day[data-date]:hover { background: var(--hover); }
    .day.muted { opacity: .38; }
    .day.today { background: color-mix(in srgb, var(--accent) 25%, transparent); }
    .day.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
    .num { min-width: 30px; height: 26px; display: grid; place-items: center; border-radius: 7px; font-size: clamp(15px, 1.5vw, 20px); }
    .today .num { background: var(--button); color: var(--buttonFg); }
    .events { display: grid; gap: 3px; justify-items: center; width: 100%; min-width: 0; }
    .event-label {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 11px;
      border: 1px solid transparent;
      color: var(--fg);
      background: transparent;
      cursor: pointer;
    }
    .event-label.holiday { color: var(--holiday); border-color: color-mix(in srgb, var(--holiday) 48%, transparent); }
    .event-label.anniversary { color: var(--anniversary); border-color: color-mix(in srgb, var(--anniversary) 48%, transparent); }
    .event-label.event { color: var(--fg); background: color-mix(in srgb, var(--accent) 18%, transparent); }
    .dots { display: flex; gap: 4px; margin-top: auto; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--event); }
    .dot.holiday { background: var(--holiday); }
    .dot.anniversary { background: var(--anniversary); }
    .todo-card { padding: 18px; }
    .card-title { font-size: 16px; font-weight: 750; margin-bottom: 12px; }
    [hidden] { display: none !important; }
    .selected-card { padding: 18px; }
    .selected-date { color: var(--muted); font-size: 13px; margin-bottom: 12px; }
    .selected-list { display: grid; gap: 8px; }
    .selected-item {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel2);
      color: var(--fg);
      cursor: pointer;
      padding: 8px 10px;
      text-align: left;
    }
    .selected-item small { display: block; color: var(--muted); margin-top: 3px; }
    .todo-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-bottom: 12px; }
    .todo-input { min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-input-background); color: var(--fg); padding: 7px 9px; }
    .todo-list { display: grid; gap: 8px; }
    .todo-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) 28px; align-items: center; gap: 8px; padding: 6px 0; }
    .todo-check, .todo-delete { border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--panel2); cursor: pointer; width: 24px; height: 24px; display: grid; place-items: center; }
    .todo-row.done .todo-title { color: var(--muted); text-decoration: line-through; }
    .todo-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .todo-meta { color: var(--muted); font-size: 12px; margin-top: 10px; }
    .empty { color: var(--muted); font-size: 13px; padding: 6px 0; }
    @media (max-width: 1180px) {
      .layout { grid-template-columns: 1fr; }
      .top { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
    }
    @media (max-width: 820px) {
      .app { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--border); max-height: 34vh; }
      .top { grid-template-columns: 1fr; }
      .toolbar { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="side-head">
        <div><span class="side-title">Projects</span></div>
        <button class="side-add" id="addProject" title="Add project">+</button>
      </div>
      <div class="projects" id="projects"></div>
    </aside>
    <main>
      <div class="toolbar">
        <button class="btn primary" id="refreshAll">刷新</button>
        <button class="btn" id="manageCalendars">管理日历</button>
      </div>
      <div class="top">
        <section class="card time-card">
          <div id="clock">00:00:00</div>
          <div id="date">加载日期...</div>
        </section>
        <section class="card weather-card" id="weather">
          <div class="weather-icon">☁</div>
          <div>
            <div><span class="weather-temp">--</span><span class="weather-desc">加载中</span></div>
            <div class="weather-extra">正在获取天气</div>
          </div>
        </section>
      </div>
      <div class="layout">
        <section class="card calendar-card">
          <div class="cal-head">
            <div class="cal-title" id="monthTitle">Month</div>
            <div class="cal-actions">
              <button id="prevMonth" title="上个月">‹</button>
              <button id="todayBtn">今天</button>
              <button id="nextMonth" title="下个月">›</button>
            </div>
          </div>
          <div class="weekdays" id="weekdays"></div>
          <div class="days" id="calendar"></div>
        </section>
        <div class="stack">
          <section class="card selected-card" id="selectedDateCard" hidden>
            <div class="card-title">Details</div>
            <div class="selected-date" id="selectedDateTitle"></div>
            <div class="selected-list" id="selectedDateList"></div>
          </section>
          <section class="card todo-card">
            <div class="card-title">TodoList</div>
            <form class="todo-form" id="todoForm">
              <input class="todo-input" id="todoInput" placeholder="添加待办事项" autocomplete="off">
              <button class="btn primary" type="submit">添加</button>
            </form>
            <div class="todo-list" id="todoList"></div>
            <div class="todo-meta" id="todoMeta"></div>
          </section>
        </div>
      </div>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const locale = navigator.language || 'zh-CN';
    let config = { projects: [], calendarSubscriptions: [] };
    let current = new Date();
    let selectedDateKey = getDateKey(current.getFullYear(), current.getMonth(), current.getDate());
    let calendarItems = [];
    let todos = [];

    const clockEl = document.getElementById('clock');
    const dateEl = document.getElementById('date');
    const projectsEl = document.getElementById('projects');
    const weatherEl = document.getElementById('weather');
    const calendarEl = document.getElementById('calendar');
    const monthTitleEl = document.getElementById('monthTitle');
    const weekdaysEl = document.getElementById('weekdays');
    const selectedDateCardEl = document.getElementById('selectedDateCard');
    const selectedDateTitleEl = document.getElementById('selectedDateTitle');
    const selectedDateListEl = document.getElementById('selectedDateList');
    const todoFormEl = document.getElementById('todoForm');
    const todoInputEl = document.getElementById('todoInput');
    const todoListEl = document.getElementById('todoList');
    const todoMetaEl = document.getElementById('todoMeta');

    function updateClock() {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString(locale, { hour12: false });
      dateEl.textContent = now.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    }

    function renderProjects() {
      projectsEl.innerHTML = '';
      const projects = Array.isArray(config.projects) ? config.projects : [];
      if (!projects.length) {
        projectsEl.innerHTML = '<div class="empty">还没有配置项目。</div>';
        return;
      }
      projects.forEach((project, index) => {
        const btn = document.createElement('button');
        btn.className = 'project';
        btn.title = project.path || '';
        btn.innerHTML = '<span class="folder"></span><span class="pname"></span><span class="ppath"></span>';
        btn.querySelector('.pname').textContent = project.name || 'Untitled';
        btn.querySelector('.ppath').textContent = project.path || '';
        if (project.accent) btn.querySelector('.folder').style.background = project.accent;
        else btn.querySelector('.folder').style.filter = 'hue-rotate(' + (index * 48) + 'deg)';
        btn.onclick = () => vscode.postMessage({ type: 'openProject', path: project.path });
        projectsEl.appendChild(btn);
      });
    }

    function renderWeather(weather) {
      const ok = weather && weather.ok;
      const temp = ok ? String(Math.round(Number(weather.temperature))) + escapeHtml(weather.unit || '°C') : '--';
      const desc = weather && weather.loading ? '加载中' : ok ? weatherText(weather.weatherCode) : weather && weather.disabled ? '已关闭' : '不可用';
      const extra = ok
        ? '湿度 ' + escapeHtml(String(weather.humidity ?? '--')) + '% · Wind ' + escapeHtml(String(weather.windSpeed ?? '--')) + ' km/h · ' + formatUpdated(weather.updatedAt)
        : escapeHtml((weather && weather.detail) || '网络或代理可能阻止自动加载');
      weatherEl.innerHTML =
        '<div class="weather-icon">' + weatherIcon(weather && weather.weatherCode) + '</div>' +
        '<div><div><span class="weather-temp">' + temp + '</span><span class="weather-desc">' + escapeHtml(desc) + '</span></div>' +
        '<div class="weather-extra">' + extra + '</div>' +
        '<div class="weather-city">' + escapeHtml((weather && weather.city) || config.city || 'Weather') + '</div></div>';
    }

    function weatherIcon(code) {
      const c = Number(code);
      if ([0, 1].includes(c)) return '☀';
      if ([2, 3].includes(c)) return '☁';
      if (c >= 61 && c < 90) return '☔';
      if (c >= 71 && c < 80) return '❄';
      if (c >= 95) return '⚡';
      return '☁';
    }

    function weatherText(code) {
      const map = { 0: '晴', 1: '少云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 61: '小雨', 63: '雨', 65: '大雨', 71: '小雪', 73: '雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷暴' };
      return map[Number(code)] || '天气';
    }

    function formatUpdated(iso) {
      if (!iso) return '未更新';
      return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    function renderWeekdays() {
      weekdaysEl.innerHTML = '';
      for (let i = 0; i < 7; i++) {
        const div = document.createElement('div');
        div.textContent = new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'short' });
        weekdaysEl.appendChild(div);
      }
    }

    function renderCalendar() {
      calendarEl.innerHTML = '';
      const year = current.getFullYear();
      const month = current.getMonth();
      monthTitleEl.textContent = current.toLocaleDateString(locale, { year: 'numeric', month: 'long' });
      const first = new Date(year, month, 1);
      const last = new Date(year, month + 1, 0);
      let start = first.getDay();
      start = start === 0 ? 7 : start;
      const prevLast = new Date(year, month, 0).getDate();
      for (let i = start - 1; i > 0; i--) addDay(prevLast - i + 1, true);
      const today = new Date();
      for (let d = 1; d <= last.getDate(); d++) {
        addDay(d, false, year === today.getFullYear() && month === today.getMonth() && d === today.getDate(), year, month);
      }
      const cells = calendarEl.children.length;
      const nextDays = cells <= 35 ? 35 - cells : 42 - cells;
      for (let d = 1; d <= nextDays; d++) addDay(d, true);
      renderSelectedDate();
    }

    function addDay(text, muted, today, year, month) {
      const div = document.createElement('div');
      const dateKey = year !== undefined ? getDateKey(year, month, text) : null;
      const items = dateKey ? getItemsForDate(dateKey) : [];
      div.className = 'day' + (muted ? ' muted' : '') + (today ? ' today' : '') + (dateKey === selectedDateKey ? ' selected' : '');
      if (dateKey) div.dataset.date = dateKey;
      const labels = items.slice(0, 3).map((item) => {
        const id = getCalendarItemId(item);
        return '<button class="event-label ' + eventClass(item.type) + '" data-id="' + escapeHtml(id) + '" title="' + escapeHtml(item.title) + '">' + escapeHtml(item.title) + '</button>';
      }).join('');
      const dots = items.slice(3).map((item) => '<i class="dot ' + eventClass(item.type) + '"></i>').join('');
      div.innerHTML = '<span class="num">' + escapeHtml(text) + '</span><span class="events">' + labels + '</span><span class="dots">' + dots + '</span>';
      calendarEl.appendChild(div);
    }

    function renderSelectedDate() {
      const items = getItemsForDate(selectedDateKey);
      if (!items.length) {
        selectedDateCardEl.hidden = true;
        selectedDateTitleEl.textContent = '';
        selectedDateListEl.innerHTML = '';
        return;
      }
      selectedDateCardEl.hidden = false;
      const date = parseDateKey(selectedDateKey);
      selectedDateTitleEl.textContent = date
        ? date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
        : selectedDateKey;
      selectedDateListEl.innerHTML = items.map((item) =>
        '<button class="selected-item ' + eventClass(item.type) + '" data-id="' + escapeHtml(getCalendarItemId(item)) + '">' +
        '<strong>' + escapeHtml(item.title) + '</strong>' +
        '<small>' + escapeHtml(item.source || '日历') + (item.location ? ' · ' + escapeHtml(item.location) : '') + '</small>' +
        '</button>'
      ).join('');
    }

    function renderTodos() {
      if (!todos.length) {
        todoListEl.innerHTML = '<div class="empty">暂无待办事项。</div>';
        todoMetaEl.textContent = '';
        return;
      }
      todoListEl.innerHTML = todos.map((todo) =>
        '<div class="todo-row' + (todo.done ? ' done' : '') + '">' +
        '<button class="todo-check" data-id="' + escapeHtml(todo.id) + '" title="切换完成">' + (todo.done ? '✓' : '') + '</button>' +
        '<div class="todo-title" title="' + escapeHtml(todo.title) + '">' + escapeHtml(todo.title) + '</div>' +
        '<button class="todo-delete" data-id="' + escapeHtml(todo.id) + '" title="删除">×</button>' +
        '</div>'
      ).join('');
      const done = todos.filter((todo) => todo.done).length;
      todoMetaEl.textContent = '已完成 ' + done + ' / ' + todos.length;
    }

    function getCalendarItemId(item) {
      return [item.date, item.title, item.type || 'event', item.source || ''].join('|');
    }

    function findCalendarItem(id) {
      return calendarItems.find((item) => getCalendarItemId(item) === id);
    }

    function getDateKey(year, month, day) {
      return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
    function getItemsForDate(dateKey) { return calendarItems.filter((item) => item && item.date === dateKey); }
    function parseDateKey(value) {
      const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
    }
    function eventClass(type) { return type === 'holiday' ? 'holiday' : type === 'anniversary' ? 'anniversary' : 'event'; }
    function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }

    document.getElementById('refreshAll').onclick = () => vscode.postMessage({ type: 'refreshAll' });
    document.getElementById('addProject').onclick = () => vscode.postMessage({ type: 'addProject' });
    document.getElementById('manageCalendars').onclick = () => vscode.postMessage({ type: 'manageCalendars' });
    document.getElementById('prevMonth').onclick = () => { current.setMonth(current.getMonth() - 1); renderCalendar(); };
    document.getElementById('nextMonth').onclick = () => { current.setMonth(current.getMonth() + 1); renderCalendar(); };
    document.getElementById('todayBtn').onclick = () => { current = new Date(); renderCalendar(); };

    calendarEl.addEventListener('click', (event) => {
      const button = event.target.closest('.event-label');
      if (button) {
        const item = findCalendarItem(button.dataset.id);
        if (item) vscode.postMessage({ type: 'openCalendarItem', item });
        return;
      }
      const day = event.target.closest('.day[data-date]');
      if (!day) return;
      selectedDateKey = day.dataset.date;
      renderCalendar();
    });

    selectedDateListEl.addEventListener('click', (event) => {
      const button = event.target.closest('.selected-item');
      if (!button) return;
      const item = findCalendarItem(button.dataset.id);
      if (item) vscode.postMessage({ type: 'openCalendarItem', item });
    });

    todoFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = todoInputEl.value.trim();
      if (!text) return;
      todoInputEl.value = '';
      vscode.postMessage({ type: 'addTodo', text });
    });

    todoListEl.addEventListener('click', (event) => {
      const check = event.target.closest('.todo-check');
      const del = event.target.closest('.todo-delete');
      if (check) vscode.postMessage({ type: 'toggleTodo', id: check.dataset.id });
      if (del) vscode.postMessage({ type: 'deleteTodo', id: del.dataset.id });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      if (msg.type === 'config') { config = msg.payload || config; renderProjects(); }
      if (msg.type === 'weather') renderWeather(msg.payload);
      if (msg.type === 'calendarItems') { calendarItems = Array.isArray(msg.payload) ? msg.payload : []; renderCalendar(); }
      if (msg.type === 'todos') { todos = Array.isArray(msg.payload) ? msg.payload : []; renderTodos(); }
    });

    renderWeekdays();
    updateClock();
    renderCalendar();
    renderTodos();
    setInterval(updateClock, 1000);
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce() {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = { activate, deactivate };
