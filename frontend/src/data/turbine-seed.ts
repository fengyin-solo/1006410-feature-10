import {
  DEFAULT_RULES,
  buildDiff,
  buildDedupKey,
  evaluateTurbine,
  ruleAt,
  type TurbineJudge,
  type TurbineRow,
} from './turbine-rule'
import type { EntryRow } from './types'

// 汽轮发电机组示例数据：刻意覆盖
// 1) 历史已解列记录（按旧口径固化，不随新口径改写）；
// 2) 跨越口径版本的在挂机组（带重算差异轨迹）；
// 3) 厂用电量超限（落设备点检待办）；
// 4) 转速偏低（告警但不阻断、不生待办）。

type SeedInput = {
  id: number
  unitNo: string
  speed: number
  power: number
  online: number
  aux: number
  shift: string
  date: string
  status: string
  carryAcross?: boolean
}

const SEED_INPUTS: SeedInput[] = [
  // 2026-09 口径 v1 时期提交，已解列：历史结论按 v1 冻结。
  { id: 1, unitNo: 'TURB-0001', speed: 3020, power: 12, online: 600, aux: 60, shift: '白班', date: '2026-09-02', status: '已解列' },
  // 2026-09-28 v1 时期提交、仍在运行：10 月 v2 发布后重算过一次，阈值区间留痕。
  { id: 2, unitNo: 'TURB-0001', speed: 3010, power: 13, online: 620, aux: 65, shift: '白班', date: '2026-09-28', status: '运行中', carryAcross: true },
  // 10 月 v2 口径下提交，厂用电率 19.1% 超 18% 上限，自动派发点检待办。
  { id: 3, unitNo: 'TURB-0002', speed: 3620, power: 15, online: 680, aux: 130, shift: '白班', date: '2026-10-06', status: '运行中' },
  // 同机组夜班另一条（班次不同，不与 id=3 合并）：转速偏低，告警但不阻断、不生待办。
  { id: 4, unitNo: 'TURB-0002', speed: 3500, power: 14, online: 660, aux: 60, shift: '夜班', date: '2026-10-06', status: '运行中' },
]

// v1 / v2 两版阈值来自 DEFAULT_RULES：9 月转速 ±2%、厂用电率 5%~15%；10 月上限放宽至 18%。

function judge(input: SeedInput, date: string): TurbineJudge {
  return evaluateTurbine({
    unitNo: input.unitNo,
    speed: input.speed,
    online: input.online,
    aux: input.aux,
    rule: ruleAt(DEFAULT_RULES, date),
  })
}

export function buildTurbineSeed(): TurbineRow[] {
  return SEED_INPUTS.map((input) => {
    const active = input.status === '运行中' || input.status === '待并网'
    const submitJudge = judge(input, input.date)
    const currentRule = active ? ruleAt(DEFAULT_RULES, '2026-10-07') : ruleAt(DEFAULT_RULES, input.date)
    const currentJudge = active ? judge(input, '2026-10-07') : submitJudge

    const recomputeLog =
      input.carryAcross && submitJudge.ruleVersion !== currentJudge.ruleVersion
        ? [buildDiff(submitJudge, currentJudge, currentRule.effectiveDate)]
        : []

    return {
      id: input.id,
      status: input.status,
      pending: active,
      abnormal: currentJudge.abnormal,
      机组编号: input.unitNo,
      机组转速: input.speed,
      发电功率: input.power,
      上网电量: input.online,
      厂用电量: input.aux,
      运行班次: input.shift,
      记录时间: input.date,
      机组状态: input.status,
      dedupKey: buildDedupKey(input.unitNo, input.date, input.shift),
      submitCount: 1,
      updatedAt: `${input.date}T08:00:00.000Z`,
      judgeAt: input.date,
      submitJudge,
      currentJudge,
      recomputeLog,
    } satisfies TurbineRow
  })
}

/** 厂用电量超限记录（id=3）对应的设备点检自动待办，与 syncAuxTodos 产物保持同构。 */
export function buildAuxTodoSeed(): EntryRow {
  return {
    id: 4,
    status: '待点检',
    pending: true,
    abnormal: true,
    点检编号: 'EQUI-TURB-0003',
    点检设备: 'TURB-0002 汽轮发电机组（厂用电系统）',
    点检部位: '厂用电计量与辅机能耗',
    点检方法: '核查厂用电量表计、辅机运行方式与计量数据',
    点检结果: '厂用电量超限：厂用电率 19.1%，高于口径 v2 上限 18%，超出 1.1 个百分点（2026-10-06 白班）',
    点检人员: '系统自动派发',
    点检日期: '2026-10-06',
    点检状态: '待点检',
    来源记录: 'turbine:3',
  }
}
