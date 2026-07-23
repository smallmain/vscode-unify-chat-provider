<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {
  NButton,
  NCard,
  NConfigProvider,
  NDataTable,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NFlex,
  NGrid,
  NGridItem,
  NIcon,
  NInput,
  NLayout,
  NLayoutContent,
  NProgress,
  NSpace,
  NStatistic,
  NTag,
  dateEnUS,
  dateZhCN,
  darkTheme,
  enUS,
  lightTheme,
  zhCN,
  type DataTableColumns,
  type NDateLocale,
  type NLocale,
  type GlobalTheme,
  type GlobalThemeOverrides
} from 'naive-ui'
import * as echarts from 'echarts/core'
import {BarChart, LineChart, PieChart} from 'echarts/charts'
import {GridComponent, LegendComponent, TooltipComponent} from 'echarts/components'
import type {PieSeriesOption} from 'echarts/charts'
import {CanvasRenderer} from 'echarts/renderers'
import {RefreshCw, Search, Trash2, TrendingUp} from 'lucide-vue-next'

interface VsCodeApi<State = unknown> {
  postMessage(message: unknown): void
  getState(): State | undefined
  setState(state: State): void
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>

interface UsageTotals {
  requests: number
  successes: number
  errors: number
  cancelled: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  uncachedInputTokens: number
  usageRecords: number
  missingUsageRecords: number
  totalLatencyMs: number
  latencyRecords: number
}

interface UsageRangeView {
  id: string
  label: string
  since?: number
  until?: number
}

interface UsageSummaryItem extends UsageTotals {
  key: string
  label: string
  detail?: string
}

interface UsageDayItem extends UsageTotals {
  dateKey: string
  timestamp: number
}

type UsageTrendGranularity = 'hour' | 'day'

interface UsageTrendItem extends UsageTotals {
  key: string
  label: string
  timestamp: number
}

interface UsageTrend {
  granularity: UsageTrendGranularity
  items: UsageTrendItem[]
}

interface UsageRecordView {
  id: string
  timestamp: number
  timeText: string
  providerName: string
  providerType: string
  vscodeModelId: string
  modelId: string
  modelName?: string
  outcome: 'success' | 'error' | 'cancelled'
  latencyMs?: number
  latencyText: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedInputTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
    uncachedInputTokens?: number
  }
}

interface UsageDetailTexts {
  title: string
  historicalTotalUsage: string
  customTimeRange: string
  startDate: string
  endDate: string
  updated: string
  refresh: string
  clear: string
  requests: string
  success: string
  errors: string
  totalTokens: string
  prompt: string
  completion: string
  cacheHit: string
  cachedInputTokens: string
  averageLatency: string
  recordsWithUsage: string
  missing: string
  dailyTrend: string
  noUsageRecords: string
  breakdown: string
  provider: string
  model: string
  topUsage: string
  recentRequests: string
  filterPlaceholder: string
  name: string
  outcome: string
  tokens: string
  latency: string
  requestDetail: string
  time: string
  vscodeModel: string
  promptTokens: string
  completionTokens: string
  cachedTokens: string
  total: string
  cached: string
  cancelled: string
  notAvailable: string
}

interface UsageDetailPayload {
  activeRangeId: string
  ranges: UsageRangeView[]
  customRange: [number, number] | null
  historicalTotals: UsageTotals
  totals: UsageTotals
  byProvider: UsageSummaryItem[]
  byModel: UsageSummaryItem[]
  byDay: UsageDayItem[]
  trend: UsageTrend
  recent: UsageRecordView[]
  generatedAtText: string
  locale: string
  texts: UsageDetailTexts
}

type ExtensionToWebviewMessage =
  | {type: 'usage-data'; payload: UsageDetailPayload}
  | {type: 'cleared'; payload: UsageDetailPayload}

type WebviewToExtensionMessage =
  | {type: 'ready'}
  | {type: 'range'; id: string; value: [number, number] | null}
  | {type: 'refresh'}
  | {type: 'clear'}

const vscode = acquireVsCodeApi()

const icons = {
  RefreshCw,
  Search,
  Trash2,
  TrendingUp
}

echarts.use([
  BarChart,
  GridComponent,
  LegendComponent,
  LineChart,
  PieChart,
  TooltipComponent,
  CanvasRenderer
])

