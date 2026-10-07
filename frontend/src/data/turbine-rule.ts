/**
 * 汽轮发电机组统一判定口径（唯一事实来源）。
 *
 * 列表、明细面板、告警值班都只能调用本模块的 evaluateTurbine，不允许各自再拍一个数：
 *   - 机组转速上下限：按机组编号取额定转速，再乘阈值版本里的转速浮动比例；
 *   - 厂用电量合理区间：同一阈值版本里的厂用电率区间 × 上网电量；
 * 两类指标共用同一套规则、同一个生效版本。
 *
 * 阈值规则只增不改：历史记录的判定快照（submitJudge）按当时生效的版本固化，
 * 口径调整后只对「正在挂着的机组」重算当前判定（currentJudge），绝不追溯改写历史。
 */

// 厂用电量是「用电量（MW·h 量级）」，用厂用电率区间乘以上网电量反推合理用量。
export const AUX_BASE = 100

export type SpeedVerdict = '偏低' | '正常' | '超上限'
export type AuxVerdict = '偏低' | '正常' | '超限'

/** 一版阈值口径。只允许新增版本，不允许修改已发布版本。 */
export type TurbineRule = {
  version: number
  /** 生效日期（YYYY-MM-DD）：按记录/判定日期取「不晚于该日期的最新一版」。 */
  effectiveDate: string
  /** 允许的转速相对额定值的浮动比例，如 0.02 表示 ±2%。 */
  speedTolerance: number
  /** 厂用电率合理区间（百分比，如 [5, 15] 表示 5%～15%）。 */
  auxRateMin: number
  auxRateMax: number
  note: string
}

/** 按机组编号登记一次的机组参数；转速/厂用电判定都从这里取数。 */
export type UnitSpec = {
  unitNo: string
  /** 额定转速 r/min，机组转速上下限的判定基准。 */
  ratedSpeed: number
  name: string
}

export type TurbineThreshold = {
  version: number
  speedMin: number
  speedMax: number
  speedTolerance: number
  auxKwhMin: number
  auxKwhMax: number
  auxRateMin: number
  auxRateMax: number
}

export type SpeedJudge = {
  value: number
  verdict: SpeedVerdict
  speedMin: number
  speedMax: number
  /** 越上限时为正的超出量；偏低时为负的差距。 */
  gap: number
}

export type AuxJudge = {
  value: number
  online: number
  rate: number
  verdict: AuxVerdict
  auxKwhMin: number
  auxKwhMax: number
  auxRateMin: number
  auxRateMax: number
  /** 超限时为正的超出量；偏低时为负的差距。 */
  gap: number
}

export type TurbineJudge = {
  unitNo: string
  ratedSpeed: number
  ruleVersion: number
  effectiveDate: string
  speed: SpeedJudge
  aux: AuxJudge
  abnormal: boolean
}

/** 重算前后的一条差异记录：保留当时阈值，不覆盖提交时的历史判定。 */
export type TurbineDiff = {
  at: string
  fromVersion: number
  toVersion: number
  speedBefore: SpeedVerdict
  speedAfter: SpeedVerdict
  auxBefore: AuxVerdict
  auxAfter: AuxVerdict
  speedRangeBefore: [number, number]
  speedRangeAfter: [number, number]
  auxRateBefore: [number, number]
  auxRateAfter: [number, number]
  changed: boolean
}

/** 发电机组运行记录：提交时判定固化在 submitJudge，当前判定与重算轨迹随行更新。 */
export type TurbineRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  机组编号: string
  机组转速: number
  发电功率: number
  上网电量: number
  厂用电量: number
  运行班次: string
  记录时间: string
  机组状态: string
  /** 同一机组同一时段重复提交的合并键：机组编号|记录日期|班次。 */
  dedupKey: string
  submitCount: number
  updatedAt: string
  judgeAt: string
  submitJudge: TurbineJudge
  currentJudge: TurbineJudge
  recomputeLog: TurbineDiff[]
}

