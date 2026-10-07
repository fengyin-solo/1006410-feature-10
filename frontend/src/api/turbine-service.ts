import { listRows, saveRows } from '@/data/local-store'
import {
  BASE_RULE,
  UNIT_PROFILES,
  appendRecalcLog,
  isActiveTurbineRow,
  judgeRow,
  limitsOfRow,
  loadRecalcLog,
  loadRule,
  saveRule,
  slotKeyOf,
  stampSnapshot,
  unitLimits,
} from '@/data/turbine-limits'
import type { Judgment, LimitRule, RecalcDiff, UnitLimits, UnitProfile } from '@/data/turbine-limits'
import type { ActionResult, EntryRow } from '@/data/types'

// 汽轮发电机组的业务操作：登记、口径调整、重算、点检待办联动。
// 判定本身都在 data/turbine-limits.ts，这里只管流程。

const TURBINE_KEY = 'turbine'
const EQUIPCHECK_KEY = 'equipcheck'

function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${today()} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function currentTurbineRule(): LimitRule {
  return loadRule()
}

export function unitOptions(): UnitProfile[] {
  return UNIT_PROFILES
}

// 表单上随选随算：按机组编号取一次数，转速上下限和厂用电区间一起出来。
export function limitsForUnit(unitNo: string): UnitLimits | null {
  try {
    return unitLimits(unitNo)
  } catch {
    return null
  }
}

// 老数据迁移：没有阈值快照的记录按初始口径（v1）补上，之后不按新口径追溯改写。
export function ensureTurbineSnapshots(): void {
  const rows = listRows(TURBINE_KEY)
  let changed = false
  const next = rows.map((row) => {
    if (typeof row.口径版本 === 'number') {
      return row
    }
    try {
      changed = true
      return stampSnapshot({ ...row }, unitLimits(String(row.机组编号 ?? ''), BASE_RULE))
    } catch {
      return row
    }
  })
  if (changed) {
    saveRows(TURBINE_KEY, next)
  }
}

export type TurbineSubmitInput = {
  机组编号: string
  机组转速: number
  发电功率: number
  上网电量: number
  厂用电量: number
  运行班次: string
  记录时间: string
}

export function submitTurbineRecord(input: TurbineSubmitInput): ActionResult {
  if (!input.机组编号) {
    return { ok: false, message: '机组编号不能为空' }
  }
  if (!input.记录时间) {
    return { ok: false, message: '记录时间不能为空' }
  }
  const numericFields: [string, number][] = [
    ['机组转速', input.机组转速],
    ['发电功率', input.发电功率],
    ['上网电量', input.上网电量],
    ['厂用电量', input.厂用电量],
  ]
  for (const [label, value] of numericFields) {
    if (!Number.isFinite(value)) {
      return { ok: false, message: `${label}要填数值` }
    }
  }
  let limits: UnitLimits
  try {
    limits = unitLimits(input.机组编号)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '机组编号无法取数' }
  }
  // 越过上限的转速一律不允许保存，退回时写清超了多少。
  if (input.机组转速 > limits.转速上限) {
    const excess = input.机组转速 - limits.转速上限
    return {
      ok: false,
      message: `机组转速 ${input.机组转速} 越过上限 ${limits.转速上限}，超出 ${excess}，按统一口径不予保存`,
    }
  }
  const rows = listRows(TURBINE_KEY)
  const slot = `${input.机组编号}|${input.记录时间}|${input.运行班次}`
  // 同一机组同一时段重复提交只留最新一版。
  const kept = rows.filter((row) => slotKeyOf(row) !== slot)
  const replaced = rows.length - kept.length
  let row: EntryRow = {
    id: nextId(rows),
    status: '待并网',
    pending: true,
    abnormal: false,
    机组编号: input.机组编号,
    机组转速: input.机组转速,
    发电功率: input.发电功率,
    上网电量: input.上网电量,
    厂用电量: input.厂用电量,
    运行班次: input.运行班次,
    记录时间: input.记录时间,
    机组状态: '待并网',
  }
  // 阈值快照跟着记录走：以后口径再调，这条历史仍按当时的阈值看。
  row = stampSnapshot(row, limits)
  const judgment = judgeRow(row)
  row.abnormal = judgment.判定异常
  saveRows(TURBINE_KEY, [...kept, row])
  syncEquipcheckTodo(row, judgment)
  const notes: string[] = []
  if (replaced > 0) {
    notes.push(`已覆盖同机组同时段的 ${replaced} 条旧记录，只留最新一版`)
  }
  if (judgment.转速判定 === '偏低') {
    notes.push(`转速${judgment.转速说明}`)
  }
  if (judgment.厂用电判定 === '越限') {
    notes.push(`厂用电量${judgment.厂用电说明}，已转入设备点检待办`)
  }
  return { ok: true, message: [`记录已保存（口径 v${limits.口径版本}）`, ...notes].join('；') }
}