const emptyTotals: UsageTotals = {
  requests: 0,
  successes: 0,
  errors: 0,
  cancelled: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  uncachedInputTokens: 0,
  usageRecords: 0,
  missingUsageRecords: 0,
  totalLatencyMs: 0,
  latencyRecords: 0
}

const defaultTexts: UsageDetailTexts = {
  title: 'Usage Statistics',
  historicalTotalUsage: 'Historical Total Usage',
  customTimeRange: 'Custom time range',
  startDate: 'Start date',
  endDate: 'End date',
  updated: 'Updated',
  refresh: 'Refresh',
  clear: 'Clear',
  requests: 'Requests',
  success: 'Success',
  errors: 'Errors',
  totalTokens: 'Total Tokens',
  prompt: 'Prompt',
  completion: 'Completion',
  cacheHit: 'Cache Hit',
  cachedInputTokens: 'cached input tokens',
  averageLatency: 'Avg Latency',
  recordsWithUsage: 'records with usage',
  missing: 'missing',
  dailyTrend: 'Daily Trend',
  noUsageRecords: 'No usage records in this range.',
  breakdown: 'Breakdown',
  provider: 'Provider',
  model: 'Model',
  topUsage: 'Top Usage',
  recentRequests: 'Recent Requests',
  filterPlaceholder: 'Filter provider, model, outcome',
  name: 'Name',
  outcome: 'Outcome',
  tokens: 'Tokens',
  latency: 'Latency',
  requestDetail: 'Request Detail',
  time: 'Time',
  vscodeModel: 'VS Code Model',
  promptTokens: 'Prompt Tokens',
  completionTokens: 'Completion Tokens',
  cachedTokens: 'Cached Tokens',
  total: 'Total',
  cached: 'Cached',
  cancelled: 'Cancelled',
  notAvailable: 'N/A'
}

const initialPayload: UsageDetailPayload = {
  activeRangeId: 'today',
  ranges: [],
  customRange: null,
  historicalTotals: emptyTotals,
  totals: emptyTotals,
  byProvider: [],
  byModel: [],
  byDay: [],
  trend: {
    granularity: 'day',
    items: []
  },
  recent: [],
  generatedAtText: '',
  locale: navigator.language,
  texts: defaultTexts
}

function postMessage(message: WebviewToExtensionMessage): void {
  vscode.postMessage(message)
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value))
}

function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    })}M`
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    })}K`
  }
  return formatInteger(value)
}

function formatLatency(totals: UsageTotals): string {
  if (totals.latencyRecords === 0) {
    return texts.value.notAvailable
  }
  return `${formatInteger(totals.totalLatencyMs / totals.latencyRecords)}ms`
}

function formatCacheRate(totals: UsageTotals): string {
  const denominator = totals.cachedInputTokens + totals.uncachedInputTokens
  if (denominator <= 0) {
    return texts.value.notAvailable
  }
  return `${Math.round((totals.cachedInputTokens / denominator) * 1000) / 10}%`
}

function cacheRate(totals: UsageTotals): number {
  const denominator = totals.cachedInputTokens + totals.uncachedInputTokens
  if (denominator <= 0) {
    return 0
  }
  return Math.round((totals.cachedInputTokens / denominator) * 1000) / 10
}

function successRate(totals: UsageTotals): number {
  if (totals.requests === 0) {
    return 0
  }
  return Math.round((totals.successes / totals.requests) * 1000) / 10
}

function isChineseLocale(locale: string): boolean {
  return /^zh(?:-|$)/i.test(locale)
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function endOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function startOfLocalDayOffset(daysAgo: number): number {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function createDateRange(daysAgo: number): [number, number] {
  return [startOfLocalDayOffset(daysAgo), endOfLocalDay(Date.now())]
}

function getChartColor(index: number): string {
  const colors = [
    'var(--vscode-charts-blue)',
    'var(--vscode-charts-green)',
    'var(--vscode-charts-yellow)',
    'var(--vscode-charts-orange)',
    'var(--vscode-charts-purple)',
    'var(--vscode-charts-red)'
  ]
  return colors[index % colors.length]
}

function readCssColor(variableName: string, fallback = ''): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(variableName).trim() || fallback
  )
}

function parseHexColor(value: string): {red: number; green: number; blue: number} | undefined {
  const normalized = value.trim().replace(/^#/, '')
  if (!/^[\da-f]{3}([\da-f]{3})?$/i.test(normalized)) {
    return undefined
  }
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : normalized
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16)
  }
}

