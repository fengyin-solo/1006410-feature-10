/**
 * 汽轮发电机组业务服务：列表 / 明细 / 告警值班的唯一取数入口。
 *
 * 口径纪律：
 *  - 所有判定结论都来自 turbine-rule.ts 的 evaluateTurbine，本文件不另写限值；
 *  - 转速越过上限一律不允许保存，退回时写清超了多少 r/min；
 *  - 同一机组同一时段（机组编号|记录日期|班次）重复提交只留最新一版；
 *  - submitJudge 按提交时生效的阈值固化，历史不追溯；currentJudge 对在挂机按现行口径重算；
 *  - 厂用电量超上限的判定结果同步成设备点检（equipcheck）待办。
 */
import { listRows, saveRows } from './local-store'
import {
  appliedVersions,
  buildDedupKey,
  buildDiff,
  evaluateTurbine,
  isActiveStatus,
  latestRule,
  listRules,
  markApplied,
  ruleAt,
  saveRules,
  sortRules,
  unitSpec,
  type TurbineDiff,
  type TurbineJudge,
  type TurbineRow,
  type TurbineRule,
} from './turbine-rule'
import type { ActionResult, EntryRow } from './types'

const MODULE_KEY = 'turbine'
const EQUIPCHECK_KEY = 'equipcheck'
// 自动生成的点检待办编号前缀，与人工点检记录区分，也用于去重。
const TODO_NO_PREFIX = 'EQUI-TURB-'

export type SubmitInput = {
  unitNo: string
  speed: number
  power: number
  online: number
  aux: number
  shift: string
  date: string
}

export type PublishInput = {
  effectiveDate: string
  speedTolerance: number
  auxRateMin: number
  auxRateMax: number
  note: string
}

export type PublishResult = {
  rule: TurbineRule
  recomputed: number
  changed: number
  diffs: { row: TurbineRow; diff: TurbineDiff }[]
}

export type TurbineAlert = {
  rowId: number
  unitNo: string
  shift: string
  date: string
  kind: 'speed' | 'aux'
  label: string
  detail: string
  ruleVersion: number
  hasTodo: boolean
}

// 列表筛选与通用模块保持一致：按字段做包含匹配（数值字段转字符串）。
export function listTurbineRows(filters: Record<string, string> = {}): TurbineRow[] {
  activateDueRules()
  const rows = listRows(MODULE_KEY) as unknown as TurbineRow[]
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field as keyof TurbineRow] ?? '').includes(value.trim())),
  )
}

/**
 * 惰性激活：把「生效日期已到、但还没对在挂机重算过」的口径版本补跑一次。
 * 纯前端没有定时任务，取数即检查，保证预约发布的版本在当天自然生效。
 * 已解列/故障停机的历史记录任何时候都不参与。
 */
function activateDueRules(): void {
  const today = new Date().toISOString().slice(0, 10)
  const due = sortRules(listRules()).filter(
    (rule) => rule.effectiveDate <= today && !appliedVersions().includes(rule.version),
  )
  if (due.length === 0) {
    return
  }
  const rows = listRows(MODULE_KEY) as unknown as TurbineRow[]
  let touched = false
  for (const rule of due) {
    let used = false
    for (const row of rows) {
      if (!isActiveStatus(row.status) || row.currentJudge.ruleVersion === rule.version) {
        continue
      }
      const after = judgeRow(row, rule)
      row.recomputeLog.unshift(buildDiff(row.currentJudge, after, today))
      row.currentJudge = after
      row.abnormal = after.abnormal
      used = true
      touched = true
    }
    // 即使没有在挂机（没用到），也标记该版本已生效，不重复尝试。
    void used
    markApplied(rule.version)
  }
  if (touched) {
    persist(rows)
    syncAuxTodos()
  }
}

export function getTurbineRow(id: number): TurbineRow | undefined {
  return (listRows(MODULE_KEY) as unknown as TurbineRow[]).find((row) => row.id === id)
}

function persist(rows: TurbineRow[]): void {
  saveRows(MODULE_KEY, rows as unknown as EntryRow[])
}

