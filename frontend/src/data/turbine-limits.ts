import type { EntryRow } from './types'

// 汽轮发电机组的统一判定口径：转速上下限、厂用电量合理区间全从这一份规则算。
// 列表、明细、告警都不许再各算各的，只能调这里的 unitLimits / judgeRow 取数。

export type UnitProfile = {
  机组编号: string
  额定转速: number // rpm
  额定功率: number // kW
}

// 机组档案：判定只认这里登记过的机组编号。
export const UNIT_PROFILES: UnitProfile[] = [
  { 机组编号: 'TURB-0001', 额定转速: 3000, 额定功率: 12000 },
  { 机组编号: 'TURB-0002', 额定转速: 3000, 额定功率: 12000 },
  { 机组编号: 'TURB-0003', 额定转速: 3000, 额定功率: 25000 },
]

// 判定口径：全厂就这一份，每调整一次版本号 +1。
export type LimitRule = {
  version: number
  updatedAt: string
  speedLowerRatio: number // 转速下限 = 额定转速 × 此系数
  speedUpperRatio: number // 转速上限 = 额定转速 × 此系数
  plantPowerMinRatio: number // 厂用电合理下限 = 额定功率 × 此系数
  plantPowerMaxRatio: number // 厂用电合理上限 = 额定功率 × 此系数
}

// 初始口径：老记录补快照、找不到当时版本时都按这一版算。
export const BASE_RULE: LimitRule = {
  version: 1,
  updatedAt: '2026-01-01',
  speedLowerRatio: 0.97,
  speedUpperRatio: 1.03,
  plantPowerMinRatio: 0.08,
  plantPowerMaxRatio: 0.18,
}

const RULE_KEY = 'waste-to-energy-plant:turbine-rule'
const RECALC_KEY = 'waste-to-energy-plant:turbine-recalc-log'

function storage(): Storage | null {
  return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
}

export function loadRule(): LimitRule {
  const store = storage()
  if (store) {
    const raw = store.getItem(RULE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as LimitRule
        if (typeof parsed.version === 'number') {
          return { ...BASE_RULE, ...parsed }
        }
      } catch {
        // 存的内容坏了就回到初始口径
      }
    }
  }
  return { ...BASE_RULE }
}

export function saveRule(rule: LimitRule): void {
  storage()?.setItem(RULE_KEY, JSON.stringify(rule))
}

// 按机组编号取一次数：转速上下限和厂用电合理区间一次算齐。
export type UnitLimits = {
  机组编号: string
  转速下限: number
  转速上限: number
  厂用电下限: number
  厂用电上限: number
  口径版本: number
}

export function unitLimits(unitNo: string, rule: LimitRule = loadRule()): UnitLimits {
  const profile = UNIT_PROFILES.find((item) => item.机组编号 === unitNo)
  if (!profile) {
    throw new Error(`机组 ${unitNo || '(空)'} 没有登记档案，无法按统一口径取数`)
  }
  return {
    机组编号: unitNo,
    转速下限: Math.round(profile.额定转速 * rule.speedLowerRatio),
    转速上限: Math.round(profile.额定转速 * rule.speedUpperRatio),
    厂用电下限: Math.round(profile.额定功率 * rule.plantPowerMinRatio),
    厂用电上限: Math.round(profile.额定功率 * rule.plantPowerMaxRatio),
    口径版本: rule.version,
  }
}

// 阈值快照跟着记录走：保存那一刻的口径留底，历史记录不按新口径追溯改写。
export function stampSnapshot<T extends EntryRow>(row: T, limits: UnitLimits): T {
  return {
    ...row,
    转速下限: limits.转速下限,
    转速上限: limits.转速上限,
    厂用电下限: limits.厂用电下限,
    厂用电上限: limits.厂用电上限,
    口径版本: limits.口径版本,
  }
}