function isDarkTheme(): boolean {
  if (document.body.classList.contains('vscode-high-contrast')) {
    return true
  }
  if (document.body.classList.contains('vscode-dark')) {
    return true
  }
  if (document.body.classList.contains('vscode-light')) {
    return false
  }
  const background = parseHexColor(readCssColor('--vscode-editor-background', '#1e1e1e'))
  if (!background) {
    return true
  }
  const luminance =
    (0.2126 * background.red + 0.7152 * background.green + 0.0722 * background.blue) / 255
  return luminance < 0.5
}

function createThemeOverrides(): GlobalThemeOverrides {
  const dark = isDarkTheme()
  const foreground = readCssColor('--vscode-foreground', '#cccccc')
  const descriptionForeground = readCssColor(
    '--vscode-descriptionForeground',
    dark ? '#9d9d9d' : '#616161'
  )
  const editorBackground = readCssColor('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff')
  const sideBarBackground = readCssColor(
    '--vscode-sideBar-background',
    dark ? '#252526' : '#f3f3f3'
  )
  const panelBorder = readCssColor('--vscode-panel-border', dark ? '#3c3c3c' : '#d0d0d0')
  const focusBorder = readCssColor('--vscode-focusBorder', '#007fd4')
  const buttonBackground = readCssColor('--vscode-button-background', '#0e639c')
  const buttonHoverBackground = readCssColor('--vscode-button-hoverBackground', '#1177bb')
  const buttonForeground = readCssColor('--vscode-button-foreground', '#ffffff')
  const buttonSecondaryBackground = readCssColor(
    '--vscode-button-secondaryBackground',
    dark ? '#3a3d41' : '#e5e5e5'
  )
  const buttonSecondaryHoverBackground = readCssColor(
    '--vscode-button-secondaryHoverBackground',
    dark ? '#45494e' : '#dcdcdc'
  )
  const buttonSecondaryForeground = readCssColor('--vscode-button-secondaryForeground', foreground)
  const inputBackground = readCssColor('--vscode-input-background', dark ? '#303136' : '#ffffff')
  const inputForeground = readCssColor('--vscode-input-foreground', foreground)
  const inputBorder = readCssColor('--vscode-input-border', panelBorder)
  const inputPlaceholderForeground = readCssColor(
    '--vscode-input-placeholderForeground',
    descriptionForeground
  )
  const menuBackground = readCssColor('--vscode-dropdown-background', dark ? '#2f3036' : '#ffffff')
  const menuBorder = readCssColor('--vscode-dropdown-border', inputBorder)
  const menuForeground = readCssColor('--vscode-dropdown-foreground', foreground)
  const menuHoverBackground = readCssColor(
    '--vscode-list-hoverBackground',
    dark ? '#3f4148' : '#f0f0f0'
  )
  const menuActiveBackground = readCssColor(
    '--vscode-list-activeSelectionBackground',
    dark ? '#4d5058' : '#e8f3ff'
  )
  const menuActiveForeground = readCssColor(
    '--vscode-list-activeSelectionForeground',
    dark ? '#ffffff' : foreground
  )
  const menuInactiveForeground = readCssColor(
    '--vscode-list-inactiveSelectionForeground',
    foreground
  )
  const tableHeaderBackground = readCssColor(
    '--vscode-sideBarSectionHeader-background',
    editorBackground
  )
  const tableHoverBackground = readCssColor(
    '--vscode-list-hoverBackground',
    dark ? '#2a2d2e' : '#f3f3f3'
  )
  const progressBackground = readCssColor('--vscode-progressBar-background', buttonBackground)
  const cardBackground =
    sideBarBackground === editorBackground ? (dark ? '#25272d' : '#ffffff') : sideBarBackground
  const transparentShadow = '0 0 0 rgba(0, 0, 0, 0)'

  return {
    common: {
      borderRadius: '6px',
      borderColor: panelBorder,
      primaryColor: buttonBackground,
      primaryColorHover: buttonHoverBackground,
      primaryColorPressed: buttonBackground,
      textColorBase: foreground,
      bodyColor: editorBackground,
      cardColor: cardBackground,
      modalColor: cardBackground,
      popoverColor: menuBackground
    },
    Layout: {
      color: editorBackground,
      textColor: foreground
    },
    Button: {
      textColor: buttonSecondaryForeground,
      textColorHover: buttonSecondaryForeground,
      color: buttonSecondaryBackground,
      colorHover: buttonSecondaryHoverBackground,
      colorPressed: buttonSecondaryBackground,
      colorPrimary: buttonBackground,
      colorHoverPrimary: buttonHoverBackground,
      colorPressedPrimary: buttonBackground,
      textColorPrimary: buttonForeground,
      textColorHoverPrimary: buttonForeground
    },
    Card: {
      color: cardBackground,
      borderColor: panelBorder,
      titleTextColor: foreground,
      paddingSmall: '14px 16px',
      titleFontSizeSmall: '13px'
    },
    DataTable: {
      thColor: tableHeaderBackground,
      thColorHover: tableHeaderBackground,
      thColorSorting: tableHeaderBackground,
      tdColor: cardBackground,
      tdColorHover: tableHoverBackground,
      tdColorSorting: cardBackground,
      tdColorStriped: cardBackground,
      borderColor: panelBorder,
      thTextColor: descriptionForeground,
      tdTextColor: foreground,
      thIconColor: descriptionForeground,
      thIconColorActive: focusBorder,
      thButtonColorHover: tableHoverBackground,
      thColorModal: tableHeaderBackground,
      thColorHoverModal: tableHeaderBackground,
      thColorSortingModal: tableHeaderBackground,
      tdColorModal: cardBackground,
      tdColorHoverModal: tableHoverBackground,
      tdColorSortingModal: cardBackground,
      tdColorStripedModal: cardBackground,
      borderColorModal: panelBorder,
      thColorPopover: tableHeaderBackground,
      thColorHoverPopover: tableHeaderBackground,
      thColorSortingPopover: tableHeaderBackground,
      tdColorPopover: cardBackground,
      tdColorHoverPopover: tableHoverBackground,
      tdColorSortingPopover: cardBackground,
      tdColorStripedPopover: cardBackground,
      borderColorPopover: panelBorder,
      boxShadowBefore: transparentShadow,
      boxShadowAfter: transparentShadow
    },
    Statistic: {
      labelTextColor: descriptionForeground,
      valueTextColor: foreground,
      labelFontSize: '13px',
      valueFontSize: '22px'
    },
    Progress: {
      railColor: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.12)',
      fillColor: progressBackground
    },
    Input: {
      color: inputBackground,
      colorFocus: inputBackground,
      border: `1px solid ${inputBorder}`,
      borderHover: `1px solid ${focusBorder}`,
      borderFocus: `1px solid ${focusBorder}`,
      textColor: inputForeground,
      placeholderColor: inputPlaceholderForeground
    },
    InternalSelection: {
      color: inputBackground,
      colorActive: inputBackground,
      border: `1px solid ${menuBorder}`,
      borderHover: `1px solid ${focusBorder}`,
      borderActive: `1px solid ${focusBorder}`,
      borderFocus: `1px solid ${focusBorder}`,
      boxShadowFocus: `0 0 0 2px ${focusBorder}33`,
      textColor: menuForeground,
      placeholderColor: inputPlaceholderForeground,
      arrowColor: descriptionForeground,
      caretColor: focusBorder
    },
    InternalSelectMenu: {
      color: menuBackground,
      borderRadius: '6px',
      optionTextColor: menuForeground,
      optionTextColorPressed: menuActiveForeground,
      optionTextColorDisabled: descriptionForeground,
      optionTextColorActive: menuActiveForeground,
      optionCheckColor: focusBorder,
      optionColorPending: menuHoverBackground,
      optionColorActive: menuActiveBackground,
      optionColorActivePending: menuActiveBackground,
      groupHeaderTextColor: descriptionForeground
    },
    Popover: {
      color: menuBackground,
      dividerColor: panelBorder,
      textColor: menuInactiveForeground,
      boxShadow: dark ? '0 10px 28px rgba(0, 0, 0, 0.38)' : '0 10px 28px rgba(0, 0, 0, 0.14)'
    }
  }
}

