/**
 * 管理后台时间范围：接受 YYYY-MM-DD 或 ISO，按 UTC 日切 [start, end)。
 */
export interface UtcDayRange {
  start?: Date;
  end?: Date;
}

function parseDayOrIso(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无效日期：${raw}`);
  }
  return parsed;
}

/** from 含当天 00:00 UTC；to 含当天，返回次日 00:00 作为开区间终点。 */
export function parseUtcDayRange(from?: string, to?: string): UtcDayRange {
  const start = parseDayOrIso(from);
  const toDate = parseDayOrIso(to);
  let end: Date | undefined;
  if (toDate) {
    if (/^\d{4}-\d{2}-\d{2}$/.test((to ?? '').trim())) {
      end = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
    } else {
      end = toDate;
    }
  }
  if (start && end && start >= end) {
    throw new Error('开始日期必须早于结束日期');
  }
  return { start, end };
}

export function previousUtcRange(range: UtcDayRange): UtcDayRange {
  if (!range.start || !range.end) return {};
  const length = range.end.getTime() - range.start.getTime();
  return {
    start: new Date(range.start.getTime() - length),
    end: range.start,
  };
}

export function lastUtcDays(days: number, now = new Date()): UtcDayRange {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}
