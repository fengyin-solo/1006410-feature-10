<template>
  <section class="page" data-module="turbine">
    <header class="page-head">
      <div>
        <h2>汽轮发电机组管理</h2>
        <p class="page-desc">维护发电机组运行记录，围绕机组编号、机组转速、发电功率、上网电量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记发电机组运行记录</button>
        <button class="btn" type="button" @click="exportRows">导出汽轮发电机组清单</button>
      </div>
    </header>

    <section class="panel">
      <header class="panel-head">
        <strong>统一判定口径（v{{ rule.version }}，{{ rule.updatedAt }} 起用）</strong>
        <span class="panel-actions">
          <button class="link" type="button" @click="toggleRuleForm">调整口径</button>
          <button class="link" type="button" @click="manualRecalc">按当前口径重算挂着的机组</button>
        </span>
      </header>
      <p class="panel-desc">
        转速上下限 = 额定转速 × {{ rule.speedLowerRatio }} ~ × {{ rule.speedUpperRatio }}；
        厂用电量合理区间 = 额定功率 × {{ rule.plantPowerMinRatio }} ~ × {{ rule.plantPowerMaxRatio }}。
        按机组编号取一次数，列表、明细、告警都从这份判定取数。
      </p>
      <form v-if="showRuleForm" class="inline-form" @submit.prevent="applyRuleChange">
        <label class="form-item">
          <span>转速下限系数</span>
          <input v-model.number="ruleForm.speedLowerRatio" type="number" step="0.001" min="0" />
        </label>
        <label class="form-item">
          <span>转速上限系数</span>
          <input v-model.number="ruleForm.speedUpperRatio" type="number" step="0.001" min="0" />
        </label>
        <label class="form-item">
          <span>厂用电下限系数</span>
          <input v-model.number="ruleForm.plantPowerMinRatio" type="number" step="0.001" min="0" />
        </label>
        <label class="form-item">
          <span>厂用电上限系数</span>
          <input v-model.number="ruleForm.plantPowerMaxRatio" type="number" step="0.001" min="0" />
        </label>
        <button class="btn primary" type="submit">保存口径并重算</button>
      </form>
      <p v-if="ruleMessage" class="ok-text">{{ ruleMessage }}</p>
      <ul v-if="diffs.length" class="note-list">
        <li v-for="diff in diffs" :key="diff.id">
          {{ diff.机组编号 }}（{{ diff.记录时间 }}，口径 {{ diff.口径变化 }}）：{{ diff.变化.join('；') }}
        </li>
      </ul>
    </section>

    <section v-if="alarms.length" class="panel panel-alarm">
      <header class="panel-head">
        <strong>告警（{{ alarms.length }}）</strong>
        <span class="panel-desc">与列表、明细同一份判定</span>
      </header>
      <ul class="note-list">
        <li v-for="item in alarms" :key="String(item.row.id)">
          {{ item.row.机组编号 }} · {{ item.row.记录时间 }} {{ item.row.运行班次 }}：
          <span v-if="item.judgment.转速判定 !== '正常' && item.judgment.转速判定 !== '未判定'">
            转速{{ item.judgment.转速说明 }}；
          </span>
          <span v-if="item.judgment.厂用电判定 === '越限'">厂用电量{{ item.judgment.厂用电说明 }}</span>
        </li>
      </ul>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showCreate" class="panel" @submit.prevent="submitCreate">
      <header class="panel-head">
        <strong>登记发电机组运行记录</strong>
        <span v-if="formLimits" class="panel-desc">
          按机组编号取数（口径 v{{ formLimits.口径版本 }}）：转速 {{ formLimits.转速下限 }}~{{ formLimits.转速上限 }}；
          厂用电量合理区间 {{ formLimits.厂用电下限 }}~{{ formLimits.厂用电上限 }}
        </span>
      </header>
      <div class="inline-form">
        <label class="form-item">
          <span>机组编号</span>
          <select v-model="form.机组编号">
            <option v-for="unit in units" :key="unit.机组编号" :value="unit.机组编号">
              {{ unit.机组编号 }}（额定 {{ unit.额定转速 }} rpm / {{ unit.额定功率 }} kW）
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>机组转速</span>
          <input v-model.number="form.机组转速" type="number" placeholder="rpm" />
        </label>
        <label class="form-item">
          <span>发电功率</span>
          <input v-model.number="form.发电功率" type="number" placeholder="kW" />
        </label>
        <label class="form-item">
          <span>上网电量</span>
          <input v-model.number="form.上网电量" type="number" placeholder="kWh" />
        </label>
        <label class="form-item">
          <span>厂用电量</span>
          <input v-model.number="form.厂用电量" type="number" placeholder="kWh" />
        </label>
        <label class="form-item">
          <span>运行班次</span>
          <select v-model="form.运行班次">
            <option v-for="shift in shiftOptions" :key="shift" :value="shift">{{ shift }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>记录时间</span>
          <input v-model="form.记录时间" type="date" />
        </label>
        <button class="btn primary" type="submit">提交</button>
      </div>
      <p v-if="createMessage" :class="createOk ? 'ok-text' : 'error-text'">{{ createMessage }}</p>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>转速判定</th>
          <th>厂用电判定</th>
          <th>口径版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          class="clickable"
          :class="{ selected: selected && Number(selected.id) === Number(row.id) }"
          @click="openDetail(row)"
        >
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span class="judge" :class="judgeClass(judgmentOf(row).转速判定)">
              {{ judgmentOf(row).转速判定 }}
            </span>
          </td>
          <td>
            <span class="judge" :class="judgeClass(judgmentOf(row).厂用电判定)">
              {{ judgmentOf(row).厂用电判定 }}
            </span>
          </td>
          <td>{{ judgmentOf(row).limits ? `v${judgmentOf(row).limits?.口径版本}` : '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click.stop="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无汽轮发电机组数据，可先登记发电机组运行记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="panel">
      <header class="panel-head">
        <strong>明细：{{ selected.机组编号 }} · {{ selected.记录时间 }} {{ selected.运行班次 }}</strong>
        <button class="link" type="button" @click="selected = null">收起</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ selected[column] ?? '—' }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ selected.status }}</dd>
      </dl>
      <div v-if="selectedJudgment && selectedJudgment.limits" class="detail-judge">
        <p>
          判定（口径 v{{ selectedJudgment.limits.口径版本 }}）：
          转速{{ selectedJudgment.转速判定 }}（{{ selectedJudgment.转速说明 }}）；
          厂用电量{{ selectedJudgment.厂用电判定 }}（{{ selectedJudgment.厂用电说明 }}）。
        </p>
        <p class="panel-desc">
          判定阈值：转速 {{ selectedJudgment.limits.转速下限 }}~{{ selectedJudgment.limits.转速上限 }}；
          厂用电量 {{ selectedJudgment.limits.厂用电下限 }}~{{ selectedJudgment.limits.厂用电上限 }}。
          历史记录按当时的阈值保留，不随新口径追溯改写。
        </p>
      </div>
      <div v-if="selectedRecalc.length">
        <strong>重算记录</strong>
        <ul class="note-list">
          <li v-for="log in selectedRecalc" :key="log.id">
            {{ log.时间 }}，口径 {{ log.口径变化 }}：{{ log.变化.join('；') }}
          </li>
        </ul>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条汽轮发电机组记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  adjustTurbineRule,
  currentTurbineRule,
  ensureTurbineSnapshots,
  limitsForUnit,
  recalcLogFor,
  recalcPendingTurbineUnits,
  submitTurbineRecord,
  unitOptions,
} from '@/api/turbine-service'
import { judgeRow } from '@/data/turbine-limits'
import type { Judgment, RecalcDiff } from '@/data/turbine-limits'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('turbine')
const columns = ["机组编号", "机组转速", "发电功率", "上网电量", "厂用电量", "运行班次", "记录时间", "机组状态"]
const actions = ["提交并网", "登记解列", "上报故障"]
const statuses = ["待并网", "运行中", "已解列", "故障停机"]
const shiftOptions = ["白班", "中班", "夜班"]