export const DEFAULT_RULES: TurbineRule[] = [
  {
    version: 1,
    effectiveDate: '2026-09-01',
    speedTolerance: 0.02,
    auxRateMin: 5,
    auxRateMax: 15,
    note: '初始口径：转速按额定值 ±2%，厂用电率 5%～15%',
  },
  {
    version: 2,
    effectiveDate: '2026-10-01',
    speedTolerance: 0.02,
    auxRateMin: 5,
    auxRateMax: 18,
    note: '10 月起放宽厂用电率上限至 18%，转速区间不变',
  },
]

export const UNIT_SPECS: UnitSpec[] = [
  { unitNo: 'TURB-0001', ratedSpeed: 3000, name: '1号汽轮发电机组' },
  { unitNo: 'TURB-0002', ratedSpeed: 3600, name: '2号汽轮发电机组' },
]

/** 正在挂着的机组状态：只有这两种状态会在口径调整后被重算。 */
export const ACTIVE_STATUSES = ['待并网', '运行中']

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export function unitSpec(unitNo: string): UnitSpec | undefined {
  return UNIT_SPECS.find((item) => item.unitNo === unitNo)
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 按机组编号取一次数：同一台机组的转速上下限与厂用电量区间都由这一版规则算出。 */
export function thresholdsFor(spec: UnitSpec, rule: TurbineRule): TurbineThreshold {
  const speedMax = round1(spec.ratedSpeed * (1 + rule.speedTolerance))
  const speedMin = round1(spec.ratedSpeed * (1 - rule.speedTolerance))
  return {
    version: rule.version,
    speedMin,
    speedMax,
    speedTolerance: rule.speedTolerance,
    auxKwhMin: round1((rule.auxRateMin / 100) * AUX_BASE),
    auxKwhMax: round1((rule.auxRateMax / 100) * AUX_BASE),
    auxRateMin: rule.auxRateMin,
    auxRateMax: rule.auxRateMax,
  }
}

export function sortRules(rules: TurbineRule[]): TurbineRule[] {
  return [...rules].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.version - b.version)
}

/** 取某日期生效的口径版本：不晚于该日期的最新一版；日期早于首版时回落首版。 */
export function ruleAt(rules: TurbineRule[], date: string): TurbineRule {
  const ordered = sortRules(rules)
  let picked = ordered[0]
  for (const rule of ordered) {
    if (rule.effectiveDate <= date) {
      picked = rule
    }
  }
  return picked
}

export function latestRule(rules: TurbineRule[]): TurbineRule {
  return sortRules(rules)[rules.length - 1]
}

/**
 * 唯一判定入口：转速与厂用电量按同一版规则、同一机组参数计算。
 * 列表、明细、告警必须取这里的结论，禁止在别处另写限值。
 */
export function evaluateTurbine(input: {
  unitNo: string
  speed: number
  online: number
  aux: number
  rule: TurbineRule
}): TurbineJudge {
  const spec = unitSpec(input.unitNo)
  if (!spec) {
    throw new Error(`机组编号 ${input.unitNo} 未登记额定参数，无法按统一口径判定`)
  }
  const threshold = thresholdsFor(spec, input.rule)

  let speedVerdict: SpeedVerdict = '正常'
  let speedGap = 0
  if (input.speed > threshold.speedMax) {
    speedVerdict = '超上限'
    speedGap = round1(input.speed - threshold.speedMax)
  } else if (input.speed < threshold.speedMin) {
    speedVerdict = '偏低'
    speedGap = round1(input.speed - threshold.speedMin)
  }

  const rate = input.online > 0 ? round1((input.aux / input.online) * 100) : 0
  let auxVerdict: AuxVerdict = '正常'
  let auxGap = 0
  if (rate > threshold.auxRateMax) {
    auxVerdict = '超限'
    auxGap = round1(rate - threshold.auxRateMax)
  } else if (rate < threshold.auxRateMin) {
    auxVerdict = '偏低'
    auxGap = round1(rate - threshold.auxRateMin)
  }

  return {
    unitNo: spec.unitNo,
    ratedSpeed: spec.ratedSpeed,
    ruleVersion: input.rule.version,
    effectiveDate: input.rule.effectiveDate,
    speed: {
      value: input.speed,
      verdict: speedVerdict,
      speedMin: threshold.speedMin,
      speedMax: threshold.speedMax,
      gap: speedGap,
    },
    aux: {
      value: input.aux,
      online: input.online,
      rate,
      verdict: auxVerdict,
      auxKwhMin: threshold.auxKwhMin,
      auxKwhMax: threshold.auxKwhMax,
      auxRateMin: threshold.auxRateMin,
      auxRateMax: threshold.auxRateMax,
      gap: auxGap,
    },
    abnormal: speedVerdict !== '正常' || auxVerdict !== '正常',
  }
}