// 厂用电量超限的判定结果要落到设备点检的待办清单里；
// 同一来源只留一条待办，重算后不再越限的，把还没人动的待办撤掉。
function syncEquipcheckTodo(row: EntryRow, judgment: Judgment): void {
  const source = slotKeyOf(row)
  const todos = listRows(EQUIPCHECK_KEY)
  const isOpen = (todo: EntryRow) => todo.来源单号 === source && todo.status === '待点检'
  const limits = judgment.limits
  const over = judgment.厂用电判定 === '越限' && limits !== null
  if (!over) {
    if (!todos.some(isOpen)) {
      return
    }
    saveRows(EQUIPCHECK_KEY, todos.filter((todo) => !isOpen(todo)))
    return
  }
  const text = `厂用电量 ${row.厂用电量} 越限：${judgment.厂用电说明}（合理区间 ${limits.厂用电下限}~${limits.厂用电上限}，口径 v${limits.口径版本}）`
  if (todos.some(isOpen)) {
    let seen = false
    const next: EntryRow[] = []
    for (const todo of todos) {
      if (!isOpen(todo)) {
        next.push(todo)
        continue
      }
      if (seen) {
        continue
      }
      seen = true
      next.push({ ...todo, 点检结果: text, 点检日期: today() })
    }
    saveRows(EQUIPCHECK_KEY, next)
    return
  }
  const id = nextId(todos)
  const todo: EntryRow = {
    id,
    status: '待点检',
    pending: true,
    abnormal: false,
    点检编号: `EQUI-${String(id).padStart(4, '0')}`,
    点检设备: `汽轮发电机组 ${String(row.机组编号)}`,
    点检部位: '厂用电系统',
    点检方法: '核对厂用电量与统一口径合理区间',
    点检结果: text,
    点检人员: '待指派',
    点检日期: today(),
    点检状态: '待点检',
    来源单号: source,
  }
  saveRows(EQUIPCHECK_KEY, [...todos, todo])
}

export type RuleParams = {
  speedLowerRatio: number
  speedUpperRatio: number
  plantPowerMinRatio: number
  plantPowerMaxRatio: number
}

export function validateRuleParams(params: RuleParams): string | null {
  const values = [
    params.speedLowerRatio,
    params.speedUpperRatio,
    params.plantPowerMinRatio,
    params.plantPowerMaxRatio,
  ]
  if (!values.every((value) => Number.isFinite(value))) {
    return '四个系数都要填数值'
  }
  if (params.speedLowerRatio <= 0 || params.speedLowerRatio >= params.speedUpperRatio) {
    return '转速下限系数必须大于 0 且小于上限系数'
  }
  if (params.plantPowerMinRatio < 0 || params.plantPowerMinRatio >= params.plantPowerMaxRatio) {
    return '厂用电下限系数必须不小于 0 且小于上限系数'
  }
  return null
}