const rows = ref<EntryRow[]>([])
const allRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统一判定：列表、明细、告警都从这一份取数。
const judgments = computed(() => {
  const map = new Map<number, Judgment>()
  for (const row of allRows.value) {
    map.set(Number(row.id), judgeRow(row))
  }
  return map
})

const FALLBACK_JUDGMENT: Judgment = {
  转速判定: '未判定',
  转速说明: '记录不在当前列表',
  转速超限值: 0,
  厂用电判定: '未判定',
  厂用电说明: '记录不在当前列表',
  判定异常: false,
  limits: null,
}

function judgmentOf(row: EntryRow): Judgment {
  return judgments.value.get(Number(row.id)) ?? FALLBACK_JUDGMENT
}

const alarms = computed(() =>
  allRows.value
    .map((row) => ({ row, judgment: judgmentOf(row) }))
    .filter((item) => item.judgment.判定异常),
)

const stats = computed(() => [
  { label: '运行中机组', value: countStatus('运行中') },
  { label: '已解列机组', value: countStatus('已解列') },
  { label: '故障停机机组', value: countStatus('故障停机') },
  { label: '判定异常', value: alarms.value.length },
])

function countStatus(status: string): number {
  return allRows.value.filter((row) => String(row.status) === status).length
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: countStatus(status),
  })),
)