export function buildDedupKey(unitNo: string, date: string, shift: string): string {
  return `${unitNo}|${date}|${shift}`
}

// ── 口径版本持久化：规则只增不改，独立于业务记录存放 ─────────────────────────
const RULE_STORAGE_KEY = 'waste-to-energy-plant:turbine-rules'
// 已对在挂机执行过重算的版本：防止同一版重复留差异；也标记种子里预置的历史重算。
const APPLIED_STORAGE_KEY = 'waste-to-energy-plant:turbine-applied'

let ruleCache: TurbineRule[] | null = null
let appliedCache: number[] | null = null

export function appliedVersions(): number[] {
  if (appliedCache !== null) {
    return appliedCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    appliedCache = []
    return appliedCache
  }
  try {
    appliedCache = JSON.parse(window.localStorage.getItem(APPLIED_STORAGE_KEY) ?? '[]') as number[]
  } catch {
    appliedCache = []
  }
  return appliedCache
}

export function markApplied(version: number): number[] {
  const versions = appliedVersions().includes(version)
    ? appliedVersions()
    : [...appliedVersions(), version]
  appliedCache = versions
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(APPLIED_STORAGE_KEY, JSON.stringify(versions))
  }
  return versions
}

export function listRules(): TurbineRule[] {
  if (ruleCache !== null) {
    return ruleCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    ruleCache = DEFAULT_RULES.map((item) => ({ ...item }))
    return ruleCache
  }
  const raw = window.localStorage.getItem(RULE_STORAGE_KEY)
  if (!raw) {
    ruleCache = DEFAULT_RULES.map((item) => ({ ...item }))
    window.localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(ruleCache))
    // 与示例数据配套：v1、v2 的重算轨迹已经预留在种子里，标记为已应用避免重放。
    if (!window.localStorage.getItem(APPLIED_STORAGE_KEY)) {
      window.localStorage.setItem(
        APPLIED_STORAGE_KEY,
        JSON.stringify(ruleCache.map((item) => item.version)),
      )
    }
    return ruleCache
  }
  try {
    const parsed = JSON.parse(raw) as TurbineRule[]
    ruleCache = Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_RULES.map((item) => ({ ...item }))
  } catch {
    ruleCache = DEFAULT_RULES.map((item) => ({ ...item }))
  }
  return ruleCache
}

export function saveRules(rules: TurbineRule[]): TurbineRule[] {
  ruleCache = sortRules(rules)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(ruleCache))
  }
  return ruleCache
}

export function resetRules(): TurbineRule[] {
  return saveRules(DEFAULT_RULES.map((item) => ({ ...item })))
}

/** 由判定结论构造一条重算差异（转速/厂用电两条指标一起留痕）。 */
export function buildDiff(before: TurbineJudge, after: TurbineJudge, at: string): TurbineDiff {
  return {
    at,
    fromVersion: before.ruleVersion,
    toVersion: after.ruleVersion,
    speedBefore: before.speed.verdict,
    speedAfter: after.speed.verdict,
    auxBefore: before.aux.verdict,
    auxAfter: after.aux.verdict,
    speedRangeBefore: [before.speed.speedMin, before.speed.speedMax],
    speedRangeAfter: [after.speed.speedMin, after.speed.speedMax],
    auxRateBefore: [before.aux.auxRateMin, before.aux.auxRateMax],
    auxRateAfter: [after.aux.auxRateMin, after.aux.auxRateMax],
    changed:
      before.speed.verdict !== after.speed.verdict || before.aux.verdict !== after.aux.verdict,
  }
}