// 这条记录判定该用的阈值：有快照用快照（当时的口径），没快照的老数据按当前口径补。
export function limitsOfRow(row: EntryRow): UnitLimits | null {
  const fields = ['转速下限', '转速上限', '厂用电下限', '厂用电上限']
  if (fields.every((field) => typeof row[field] === 'number')) {
    return {
      机组编号: String(row.机组编号 ?? ''),
      转速下限: Number(row.转速下限),
      转速上限: Number(row.转速上限),
      厂用电下限: Number(row.厂用电下限),
      厂用电上限: Number(row.厂用电上限),
      口径版本: Number(row.口径版本 ?? BASE_RULE.version),
    }
  }
  try {
    return unitLimits(String(row.机组编号 ?? ''))
  } catch {
    return null
  }
}

export type Judgment = {
  转速判定: '正常' | '偏低' | '超高' | '未判定'
  转速说明: string
  转速超限值: number // 超高时超出上限多少，其余情况为 0
  厂用电判定: '正常' | '越限' | '未判定'
  厂用电说明: string
  判定异常: boolean
  limits: UnitLimits | null
}

// 统一判定：列表、明细、告警都调这一个函数，谁也别自己拍数。
export function judgeRow(row: EntryRow): Judgment {
  const limits = limitsOfRow(row)
  if (!limits) {
    return {
      转速判定: '未判定',
      转速说明: '机组未登记档案',
      转速超限值: 0,
      厂用电判定: '未判定',
      厂用电说明: '机组未登记档案',
      判定异常: false,
      limits: null,
    }
  }
  const speed = Number(row.机组转速)
  let 转速判定: Judgment['转速判定'] = '正常'
  let 转速说明 = '在上下限之间'
  let 转速超限值 = 0
  if (Number.isFinite(speed)) {
    if (speed > limits.转速上限) {
      转速判定 = '超高'
      转速超限值 = speed - limits.转速上限
      转速说明 = `超出上限 ${转速超限值}`
    } else if (speed < limits.转速下限) {
      转速判定 = '偏低'
      转速说明 = `低于下限 ${limits.转速下限 - speed}`
    }
  } else {
    转速判定 = '未判定'
    转速说明 = '转速不是数值'
  }
  const plant = Number(row.厂用电量)
  let 厂用电判定: Judgment['厂用电判定'] = '正常'
  let 厂用电说明 = '在合理区间内'
  if (Number.isFinite(plant)) {
    if (plant > limits.厂用电上限) {
      厂用电判定 = '越限'
      厂用电说明 = `高于上限 ${plant - limits.厂用电上限}`
    } else if (plant < limits.厂用电下限) {
      厂用电判定 = '越限'
      厂用电说明 = `低于下限 ${limits.厂用电下限 - plant}`
    }
  } else {
    厂用电判定 = '未判定'
    厂用电说明 = '厂用电量不是数值'
  }
  return {
    转速判定,
    转速说明,
    转速超限值,
    厂用电判定,
    厂用电说明,
    判定异常: 转速判定 === '偏低' || 转速判定 === '超高' || 厂用电判定 === '越限',
    limits,
  }
}

// 同一机组同一时段的槽位键：重复提交按这个去重，只留最新一版。
export function slotKeyOf(row: EntryRow): string {
  return `${String(row.机组编号 ?? '')}|${String(row.记录时间 ?? '')}|${String(row.运行班次 ?? '')}`
}

// 还挂着的机组：待并网、运行中才算；已解列、故障停机的都是历史记录，重算不动它们。
export function isActiveTurbineRow(row: EntryRow): boolean {
  return row.status === '待并网' || row.status === '运行中'
}

// 重算前后差异的留底。
export type RecalcDiff = {
  id: number
  时间: string
  口径变化: string
  机组编号: string
  记录id: number
  记录时间: string
  变化: string[]
}

export function loadRecalcLog(): RecalcDiff[] {
  const store = storage()
  if (!store) {
    return []
  }
  const raw = store.getItem(RECALC_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as RecalcDiff[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function appendRecalcLog(diffs: RecalcDiff[]): RecalcDiff[] {
  if (diffs.length === 0) {
    return []
  }
  const log = loadRecalcLog()
  const start = log.reduce((max, item) => Math.max(max, item.id), 0)
  const stamped = diffs.map((item, index) => ({ ...item, id: start + index + 1 }))
  storage()?.setItem(RECALC_KEY, JSON.stringify([...log, ...stamped]))
  return stamped
}