// 判定口径：当前版本、调整表单、重算差异。
const rule = ref(currentTurbineRule())
const showRuleForm = ref(false)
const ruleForm = ref({ ...pickRuleParams(rule.value) })
const ruleMessage = ref('')
const diffs = ref<RecalcDiff[]>([])

function pickRuleParams(source: typeof rule.value) {
  return {
    speedLowerRatio: source.speedLowerRatio,
    speedUpperRatio: source.speedUpperRatio,
    plantPowerMinRatio: source.plantPowerMinRatio,
    plantPowerMaxRatio: source.plantPowerMaxRatio,
  }
}

function toggleRuleForm() {
  showRuleForm.value = !showRuleForm.value
  if (showRuleForm.value) {
    ruleForm.value = { ...pickRuleParams(rule.value) }
  }
}

function applyRuleChange() {
  const result = adjustTurbineRule({ ...ruleForm.value })
  ruleMessage.value = result.message
  diffs.value = result.diffs
  if (result.ok) {
    rule.value = currentTurbineRule()
    showRuleForm.value = false
    reload()
  }
}

function manualRecalc() {
  diffs.value = recalcPendingTurbineUnits()
  ruleMessage.value = diffs.value.length
    ? `已按当前口径重算 ${diffs.value.length} 条挂着的记录，差异见下`
    : '挂着的记录与当前口径一致，无需重算'
  reload()
}

// 登记表单：越过上限的转速会被退回，并写清超了多少。
const units = unitOptions()
const showCreate = ref(false)
const createMessage = ref('')
const createOk = ref(false)
const form = ref({
  机组编号: units[0]?.机组编号 ?? '',
  机组转速: '' as number | string,
  发电功率: '' as number | string,
  上网电量: '' as number | string,
  厂用电量: '' as number | string,
  运行班次: shiftOptions[0],
  记录时间: new Date().toISOString().slice(0, 10),
})

const formLimits = computed(() => limitsForUnit(form.value.机组编号))

function toggleCreate() {
  showCreate.value = !showCreate.value
  createMessage.value = ''
}

function submitCreate() {
  const result = submitTurbineRecord({
    机组编号: form.value.机组编号,
    机组转速: Number(form.value.机组转速),
    发电功率: Number(form.value.发电功率),
    上网电量: Number(form.value.上网电量),
    厂用电量: Number(form.value.厂用电量),
    运行班次: form.value.运行班次,
    记录时间: form.value.记录时间,
  })
  createOk.value = result.ok
  createMessage.value = result.message
  if (result.ok) {
    form.value = { ...form.value, 机组转速: '', 发电功率: '', 上网电量: '', 厂用电量: '' }
    reload()
  }
}

// 明细面板：判定阈值、判定结果、重算前后差异。
const selected = ref<EntryRow | null>(null)
const recalcVersion = ref(0)

const selectedJudgment = computed(() =>
  selected.value ? judgmentOf(selected.value) : null,
)
const selectedRecalc = computed(() => {
  recalcVersion.value
  return selected.value ? recalcLogFor(Number(selected.value.id)) : []
})

function openDetail(row: EntryRow) {
  selected.value = row
}

function judgeClass(value: string): string {
  if (value === '正常') {
    return 'ok'
  }
  if (value === '偏低') {
    return 'warn'
  }
  if (value === '超高' || value === '越限') {
    return 'bad'
  }
  return 'none'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    allRows.value = listRows(meta.key)
    recalcVersion.value += 1
    if (selected.value) {
      const fresh = allRows.value.find((row) => Number(row.id) === Number(selected.value?.id))
      selected.value = fresh ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '汽轮发电机组列表读取失败'
  }
}

onMounted(() => {
  ensureTurbineSnapshots()
  reload()
})
</script>