function isTooltipFormatterItem(value: unknown): value is {
  marker: string
  seriesName: string
  value: unknown
} {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record.marker === 'string' && typeof record.seriesName === 'string'
}

function tooltipFormatter(params: unknown): string {
  const items = Array.isArray(params) ? params : [params]
  return items
    .filter(isTooltipFormatterItem)
    .map((item) => {
      const value = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value
      return `${item.marker}${item.seriesName}: ${formatTokens(Number(value ?? 0))}`
    })
    .join('<br/>')
}

function pieTooltipFormatter(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return ''
  }
  const record = item as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const value = typeof record.value === 'number' ? record.value : Number(record.value ?? 0)
  const percent = typeof record.percent === 'number' ? record.percent : Number(record.percent ?? 0)
  return `${name}<br/>${formatTokens(value)} · ${percent}%`
}

const payload = ref<UsageDetailPayload>(initialPayload)
const query = ref('')
const breakdownMode = ref<'provider' | 'model'>('provider')
const selectedRecord = ref<UsageRecordView | null>(null)
const trendElement = ref<HTMLElement | null>(null)
const providerBreakdownElement = ref<HTMLElement | null>(null)
const modelBreakdownElement = ref<HTMLElement | null>(null)
let trendChart: echarts.ECharts | undefined
let providerBreakdownChart: echarts.ECharts | undefined
let modelBreakdownChart: echarts.ECharts | undefined

