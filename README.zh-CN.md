# Ningk Dashboard

[English README](https://github.com/Ningkang-ZHAO/Ningk-Dashboard/blob/main/README.md)

Ningk Dashboard 是一个用于 Visual Studio Code 的个人启动仪表盘。它把项目启动器、时钟、天气、月历、网络日历订阅、节假日和 TodoList 放在一个 VS Code Webview 中。背景颜色会跟随当前 VS Code 主题。

![Ningk Dashboard 主界面效果图](https://raw.githubusercontent.com/Ningkang-ZHAO/Ningk-Dashboard/main/images/ningk-dashboard-main.png)

## 特性

- 左侧项目启动器。
- 可以直接在 Dashboard 界面添加项目，不需要手动改 JSON。
- 根据 VS Code Webview 环境显示本地时间和日期。
- 天气卡片使用 Open-Meteo，支持自动 IP 定位和手动坐标兜底。
- 可点击日期的月历。
- 支持中国大陆节假日和自定义日程。
- 支持网络 iCalendar / `.ics` 订阅。
- 日历条目可点击：如果事件带 URL，则打开链接；否则显示详情。
- TodoList 支持添加、完成和删除，并持久保存到 VS Code 扩展全局状态。
- 界面使用 VS Code 主题变量，会跟随当前主题变化。

## 具体修改内容

- 0.1.4：自动打开改为每个 VS Code 窗口会话只触发一次，避免远程/Jupyter 连接不稳定导致扩展宿主重载时，Dashboard 反复覆盖当前编辑器。
- 0.1.3：收窄扩展激活范围，并支持恢复已有 Dashboard Webview，避免 Linux 下 VS Code 重启、窗口恢复或扩展宿主重载后出现多个 Dashboard。
- 命令和设置命名空间统一为 `ningkDashboard.*`。
- 新增 `Ningk Dashboard: Add Project` 命令和 Projects 旁边的 `+` 按钮。
- 删除只能展示但不能使用的占位卡片，只保留可操作区域。
- 增加日期选中逻辑：点击有日程或节假日的日期时显示详情，没有内容则不显示额外卡片。
- 增加 TodoList：添加、勾选完成、删除。
- 清理发布版默认配置：不包含私人本地项目路径。

## 命令

- `Ningk Dashboard: Open`
- `Ningk Dashboard: Refresh`
- `Ningk Dashboard: Manage Calendars`
- `Ningk Dashboard: Add Project`

## 添加项目

有两种方式：

- 点击 Dashboard 左侧 `Projects` 旁边的 `+`。
- 在命令面板运行 `Ningk Dashboard: Add Project`。

扩展会把项目写入 VS Code 设置 `ningkDashboard.projects`。

## 日历

使用 `Ningk Dashboard: Manage Calendars` 可以启用内置中国大陆节假日，也可以添加 iCalendar 订阅。

自定义日程示例：

```json
{
  "ningkDashboard.calendarItems": [
    { "date": "2026-06-19", "title": "Release Day", "type": "event" }
  ]
}
```

日历订阅示例：

```json
{
  "ningkDashboard.calendarSubscriptions": [
    {
      "name": "Team Calendar",
      "url": "https://example.com/calendar.ics",
      "type": "event",
      "enabled": true
    }
  ]
}
```

## 天气

自动天气使用近似 IP 定位。如果 VPN 或代理影响定位，可以关闭后点击 `Refresh`，也可以使用手动坐标：

```json
{
  "ningkDashboard.weatherLocation": "manual",
  "ningkDashboard.city": "Shanghai",
  "ningkDashboard.latitude": 31.2304,
  "ningkDashboard.longitude": 121.4737
}
```
