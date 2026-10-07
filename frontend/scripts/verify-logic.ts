/** 统一口径业务规则验证（构建后由 esbuild 打包成临时 ESM 在 Node 中执行）。 */
// 在任何数据层模块初始化之前注入内存版 localStorage（浏览器 API 桩）。
const storage = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  },
}

import { listRows } from '../src/data/local-store'
import { latestRule, listRules, thresholdsFor, unitSpec } from '../src/data/turbine-rule'
import {
  applyTurbineAction,
  getTurbineRow,
  listTurbineRows,
  publishRule,
  submitTurbine,
  syncAuxTodos,
  turbineAlerts,
} from '../src/data/turbine-store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

// 1. 阈值按机组编号取数：两台机组区间不同
const r2 = latestRule(listRules())
const t1 = thresholdsFor(unitSpec('TURB-0001')!, r2)
const t2 = thresholdsFor(unitSpec('TURB-0002')!, r2)
check('1号机转速区间 2940~3060', t1.speedMin === 2940 && t1.speedMax === 3060, JSON.stringify(t1))
check('2号机转速区间 3528~3672', t2.speedMin === 3528 && t2.speedMax === 3672, JSON.stringify(t2))
check('厂用电量区间同版规则一致 5~18', t1.auxKwhMin === 5 && t1.auxKwhMax === 18 && t2.auxKwhMax === 18)

// 2. 种子：历史解列按 v1 冻结；跨版本在挂带重算日志
const rows0 = listTurbineRows()
check('种子共 4 条', rows0.length === 4, String(rows0.length))
const closed = rows0.find((r) => r.id === 1)!
check('解列记录提交口径 v1', closed.submitJudge.ruleVersion === 1)
check('解列记录当前判定冻结在 v1', closed.currentJudge.ruleVersion === 1)
check('解列记录无重算日志', closed.recomputeLog.length === 0)
const cross = rows0.find((r) => r.id === 2)!
check('跨版本在挂机提交口径 v1', cross.submitJudge.ruleVersion === 1)
check('跨版本在挂机当前口径 v2', cross.currentJudge.ruleVersion === 2)
check('跨版本在挂机保留重算差异', cross.recomputeLog.length === 1 && cross.recomputeLog[0].fromVersion === 1 && cross.recomputeLog[0].toVersion === 2)
check('重算差异记录两版转速区间', cross.recomputeLog[0].speedRangeBefore[1] === 3060 && cross.recomputeLog[0].speedRangeAfter[1] === 3060)

// 3. 厂用电超限行 + 自动点检待办
const over = rows0.find((r) => r.id === 3)!
check('id=3 厂用电率 19.1% 超限', over.currentJudge.aux.verdict === '超限' && over.currentJudge.aux.rate === 19.1 && over.currentJudge.aux.gap === 1.1)
const todos = listRows('equipcheck').filter((r) => String(r.点检编号).startsWith('EQUI-TURB-'))
check('点检清单有 1 条自动待办', todos.length === 1, String(todos.length))
check('自动待办来源 turbine:3', todos[0]['来源记录'] === 'turbine:3')

// 4. 转速偏低行：告警但正常保存、不生成待办
const low = rows0.find((r) => r.id === 4)!
check('id=4 转速 3500 偏低', low.currentJudge.speed.verdict === '偏低' && low.currentJudge.speed.gap === -28)
check('id=4 厂用电正常', low.currentJudge.aux.verdict === '正常')
const alerts = turbineAlerts()
check('告警含转速偏低与厂用电超限', alerts.some((a) => a.kind === 'speed' && a.label.includes('转速偏低')) && alerts.some((a) => a.kind === 'aux'))
check('厂用电告警带待办标记', alerts.find((a) => a.rowId === 3 && a.kind === 'aux')!.hasTodo === true)

// 5. 越上限转速不允许保存，并写清超了多少
const reject = submitTurbine({ unitNo: 'TURB-0001', speed: 3100, power: 12, online: 600, aux: 60, shift: '白班', date: '2026-10-07' })
check('超上限保存被拒收', reject.ok === false)
check('退回信息写清上限与超出量', reject.message.includes('3060') && reject.message.includes('超出 40 r/min'), reject.message)
check('拒收后记录数不变', listTurbineRows().length === 4)

