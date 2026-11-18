export const DISPLAYS = Object.freeze({
  auto: 'Automatic summary',
  value: 'Live value',
  color: 'Color gradient',
  badge: 'Color badge',
  bar: 'Progress bar',
  gauge: 'Dial gauge',
  chart: '24-hour line plot',
  trend: 'Trend arrow',
  thermometer: 'Thermometer',
  threshold: 'Threshold indicator',
  status: 'On/off status',
  icon: 'Icon only',
});

export const NUMERIC_DISPLAYS = ['color', 'badge', 'bar', 'gauge', 'chart', 'trend', 'thermometer', 'threshold'];
export const CLICK_MODES = ['details', 'command', 'action', 'message', 'chart', 'none'];
export const ROOM_STYLES = ['floorColor', 'wallColor', 'edgeColor', 'wallHeight', 'wallThickness', 'wallOpacity', 'edges'];
export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HISTORY_BUCKET_MS = 5 * 60 * 1000;
export const CHART_RANGES = { '2h': '2 hours', '24h': '24 hours', '30d': '30 days', all: 'All history' };