function nextId(rows: TurbineRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

function judgeRow(
  row: Pick<TurbineRow, '机组编号' | '机组转速' | '上网电量' | '厂用电量'>,
  rule: TurbineRule,
): TurbineJudge {
  return evaluateTurbine({
    unitNo: row.机组编号,
    speed: row.机组转速,
    online: row.上网电量,
    aux: row.厂用电量,
    rule,
  })
}

/** 按记录日期取提交时应使用的口径版本。 */
function ruleForDate(date: string): TurbineRule {
  return ruleAt(listRules(), date)
}

/** 在挂机组的当前判定：取今天正在生效的版本（未来预约版本不提前套用）。 */
function currentEffectiveRule(): TurbineRule {
  return ruleAt(listRules(), new Date().toISOString().slice(0, 10))
}

/**
 * 保存发电机组运行记录。
 * 转速越上限直接拒收，不写库；厂用电量超限允许保存（要留痕、要点检跟进）。
 */
export function submitTurbine(input: SubmitInput): ActionResult & { rowId?: number } {
  const spec = unitSpec(input.unitNo)
  if (!spec) {
    return { ok: false, message: `机组编号 ${input.unitNo} 未登记额定参数，无法按统一口径判定` }
  }
  if ([input.speed, input.power, input.online, input.aux].some((value) => Number.isNaN(value) || value < 0)) {
    return { ok: false, message: '转速、功率、电量必须是不小于 0 的数字' }
  }
  if (!input.shift || !input.date) {
    return { ok: false, message: '运行班次和记录时间必填' }
  }

  const rule = ruleForDate(input.date)
  const probe = evaluateTurbine({
    unitNo: input.unitNo,
    speed: input.speed,
    online: input.online,
    aux: input.aux,
    rule,
  })

  // 越过上限的转速一律不允许保存，退回时写清超了多少。
  if (probe.speed.verdict === '超上限') {
    return {
      ok: false,
      message:
        `保存被退回：${input.unitNo} 转速 ${input.speed} r/min 超过口径 v${rule.version} 上限 ` +
        `${probe.speed.speedMax} r/min，超出 ${probe.speed.gap} r/min（额定 ${spec.ratedSpeed}，浮动 ±${(rule.speedTolerance * 100).toFixed(0)}%）`,
    }
  }

  const rows = listTurbineRows()
  const dedupKey = buildDedupKey(input.unitNo, input.date, input.shift)
  const existing = rows.find((row) => row.dedupKey === dedupKey)
  const now = new Date().toISOString()

  if (existing) {
    // 同一机组同一时段重复提交只留最新一版：原行覆盖，提交时判定按本次口径重新固化，
    // 历史重算轨迹保留以便追溯。
    const wasStatus = existing.status
    const submitJudge = probe
    existing.机组转速 = input.speed
    existing.发电功率 = input.power
    existing.上网电量 = input.online
    existing.厂用电量 = input.aux
    existing.机组状态 = wasStatus
    existing.submitCount += 1
    existing.updatedAt = now
    existing.judgeAt = input.date
    existing.submitJudge = submitJudge
    existing.currentJudge = isActiveStatus(wasStatus)
      ? judgeRow(existing, currentEffectiveRule())
      : submitJudge
    existing.abnormal = existing.currentJudge.abnormal
    existing.pending = isActiveStatus(wasStatus)
    persist(rows)
    syncAuxTodos()
    return {
      ok: true,
      rowId: existing.id,
      message: `已覆盖 ${input.unitNo} ${input.date} ${input.shift} 的上一版记录（第 ${existing.submitCount} 次提交）`,
    }
  }

  const id = nextId(rows)
  const submitJudge = probe
  const row: TurbineRow = {
    id,
    status: '待并网',
    pending: true,
    abnormal: submitJudge.abnormal,
    机组编号: input.unitNo,
    机组转速: input.speed,
    发电功率: input.power,
    上网电量: input.online,
    厂用电量: input.aux,
    运行班次: input.shift,
    记录时间: input.date,
    机组状态: '待并网',
    dedupKey,
    submitCount: 1,
    updatedAt: now,
    judgeAt: input.date,
    submitJudge,
    currentJudge: submitJudge,
    recomputeLog: [],
  }
  rows.push(row)
  persist(rows)
  syncAuxTodos()
  return { ok: true, rowId: id, message: `发电机组运行记录已保存，编号 ${id}` }
}

/** 机组状态流转：在挂 ↔ 解列/停机。回到在挂状态时按现行口径补一次当前判定。 */
export function applyTurbineAction(id: number, action: string): ActionResult {
  const targets: Record<string, string> = {
    提交并网: '运行中',
    登记解列: '已解列',
    上报故障: '故障停机',
  }
  const target = targets[action]
  if (!target) {
    return { ok: false, message: `发电机组运行记录没有登记「${action}」这个动作` }
  }
  const rows = listTurbineRows()
  const row = rows.find((item) => item.id === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的发电机组运行记录` }
  }
  if (row.status === target) {
    return { ok: false, message: `机组已经是「${target}」，不用重复操作` }
  }
  row.status = target
  row.机组状态 = target
  row.pending = isActiveStatus(target)
  if (isActiveStatus(target)) {
    // 重新挂网：当前判定按今天生效的口径重算，提交时的历史快照不动。
    row.currentJudge = judgeRow(row, currentEffectiveRule())
    row.abnormal = row.currentJudge.abnormal
  } else {
    // 解列/停机：当前判定冻结，历史记录不按新口径追溯。
    row.abnormal = row.currentJudge.abnormal
  }
  persist(rows)
  syncAuxTodos()
  return { ok: true, message: `机组已${action}，当前状态「${target}」` }
}

/**
 * 发布新版口径：规则只增不改；发布后对所有在挂机组按新规则重算一次，
 * 并为重算前后结论留差异。已解列/故障停机的历史记录原样保留。
 */
export function publishRule(input: PublishInput): ActionResult & { result?: PublishResult } {
  const rules = sortRules(listRules())
  if (!input.effectiveDate) {
    return { ok: false, message: '请选择新生效日期' }
  }
  if (input.speedTolerance <= 0 || input.speedTolerance > 0.5) {
    return { ok: false, message: '转速浮动比例需在 0～50% 之间' }
  }
  if (!(input.auxRateMin >= 0 && input.auxRateMax > input.auxRateMin)) {
    return { ok: false, message: '厂用电率区间需满足 下限 ≥ 0 且 上限 > 下限' }
  }
  if (rules.some((rule) => rule.effectiveDate === input.effectiveDate)) {
    return { ok: false, message: `生效日期 ${input.effectiveDate} 已有口径版本，请换一个日期` }
  }

  const nextVersion = latestRule(rules).version + 1
  const rule: TurbineRule = {
    version: nextVersion,
    effectiveDate: input.effectiveDate,
    speedTolerance: input.speedTolerance,
    auxRateMin: input.auxRateMin,
    auxRateMax: input.auxRateMax,
    note: input.note.trim() || `第 ${nextVersion} 版口径`,
  }
  saveRules([...rules, rule])

  const today = new Date().toISOString().slice(0, 10)
  let diffs: PublishResult['diffs'] = []
  // 生效日在今天/过去就立即重算；预约未来生效则等取数时由 activateDueRules 补跑。
  const shouldRecompute = input.effectiveDate <= today

  if (shouldRecompute) {
    const all = listRows(MODULE_KEY) as unknown as TurbineRow[]
    for (const row of all) {
      if (!isActiveStatus(row.status)) {
        continue
      }
      const before = row.currentJudge
      const after = judgeRow(row, rule)
      const diff = buildDiff(before, after, today)
      row.recomputeLog.unshift(diff)
      row.currentJudge = after
      row.abnormal = after.abnormal
      diffs.push({ row, diff })
    }
    persist(all)
    markApplied(rule.version)
    syncAuxTodos()
  }

  return {
    ok: true,
    result: {
      rule,
      recomputed: diffs.length,
      changed: diffs.filter((item) => item.diff.changed).length,
      diffs,
    },
    message: shouldRecompute
      ? `口径 v${nextVersion} 已发布并重算 ${diffs.length} 台在挂机组，其中 ${diffs.filter((item) => item.diff.changed).length} 台结论变化`
      : `口径 v${nextVersion} 已预约 ${input.effectiveDate} 生效，届时在挂机组将按新规则判定`,
  }
}

/** 告警值班取数：与列表、明细同一份判定结论，不允许自己再拍阈值。 */
export function turbineAlerts(): TurbineAlert[] {
  const alerts: TurbineAlert[] = []
  for (const row of listTurbineRows()) {
    const judge = row.currentJudge
    const todoExists = findAuxTodo(row.id) !== undefined
    if (judge.speed.verdict === '超上限') {
      alerts.push({
        rowId: row.id,
        unitNo: row.机组编号,
        shift: row.运行班次,
        date: row.记录时间,
        kind: 'speed',
        label: `${row.机组编号} 转速超上限`,
        detail:
          `实测 ${judge.speed.value} r/min，上限 ${judge.speed.speedMax} r/min，超出 ${judge.speed.gap} r/min` +
          `（口径 v${judge.ruleVersion}）`,
        ruleVersion: judge.ruleVersion,
        hasTodo: false,
      })
    } else if (judge.speed.verdict === '偏低') {
      alerts.push({
        rowId: row.id,
        unitNo: row.机组编号,
        shift: row.运行班次,
        date: row.记录时间,
        kind: 'speed',
        label: `${row.机组编号} 转速偏低`,
        detail:
          `实测 ${judge.speed.value} r/min，下限 ${judge.speed.speedMin} r/min，低 ${Math.abs(judge.speed.gap)} r/min` +
          `（口径 v${judge.ruleVersion}）`,
        ruleVersion: judge.ruleVersion,
        hasTodo: false,
      })
    }
    if (judge.aux.verdict === '超限') {
      alerts.push({
        rowId: row.id,
        unitNo: row.机组编号,
        shift: row.运行班次,
        date: row.记录时间,
        kind: 'aux',
        label: `${row.机组编号} 厂用电量超限`,
        detail:
          `厂用电率 ${judge.aux.rate}%，上限 ${judge.aux.auxRateMax}%，超出 ${judge.aux.gap} 个百分点` +
          `（口径 v${judge.ruleVersion}，已落点检待办）`,
        ruleVersion: judge.ruleVersion,
        hasTodo: todoExists,
      })
    }
  }
  return alerts
}

export type TurbineStats = {
  total: number
  active: number
  abnormal: number
  auxOver: number
}

export function turbineStats(): TurbineStats {
  const rows = listTurbineRows()
  return {
    total: rows.length,
    active: rows.filter((row) => isActiveStatus(row.status)).length,
    abnormal: rows.filter((row) => row.currentJudge.abnormal).length,
    auxOver: rows.filter((row) => row.currentJudge.aux.verdict === '超限').length,
  }
}

// ── 厂用电量超限 → 设备点检待办 ─────────────────────────────────────────────

function equipRows(): EntryRow[] {
  return listRows(EQUIPCHECK_KEY)
}

function findAuxTodo(sourceId: number): EntryRow | undefined {
  return equipRows().find((row) => String(row.来源记录) === `turbine:${sourceId}`)
}

function nextEquipId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

/**
 * 把厂用电量超限的判定结果落到设备点检待办清单：
 *  - 超限：按机组记录 upsert 一条「待点检」待办（同一记录重复提交/重算只更新不新增）；
 *  - 恢复正常：回收仍「待点检」的自动待办（异常已闭环）；点检员已接手/已处理的留作履历；
 *  - 人工点检记录一律不动。
 * 直接读原始行，不经过 activateDueRules，避免与重算相互递归。
 */
export function syncAuxTodos(): void {
  const existing = equipRows()
  const manual = existing.filter((row) => !String(row.点检编号).startsWith(TODO_NO_PREFIX))
  const autoBySource = new Map<string, EntryRow[]>()
  for (const row of existing) {
    if (String(row.点检编号).startsWith(TODO_NO_PREFIX)) {
      const key = String(row.来源记录)
      autoBySource.set(key, [...(autoBySource.get(key) ?? []), row])
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const next: EntryRow[] = [...manual]
  let seq = nextEquipId(next) - 1

  for (const row of listRows(MODULE_KEY) as unknown as TurbineRow[]) {
    const judge = row.currentJudge
    const sourceKey = `turbine:${row.id}`
    const prior = autoBySource.get(sourceKey) ?? []
    // 点检员已接手（状态不再是待点检）的自动待办作为履历保留，不被重算冲掉。
    for (const item of prior.filter((todo) => todo.status !== '待点检')) {
      next.push(item)
      seq = Math.max(seq, Number(item.id))
    }

    if (judge.aux.verdict !== '超限') {
      // 恢复正常：未接手的待办自动回收；已接手/已处理的在上面保留。
      continue
    }

    const open = prior.find((item) => item.status === '待点检')
    const content = {
      status: '待点检',
      pending: true,
      abnormal: true,
      点检编号: `${TODO_NO_PREFIX}${String(row.id).padStart(4, '0')}`,
      点检设备: `${row.机组编号} 汽轮发电机组（厂用电系统）`,
      点检部位: '厂用电计量与辅机能耗',
      点检方法: '核查厂用电量表计、辅机运行方式与计量数据',
      点检结果:
        `厂用电量超限：厂用电率 ${judge.aux.rate}%，高于口径 v${judge.ruleVersion} 上限 ${judge.aux.auxRateMax}%，` +
        `超出 ${judge.aux.gap} 个百分点（${row.记录时间} ${row.运行班次}）`,
      点检人员: '系统自动派发',
      点检日期: today,
      点检状态: '待点检',
      来源记录: sourceKey,
    }
    if (open) {
      next.push({ ...open, ...content })
      seq = Math.max(seq, Number(open.id))
    } else {
      seq += 1
      next.push({ id: seq, ...content })
    }
  }

  saveRows(EQUIPCHECK_KEY, next)
}

export { listRules as listTurbineRules }