// 调整判定口径：存新版本，然后把还挂着的机组按新规则重算一次，差异留底。
export function adjustTurbineRule(params: RuleParams): ActionResult & { diffs: RecalcDiff[] } {
  const invalid = validateRuleParams(params)
  if (invalid) {
    return { ok: false, message: invalid, diffs: [] }
  }
  const prev = loadRule()
  const next: LimitRule = { ...params, version: prev.version + 1, updatedAt: today() }
  saveRule(next)
  const diffs = recalcPendingTurbineUnits()
  return {
    ok: true,
    message:
      diffs.length > 0
        ? `口径已调整为 v${next.version}，${diffs.length} 条挂着的记录已按新规则重算，差异见下`
        : `口径已调整为 v${next.version}，挂着的记录重算后与之前一致`,
    diffs,
  }
}

// 还挂着的机组按当前口径重算；历史记录（已解列、故障停机）不动，按当时的阈值保留。
export function recalcPendingTurbineUnits(): RecalcDiff[] {
  ensureTurbineSnapshots()
  const rule = loadRule()
  const rows = listRows(TURBINE_KEY)
  const diffs: RecalcDiff[] = []
  const changed: { row: EntryRow; judgment: Judgment }[] = []
  const nextRows = rows.map((row) => {
    if (!isActiveTurbineRow(row)) {
      return row
    }
    const before = limitsOfRow(row)
    let limits: UnitLimits
    try {
      limits = unitLimits(String(row.机组编号 ?? ''), rule)
    } catch {
      return row
    }
    if (before && sameLimits(before, limits)) {
      return row
    }
    const beforeJudge = judgeRow(row)
    const updated = stampSnapshot({ ...row }, limits)
    const afterJudge = judgeRow(updated)
    updated.abnormal = afterJudge.判定异常
    diffs.push({
      id: 0,
      时间: nowText(),
      口径变化: `v${before?.口径版本 ?? BASE_RULE.version} → v${rule.version}`,
      机组编号: String(row.机组编号 ?? ''),
      记录id: Number(row.id),
      记录时间: String(row.记录时间 ?? ''),
      变化: diffLines(before, beforeJudge, limits, afterJudge),
    })
    changed.push({ row: updated, judgment: afterJudge })
    return updated
  })
  if (diffs.length === 0) {
    return []
  }
  saveRows(TURBINE_KEY, nextRows)
  const stamped = appendRecalcLog(diffs)
  // 重算后厂用电判定变了的，同步设备点检待办。
  for (const item of changed) {
    syncEquipcheckTodo(item.row, item.judgment)
  }
  return stamped
}

function sameLimits(a: UnitLimits, b: UnitLimits): boolean {
  return (
    a.转速下限 === b.转速下限 &&
    a.转速上限 === b.转速上限 &&
    a.厂用电下限 === b.厂用电下限 &&
    a.厂用电上限 === b.厂用电上限
  )
}

function diffLines(
  before: UnitLimits | null,
  beforeJudge: Judgment,
  after: UnitLimits,
  afterJudge: Judgment,
): string[] {
  const lines: string[] = []
  const metric = (label: string, oldValue: number | undefined, newValue: number) => {
    if (oldValue !== undefined && oldValue !== newValue) {
      lines.push(`${label} ${oldValue} → ${newValue}`)
    }
  }
  metric('转速下限', before?.转速下限, after.转速下限)
  metric('转速上限', before?.转速上限, after.转速上限)
  metric('厂用电下限', before?.厂用电下限, after.厂用电下限)
  metric('厂用电上限', before?.厂用电上限, after.厂用电上限)
  if (beforeJudge.转速判定 !== afterJudge.转速判定) {
    lines.push(`转速判定 ${beforeJudge.转速判定} → ${afterJudge.转速判定}（${afterJudge.转速说明}）`)
  }
  if (beforeJudge.厂用电判定 !== afterJudge.厂用电判定) {
    lines.push(`厂用电判定 ${beforeJudge.厂用电判定} → ${afterJudge.厂用电判定}（${afterJudge.厂用电说明}）`)
  }
  return lines
}

// 重算留底：明细面板按记录查，口径卡上看最近一批。
export function recalcLogFor(recordId: number): RecalcDiff[] {
  return loadRecalcLog()
    .filter((item) => item.记录id === recordId)
    .reverse()
}

export function latestRecalcLog(limit = 20): RecalcDiff[] {
  return loadRecalcLog().slice(-limit).reverse()
}