// 6. 合法数据可保存
const ok = submitTurbine({ unitNo: 'TURB-0001', speed: 3000, power: 12, online: 500, aux: 50, shift: '夜班', date: '2026-10-07' })
check('合法记录保存成功', ok.ok && ok.rowId === 5, ok.message)

// 7. 同机组同时段重复提交只留最新版
const dup = submitTurbine({ unitNo: 'TURB-0001', speed: 3005, power: 13, online: 520, aux: 52, shift: '夜班', date: '2026-10-07' })
check('重复提交被识别为覆盖', dup.ok && dup.message.includes('覆盖') && dup.message.includes('第 2 次'), dup.message)
check('覆盖后总数不增加', listTurbineRows().length === 5)
const covered = getTurbineRow(5)!
check('覆盖后取最新数值', covered.机组转速 === 3005 && covered.上网电量 === 520 && covered.submitCount === 2)

// 8. 发布 v3（收紧转速到 ±1%）：在挂机重算、留差异；历史解列不动
const pub = publishRule({ effectiveDate: '2026-10-07', speedTolerance: 0.01, auxRateMin: 5, auxRateMax: 18, note: '收紧转速 ±1%' })
check('v3 发布成功', pub.ok, pub.message)
check('v3 重算所有在挂机（4 台）', (pub.result?.recomputed ?? 0) === 4, String(pub.result?.recomputed))
const id4 = getTurbineRow(4)!
check('收紧后 id=4 转速仍偏低', id4.currentJudge.speed.verdict === '偏低')
check('收紧后 id=4 下限变为 3564', id4.currentJudge.speed.speedMin === 3564, String(id4.currentJudge.speed.speedMin))
const id3 = getTurbineRow(3)!
check('收紧后 id=3 转速 3620 在新区间 3564~3636 内正常', id3.currentJudge.speed.verdict === '正常', JSON.stringify({ min: id3.currentJudge.speed.speedMin, max: id3.currentJudge.speed.speedMax }))
check('id=4 新增一条 v2→v3 重算差异', id4.recomputeLog[0].fromVersion === 2 && id4.recomputeLog[0].toVersion === 3)
const closedAfter = getTurbineRow(1)!
check('历史解列记录不按新口径追溯', closedAfter.currentJudge.ruleVersion === 1 && closedAfter.recomputeLog.length === 0)
check('口径版本表只增不改', listRules().length === 3 && listRules()[0].version === 1)

// 9. 状态流转到解列后，再发新版也不重算它
applyTurbineAction(4, '登记解列')
publishRule({ effectiveDate: '2026-10-08', speedTolerance: 0.005, auxRateMin: 5, auxRateMax: 18, note: '再收紧 ±0.5%' })
const id4b = getTurbineRow(4)!
check('解列后当前判定冻结在 v3', id4b.currentJudge.ruleVersion === 3 && id4b.status === '已解列')

// 10. 厂用电恢复正常后自动待办移除
syncAuxTodos()
submitTurbine({ unitNo: 'TURB-0002', speed: 3600, power: 15, online: 680, aux: 80, shift: '白班', date: '2026-10-06' })
// 注意：同键覆盖 id=3（白班 10-06），80/680=11.8% 正常 → 待办应消失
const todosAfter = listRows('equipcheck').filter((r) => String(r.点检编号).startsWith('EQUI-TURB-'))
check('厂用电恢复正常后自动待办闭环移除', todosAfter.length === 0, String(todosAfter.length))
check('人工点检记录不受影响（保留 3 条样例）', listRows('equipcheck').filter((r) => !String(r.点检编号).startsWith('EQUI-TURB-')).length === 3)

// 11. 列表/告警/明细同源：currentJudge 是唯一结论
const same = listTurbineRows().every((r) => {
  const a = turbineAlerts().filter((x) => x.rowId === r.id)
  const expectSpeed = r.currentJudge.speed.verdict !== '正常'
  const expectAux = r.currentJudge.aux.verdict !== '正常'
  return a.some((x) => x.kind === 'speed') === expectSpeed && a.filter((x) => x.kind === 'aux').length === (expectAux ? 1 : 0)
})
check('告警与行判定完全同源', same)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