const showRecordDetail = computed({
  get: () => selectedRecord.value !== null,
  set: (value: boolean) => {
    if (!value) {
      selectedRecord.value = null
    }
  }
})

const naiveTheme = ref<GlobalTheme>(isDarkTheme() ? darkTheme : lightTheme)
const themeOverrides = ref<GlobalThemeOverrides>(createThemeOverrides())
document.documentElement.dataset.usageTheme = isDarkTheme() ? 'dark' : 'light'

const texts = computed(() => payload.value.texts)
const naiveLocale = computed<NLocale>(() => (isChineseLocale(payload.value.locale) ? zhCN : enUS))
const naiveDateLocale = computed<NDateLocale>(() =>
  isChineseLocale(payload.value.locale) ? dateZhCN : dateEnUS
)
const dateRangeShortcuts = computed<Record<string, [number, number]>>(() => ({
  [payload.value.ranges.find((range) => range.id === 'today')?.label ?? 'Today']:
    createDateRange(0),
  [payload.value.ranges.find((range) => range.id === '7d')?.label ?? 'Last 7 days']:
    createDateRange(6),
  [payload.value.ranges.find((range) => range.id === '30d')?.label ?? 'Last 30 days']:
    createDateRange(29)
}))
const successPercent = computed(() => successRate(payload.value.totals))
const cachePercent = computed(() => cacheRate(payload.value.totals))
const averageLatency = computed(() => formatLatency(payload.value.totals))
const filteredRecords = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) {
    return payload.value.recent
  }
  return payload.value.recent.filter((record) =>
    [
      record.providerName,
      record.providerType,
      record.modelName,
      record.modelId,
      record.outcome
    ].some((field) => field?.toLowerCase().includes(value))
  )
})

const providerColumns: DataTableColumns<UsageSummaryItem> = [
  {
    title: () => texts.value.name,
    key: 'label',
    ellipsis: {tooltip: true},
    render(row) {
      return row.detail ? `${row.label} · ${row.detail}` : row.label
    }
  },
  {
    title: () => texts.value.requests,
    key: 'requests',
    width: 112,
    sorter: (left, right) => left.requests - right.requests,
    render: (row) => formatInteger(row.requests)
  },
  {
    title: () => texts.value.tokens,
    key: 'totalTokens',
    width: 112,
    sorter: (left, right) => left.totalTokens - right.totalTokens,
    render: (row) => formatTokens(row.totalTokens)
  },
  {
    title: () => texts.value.cached,
    key: 'cachedInputTokens',
    width: 96,
    render: (row) => formatCacheRate(row)
  }
]

const recentColumns: DataTableColumns<UsageRecordView> = [
  {
    title: () => texts.value.time,
    key: 'timeText',
    width: 156,
    ellipsis: {tooltip: true}
  },
  {
    title: () => texts.value.provider,
    key: 'providerName',
    width: 150,
    ellipsis: {tooltip: true}
  },
  {
    title: () => texts.value.model,
    key: 'modelId',
    ellipsis: {tooltip: true},
    render(row) {
      return row.modelName ?? row.modelId
    }
  },
  {
    title: () => texts.value.outcome,
    key: 'outcome',
    width: 112,
    render(row) {
      if (row.outcome === 'success') {
        return texts.value.success
      }
      if (row.outcome === 'error') {
        return texts.value.errors
      }
      return texts.value.cancelled
    }
  },
  {
    title: () => texts.value.tokens,
    key: 'tokens',
    width: 104,
    render(row) {
      return row.usage ? formatTokens(row.usage.totalTokens) : texts.value.notAvailable
    }
  },
  {
    title: () => texts.value.latency,
    key: 'latencyText',
    width: 104
  }
]

function renderTrendChart(): void {
  if (!trendElement.value) {
    return
  }
  trendChart ??= echarts.init(trendElement.value)
  trendChart.setOption({
    backgroundColor: 'transparent',
    color: [readCssColor('--vscode-charts-blue'), readCssColor('--vscode-charts-green')],
    tooltip: {
      trigger: 'axis',
      formatter: tooltipFormatter
    },
    legend: {
      top: 4,
      textStyle: {color: readCssColor('--vscode-descriptionForeground')}
    },
    grid: {
      left: 36,
      right: 18,
      top: 42,
      bottom: 28
    },
    xAxis: {
      type: 'category',
      data: payload.value.trend.items.map((item) => item.label),
      axisLabel: {color: readCssColor('--vscode-descriptionForeground')},
      axisLine: {lineStyle: {color: readCssColor('--vscode-panel-border')}}
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: readCssColor('--vscode-descriptionForeground'),
        formatter: (value: number) => formatTokens(value)
      },
      splitLine: {lineStyle: {color: readCssColor('--vscode-panel-border')}}
    },
    series: [
      {
        name: texts.value.total,
        type: 'line',
        smooth: true,
        areaStyle: {opacity: 0.14},
        data: payload.value.trend.items.map((item) => item.totalTokens)
      },
      {
        name: texts.value.cached,
        type: 'bar',
        barMaxWidth: 28,
        data: payload.value.trend.items.map((item) => item.cachedInputTokens)
      }
    ]
  })
}

function renderPieChart(
  element: HTMLElement | null,
  chart: echarts.ECharts | undefined,
  title: string,
  items: UsageSummaryItem[]
): echarts.ECharts | undefined {
  if (!element) {
    chart?.dispose()
    return undefined
  }
  const currentChart = chart ?? echarts.init(element)
  const topItems = items.slice(0, 8)
  currentChart.setOption({
    backgroundColor: 'transparent',
    color: topItems.map((_item, index) =>
      readCssColor(getChartColor(index).replace('var(', '').replace(')', ''))
    ),
    tooltip: {
      trigger: 'item',
      formatter: pieTooltipFormatter
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 4,
      top: 12,
      bottom: 12,
      width: 120,
      textStyle: {color: readCssColor('--vscode-descriptionForeground')}
    },
    series: [
      {
        name: title,
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['38%', '52%'],
        avoidLabelOverlap: true,
        label: {show: false},
        data: topItems.map((item) => ({name: item.label, value: item.totalTokens}))
      } satisfies PieSeriesOption
    ]
  })
  return currentChart
}

function renderBreakdownCharts(): void {
  if (!payload.value.totals.totalTokens) {
    providerBreakdownChart?.dispose()
    modelBreakdownChart?.dispose()
    providerBreakdownChart = undefined
    modelBreakdownChart = undefined
    return
  }
  providerBreakdownChart = renderPieChart(
    providerBreakdownElement.value,
    providerBreakdownChart,
    texts.value.provider,
    payload.value.byProvider
  )
  modelBreakdownChart = renderPieChart(
    modelBreakdownElement.value,
    modelBreakdownChart,
    texts.value.model,
    payload.value.byModel
  )
}

function refreshCharts(): void {
  void nextTick(() => {
    renderTrendChart()
    renderBreakdownCharts()
  })
}

function resizeCharts(): void {
  trendChart?.resize()
  providerBreakdownChart?.resize()
  modelBreakdownChart?.resize()
}

function syncTheme(): void {
  const dark = isDarkTheme()
  document.documentElement.dataset.usageTheme = dark ? 'dark' : 'light'
  naiveTheme.value = dark ? darkTheme : lightTheme
  themeOverrides.value = createThemeOverrides()
  refreshCharts()
}

function handleThemeChange(): void {
  requestAnimationFrame(syncTheme)
}

function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>): void {
  if (event.data.type === 'usage-data' || event.data.type === 'cleared') {
    payload.value = event.data.payload
    vscode.setState({payload: payload.value})
    refreshCharts()
  }
}

function changeRange(value: number | [number, number] | null): void {
  if (!Array.isArray(value)) {
    postMessage({type: 'range', id: 'custom', value: null})
    return
  }
  const [start, end] = value
  postMessage({
    type: 'range',
    id: 'custom',
    value: [startOfLocalDay(start), endOfLocalDay(end)]
  })
}

function refresh(): void {
  postMessage({type: 'refresh'})
}

function clear(): void {
  postMessage({type: 'clear'})
}

function rowProps(row: UsageRecordView): {onClick: () => void} {
  return {
    onClick: () => {
      selectedRecord.value = row
    }
  }
}

onMounted(() => {
  syncTheme()
  const state = vscode.getState() as {payload?: UsageDetailPayload} | undefined
  if (state?.payload) {
    payload.value = state.payload
  }
  window.addEventListener('message', handleMessage)
  window.addEventListener('resize', resizeCharts)
  window.addEventListener('vscode-color-theme-change', handleThemeChange)
  postMessage({type: 'ready'})
  refreshCharts()
})

onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage)
  window.removeEventListener('resize', resizeCharts)
  window.removeEventListener('vscode-color-theme-change', handleThemeChange)
  trendChart?.dispose()
  providerBreakdownChart?.dispose()
  modelBreakdownChart?.dispose()
})

watch([payload, breakdownMode], refreshCharts, {deep: true})
</script>

<template>
  <n-config-provider
    :theme="naiveTheme"
    :theme-overrides="themeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale">
    <n-layout class="app-shell">
      <n-layout-content class="usage-page">
        <header class="page-header">
          <div class="title-group">
            <n-icon size="22"><component :is="icons.TrendingUp" /></n-icon>
            <div>
              <h1>{{ texts.title }}</h1>
              <p>
                {{ texts.historicalTotalUsage }}
                {{ formatTokens(payload.historicalTotals.totalTokens) }} · {{ texts.updated }}
                {{ payload.generatedAtText }}
              </p>
            </div>
          </div>
          <n-space>
            <n-date-picker
              class="range-select"
              type="daterange"
              clearable
              :value="payload.customRange"
              :shortcuts="dateRangeShortcuts"
              :start-placeholder="texts.startDate"
              :end-placeholder="texts.endDate"
              @update:value="changeRange" />
            <n-button circle :title="texts.refresh" :aria-label="texts.refresh" @click="refresh">
              <template #icon
                ><n-icon><component :is="icons.RefreshCw" /></n-icon
              ></template>
            </n-button>
            <n-button circle type="error" ghost :title="texts.clear" :aria-label="texts.clear" @click="clear">
              <template #icon
                ><n-icon><component :is="icons.Trash2" /></n-icon
              ></template>
            </n-button>
          </n-space>
        </header>

        <n-grid :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <n-grid-item span="24 s:12 l:6">
            <n-card class="metric-card" size="small">
              <n-statistic
                :label="texts.requests"
                :value="formatInteger(payload.totals.requests)" />
              <n-progress
                type="line"
                :percentage="successPercent"
                :show-indicator="false"
                status="success" />
              <small
                >{{ formatInteger(payload.totals.successes) }} {{ texts.success }} ·
                {{ formatInteger(payload.totals.errors) }} {{ texts.errors }}</small
              >
            </n-card>
          </n-grid-item>
          <n-grid-item span="24 s:12 l:6">
            <n-card class="metric-card" size="small">
              <n-statistic
                :label="texts.totalTokens"
                :value="formatTokens(payload.totals.totalTokens)" />
              <small
                >{{ formatTokens(payload.totals.promptTokens) }} {{ texts.prompt }} ·
                {{ formatTokens(payload.totals.completionTokens) }} {{ texts.completion }}</small
              >
            </n-card>
          </n-grid-item>
          <n-grid-item span="24 s:12 l:6">
            <n-card class="metric-card" size="small">
              <n-statistic :label="texts.cacheHit" :value="formatCacheRate(payload.totals)" />
              <n-progress type="line" :percentage="cachePercent" :show-indicator="false" />
              <small
                >{{ formatTokens(payload.totals.cachedInputTokens) }}
                {{ texts.cachedInputTokens }}</small
              >
            </n-card>
          </n-grid-item>
          <n-grid-item span="24 s:12 l:6">
            <n-card class="metric-card" size="small">
              <n-statistic :label="texts.averageLatency" :value="averageLatency" />
              <small
                >{{ formatInteger(payload.totals.usageRecords) }} {{ texts.recordsWithUsage }} ·
                {{ formatInteger(payload.totals.missingUsageRecords) }} {{ texts.missing }}</small
              >
            </n-card>
          </n-grid-item>
        </n-grid>

        <n-grid class="chart-grid" :cols="24" :x-gap="12" :y-gap="12" responsive="screen">
          <n-grid-item span="24 l:14">
            <n-card :title="texts.dailyTrend" size="small">
              <div v-if="payload.trend.items.length" ref="trendElement" class="chart-panel"></div>
              <n-empty v-else :description="texts.noUsageRecords" />
            </n-card>
          </n-grid-item>
          <n-grid-item span="24 l:10">
            <n-card :title="texts.breakdown" size="small">
              <div v-if="payload.totals.totalTokens" class="breakdown-panels">
                <section class="breakdown-panel">
                  <h2>{{ texts.provider }}</h2>
                  <div
                    ref="providerBreakdownElement"
                    class="chart-panel breakdown-chart-panel"></div>
                </section>
                <section class="breakdown-panel">
                  <h2>{{ texts.model }}</h2>
                  <div ref="modelBreakdownElement" class="chart-panel breakdown-chart-panel"></div>
                </section>
              </div>
              <n-empty v-else :description="texts.noUsageRecords" />
            </n-card>
          </n-grid-item>
        </n-grid>

        <n-grid class="table-grid" :cols="24" :x-gap="12" :y-gap="12" responsive="screen">
          <n-grid-item span="24 l:10">
            <n-card :title="texts.topUsage" size="small">
              <n-data-table
                :columns="providerColumns"
                :data="breakdownMode === 'provider' ? payload.byProvider : payload.byModel"
                :pagination="{pageSize: 8}"
                size="small" />
            </n-card>
          </n-grid-item>
          <n-grid-item span="24 l:14">
            <n-card size="small">
              <template #header>
                <n-flex justify="space-between" align="center">
                  <span>{{ texts.recentRequests }}</span>
                  <n-input
                    v-model:value="query"
                    class="search-box"
                    clearable
                    :placeholder="texts.filterPlaceholder">
                    <template #prefix
                      ><n-icon><component :is="icons.Search" /></n-icon
                    ></template>
                  </n-input>
                </n-flex>
              </template>
              <n-data-table
                :columns="recentColumns"
                :data="filteredRecords"
                :row-props="rowProps"
                :pagination="{pageSize: 10}"
                size="small" />
            </n-card>
          </n-grid-item>
        </n-grid>

        <n-drawer v-model:show="showRecordDetail" :width="420">
          <n-drawer-content v-if="selectedRecord" :title="texts.requestDetail" closable>
            <n-descriptions :column="1" label-placement="left" bordered size="small">
              <n-descriptions-item :label="texts.time">{{
                selectedRecord.timeText
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.provider"
                >{{ selectedRecord.providerName }} ·
                {{ selectedRecord.providerType }}</n-descriptions-item
              >
              <n-descriptions-item :label="texts.vscodeModel">{{
                selectedRecord.vscodeModelId
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.model">{{
                selectedRecord.modelName ?? selectedRecord.modelId
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.outcome">
                <n-tag
                  :type="
                    selectedRecord.outcome === 'success'
                      ? 'success'
                      : selectedRecord.outcome === 'error'
                        ? 'error'
                        : 'warning'
                  "
                  >{{
                    selectedRecord.outcome === 'success'
                      ? texts.success
                      : selectedRecord.outcome === 'error'
                        ? texts.errors
                        : texts.cancelled
                  }}</n-tag
                >
              </n-descriptions-item>
              <n-descriptions-item :label="texts.latency">{{
                selectedRecord.latencyText
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.promptTokens">{{
                selectedRecord.usage
                  ? formatInteger(selectedRecord.usage.promptTokens)
                  : texts.notAvailable
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.completionTokens">{{
                selectedRecord.usage
                  ? formatInteger(selectedRecord.usage.completionTokens)
                  : texts.notAvailable
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.totalTokens">{{
                selectedRecord.usage
                  ? formatInteger(selectedRecord.usage.totalTokens)
                  : texts.notAvailable
              }}</n-descriptions-item>
              <n-descriptions-item :label="texts.cachedTokens">{{
                selectedRecord.usage?.cachedInputTokens === undefined
                  ? texts.notAvailable
                  : formatInteger(selectedRecord.usage.cachedInputTokens)
              }}</n-descriptions-item>
            </n-descriptions>
          </n-drawer-content>
        </n-drawer>
      </n-layout-content>
    </n-layout>
  </n-config-provider>
</template>
