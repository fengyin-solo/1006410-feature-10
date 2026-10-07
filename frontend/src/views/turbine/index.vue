<template>
  <section class="page" data-module="turbine">
    <header class="page-head">
      <div>
        <h2>汽轮发电机组管理</h2>
        <p class="page-desc">
          转速上下限与厂用电量区间按同一套口径计算：按机组编号取额定值，套用当前生效的阈值版本。
          列表、明细、告警值班全部从这一份判定取数。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发电机组运行记录</button>
        <button class="btn" type="button" @click="openRulebook">阈值口径管理</button>
        <button class="btn" type="button" @click="exportRows">导出汽轮发电机组清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 告警值班：与列表、明细同一份判定，不单独拍数 -->
    <section v-if="alerts.length" class="alert-board">
      <h3 class="alert-title">告警值班（统一口径 v{{ currentRule.version }} 生效于 {{ currentRule.effectiveDate }}）</h3>
      <ul class="alert-list">
        <li v-for="(alert, index) in alerts" :key="`${alert.rowId}-${alert.kind}-${index}`" class="alert-item">
          <span :class="['alert-badge', alert.kind === 'speed' ? 'badge-speed' : 'badge-aux']">
            {{ alert.kind === 'speed' ? '转速' : '厂用电' }}
          </span>
          <div class="alert-body">
            <strong>{{ alert.label }}</strong>
            <span>{{ alert.detail }}</span>
          </div>
          <button class="link" type="button" @click="openDetail(alert.rowId)">查看明细</button>
          <RouterLink v-if="alert.kind === 'aux'" class="link" to="/equipcheck">前往点检待办</RouterLink>
        </li>
      </ul>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <th>机组编号</th>
          <th>机组转速 (r/min)</th>
          <th>发电功率 (MW)</th>
          <th>上网电量 (MW·h)</th>
          <th>厂用电量 (MW·h)</th>
          <th>运行班次</th>
          <th>记录时间</th>
          <th>转速判定</th>
          <th>厂用电判定</th>
          <th>判定口径</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.机组编号 }}</td>
          <td>{{ row.机组转速 }}</td>
          <td>{{ row.发电功率 }}</td>
          <td>{{ row.上网电量 }}</td>
          <td>{{ row.厂用电量 }}</td>
          <td>{{ row.运行班次 }}</td>
          <td>{{ row.记录时间 }}</td>
          <td>
            <span :class="['judge-tag', tagClass(row.currentJudge.speed.verdict)]">
              {{ row.currentJudge.speed.verdict }}
              <small v-if="row.currentJudge.speed.verdict !== '正常'">
                （{{ row.currentJudge.speed.verdict === '超上限' ? '+' : '' }}{{ row.currentJudge.speed.gap }}）
              </small>
            </span>
          </td>
          <td>
            <span :class="['judge-tag', tagClass(row.currentJudge.aux.verdict)]">
              {{ row.currentJudge.aux.verdict }}
              <small v-if="row.currentJudge.aux.verdict !== '正常'">（{{ row.currentJudge.aux.rate }}%）</small>
            </span>
          </td>
          <td>v{{ row.currentJudge.ruleVersion }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row.id)">明细</button>
            <button class="link" type="button" @click="runAction('提交并网', row)">并网</button>
            <button class="link" type="button" @click="runAction('登记解列', row)">解列</button>
            <button class="link" type="button" @click="runAction('上报故障', row)">故障</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="12" class="empty-state">暂无汽轮发电机组数据，可先登记发电机组运行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条记录 · 历史记录按提交时口径保留，在挂机组按现行口径重算</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 登记表单 -->
    <div v-if="formOpen" class="modal-mask" @click.self="formOpen = false">
      <div class="modal">
        <h3>登记发电机组运行记录</h3>
        <p class="modal-hint">
          当前口径 v{{ liveRule.version }}（生效 {{ liveRule.effectiveDate }}）：
          转速按额定值 ±{{ (liveRule.speedTolerance * 100).toFixed(0) }}%，厂用电率 {{ liveRule.auxRateMin }}%～{{ liveRule.auxRateMax }}%
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>机组编号</span>
            <select v-model="form.unitNo">
              <option v-for="spec in unitSpecs" :key="spec.unitNo" :value="spec.unitNo">
                {{ spec.unitNo }}（额定 {{ spec.ratedSpeed }} r/min）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>机组转速 (r/min)</span>
            <input v-model.number="form.speed" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>发电功率 (MW)</span>
            <input v-model.number="form.power" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>上网电量 (MW·h)</span>
            <input v-model.number="form.online" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>厂用电量 (MW·h)</span>
            <input v-model.number="form.aux" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>运行班次</span>
            <select v-model="form.shift">
              <option>白班</option>
              <option>夜班</option>
            </select>
          </label>
          <label class="form-item">
            <span>记录时间</span>
            <input v-model="form.date" type="date" />
          </label>
        </div>

        <div v-if="livePreview" class="preview-box">
          <p>
            本次适用口径
            <strong>v{{ livePreview.ruleVersion }}</strong>
            （按记录日期取生效版本），允许区间：
            转速 {{ livePreview.speed.speedMin }}～{{ livePreview.speed.speedMax }} r/min；
            厂用电量 {{ livePreview.aux.auxKwhMin }}～{{ livePreview.aux.auxKwhMax }} MW·h
          </p>
          <p :class="livePreview.speed.verdict === '超上限' ? 'error-text' : ''">
            转速判定：{{ livePreview.speed.verdict }}
            <template v-if="livePreview.speed.verdict === '超上限'">
              ，超出 {{ livePreview.speed.gap }} r/min，保存将被退回
            </template>
          </p>
          <p :class="livePreview.aux.verdict !== '正常' ? 'warn-text' : ''">
            厂用电判定：{{ livePreview.aux.verdict }}（厂用电率 {{ livePreview.aux.rate }}%）
            <template v-if="livePreview.aux.verdict === '超限'">，保存后自动派发设备点检待办</template>
          </p>
        </div>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="formOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitForm">保存</button>
        </div>
      </div>
    </div>

    <!-- 明细面板 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = undefined">
      <div class="modal modal-wide">
        <h3>{{ detailRow.机组编号 }} 运行记录明细（编号 {{ detailRow.id }}）</h3>
        <div class="detail-grid">
          <div><span>机组转速</span><strong>{{ detailRow.机组转速 }} r/min</strong></div>
          <div><span>发电功率</span><strong>{{ detailRow.发电功率 }} MW</strong></div>
          <div><span>上网电量</span><strong>{{ detailRow.上网电量 }} MW·h</strong></div>
          <div><span>厂用电量</span><strong>{{ detailRow.厂用电量 }} MW·h</strong></div>
          <div><span>运行班次</span><strong>{{ detailRow.运行班次 }}</strong></div>
          <div><span>记录时间</span><strong>{{ detailRow.记录时间 }}</strong></div>
          <div><span>当前状态</span><strong>{{ detailRow.status }}</strong></div>
          <div><span>累计提交</span><strong>{{ detailRow.submitCount }} 次（同时段重复提交只留最新版）</strong></div>
        </div>

        <div class="judge-blocks">
          <div class="judge-block">
            <h4>提交时判定（历史口径，不追溯改写）</h4>
            <JudgeView :judge="detailRow.submitJudge" />
          </div>
          <div class="judge-block">
            <h4>当前判定{{ isActive(detailRow.status) ? '（在挂机按现行口径重算）' : '（已下网，结论冻结）' }}</h4>
            <JudgeView :judge="detailRow.currentJudge" />
          </div>
        </div>

        <div v-if="detailRow.recomputeLog.length" class="recompute-log">
          <h4>重算前后差异（{{ detailRow.recomputeLog.length }} 次）</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>重算日期</th><th>口径变化</th>
                <th>转速区间（前 → 后）</th><th>转速结论（前 → 后）</th>
                <th>厂用电率区间（前 → 后）</th><th>厂用电结论（前 → 后）</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(diff, i) in detailRow.recomputeLog" :key="i">
                <td>{{ diff.at }}</td>
                <td>v{{ diff.fromVersion }} → v{{ diff.toVersion }}{{ diff.changed ? '（结论变化）' : '' }}</td>
                <td>{{ diff.speedRangeBefore[0] }}～{{ diff.speedRangeBefore[1] }} → {{ diff.speedRangeAfter[0] }}～{{ diff.speedRangeAfter[1] }}</td>
                <td>{{ diff.speedBefore }} → {{ diff.speedAfter }}</td>
                <td>{{ diff.auxRateBefore[0] }}%～{{ diff.auxRateBefore[1] }}% → {{ diff.auxRateAfter[0] }}%～{{ diff.auxRateAfter[1] }}%</td>
                <td>{{ diff.auxBefore }} → {{ diff.auxAfter }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-actions">
          <RouterLink v-if="detailRow.currentJudge.aux.verdict === '超限'" class="btn" to="/equipcheck">查看点检待办</RouterLink>
          <button class="btn primary" type="button" @click="detailRow = undefined">关闭</button>
        </div>
      </div>
    </div>

    <!-- 阈值口径管理 -->
    <div v-if="ruleOpen" class="modal-mask" @click.self="ruleOpen = false">
      <div class="modal modal-wide">
        <h3>阈值口径管理（只增不改）</h3>
        <table class="data-table">
          <thead>
            <tr><th>版本</th><th>生效日期</th><th>转速浮动</th><th>厂用电率区间</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="rule in rules" :key="rule.version">
              <td>v{{ rule.version }}{{ rule.version === currentRule.version ? '（现行）' : '' }}</td>
              <td>{{ rule.effectiveDate }}</td>
              <td>±{{ (rule.speedTolerance * 100).toFixed(0) }}%</td>
              <td>{{ rule.auxRateMin }}%～{{ rule.auxRateMax }}%</td>
              <td>{{ rule.note }}</td>
            </tr>
          </tbody>
        </table>

        <h4 class="publish-title">发布新版口径</h4>
        <div class="form-grid">
          <label class="form-item">
            <span>生效日期</span>
            <input v-model="ruleForm.effectiveDate" type="date" />
          </label>
          <label class="form-item">
            <span>转速浮动（0～50%）</span>
            <input v-model.number="ruleForm.speedTolerancePct" type="number" min="1" max="50" />
          </label>
          <label class="form-item">
            <span>厂用电率下限 (%)</span>
            <input v-model.number="ruleForm.auxRateMin" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>厂用电率上限 (%)</span>
            <input v-model.number="ruleForm.auxRateMax" type="number" min="0" />
          </label>
          <label class="form-item form-wide">
            <span>调整说明</span>
            <input v-model="ruleForm.note" placeholder="为什么要调整这版口径" />
          </label>
        </div>
        <p class="modal-hint">发布后所有「待并网 / 运行中」机组立即按新规则重算一次，重算前后差异写入每条记录；已解列与故障停机记录不动。</p>

        <div v-if="publishResult" class="publish-result">
          <p class="ok-text">{{ publishResult.message }}</p>
          <ul v-if="publishResult.result?.diffs.length">
            <li v-for="item in publishResult.result.diffs" :key="item.row.id">
              {{ item.row.机组编号 }}（{{ item.row.记录时间 }} {{ item.row.运行班次 }}）：
              转速 {{ item.diff.speedBefore }} → {{ item.diff.speedAfter }}，
              厂用电 {{ item.diff.auxBefore }} → {{ item.diff.auxAfter }}
              <span v-if="!item.diff.changed" class="muted-text">（阈值更新，结论未变）</span>
            </li>
          </ul>
        </div>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="ruleOpen = false">关闭</button>
          <button class="btn primary" type="button" @click="publish">发布并重算在挂机组</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  applyTurbineAction,
  getTurbineRow,
  listTurbineRows,
  publishRule,
  submitTurbine,
  syncAuxTodos,
  turbineAlerts,
  turbineStats,
  type PublishResult,
} from '@/data/turbine-store'
import type { ActionResult } from '@/data/types'
import {
  UNIT_SPECS,
  evaluateTurbine,
  isActiveStatus,
  latestRule,
  listRules,
  ruleAt,
  type TurbineJudge,
  type TurbineRow,
} from '@/data/turbine-rule'

// 明细里的判定块：列表/明细/告警共用同一结论结构，这里也只读不算。
const JudgeView = (props: { judge: TurbineJudge }) =>
  h('div', { class: 'judge-view' }, [
    h('p', null, `口径版本：v${props.judge.ruleVersion}（生效 ${props.judge.effectiveDate}），额定转速 ${props.judge.ratedSpeed} r/min`),
    h('p', null, [
      `转速：${props.judge.speed.value} r/min，允许 ${props.judge.speed.speedMin}～${props.judge.speed.speedMax}，`,
      h('strong', { class: props.judge.speed.verdict === '正常' ? 'ok-text' : 'error-text' }, props.judge.speed.verdict),
      props.judge.speed.verdict === '超上限' ? `，超出 ${props.judge.speed.gap} r/min` : '',
      props.judge.speed.verdict === '偏低' ? `，低 ${Math.abs(props.judge.speed.gap)} r/min` : '',
    ]),
    h('p', null, [
      `厂用电：${props.judge.aux.value} MW·h，厂用电率 ${props.judge.aux.rate}%（合理 ${props.judge.aux.auxRateMin}%～${props.judge.aux.auxRateMax}%），`,
      h('strong', { class: props.judge.aux.verdict === '正常' ? 'ok-text' : 'error-text' }, props.judge.aux.verdict),
      props.judge.aux.verdict === '超限' ? `，超出 ${props.judge.aux.gap} 个百分点` : '',
      props.judge.aux.verdict === '偏低' ? `，低 ${Math.abs(props.judge.aux.gap)} 个百分点` : '',
    ]),
  ])
JudgeView.props = ['judge']

const unitSpecs = UNIT_SPECS
const filterFields = ['机组编号', '运行班次', '记录时间']
const statuses = ['待并网', '运行中', '已解列', '故障停机']

const rows = ref<TurbineRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const rules = ref(listRules())
const currentRule = computed(() => latestRule(rules.value))

const stats = computed(() => {
  const s = turbineStats()
  return [
    { label: '运行中/待并网', value: s.active },
    { label: '登记总数', value: s.total },
    { label: '判定异常', value: s.abnormal },
    { label: '厂用电超限（已落点检）', value: s.auxOver },
  ]
})
const alerts = computed(() => turbineAlerts())
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length })),
)

function isActive(status: string): boolean {
  return isActiveStatus(status)
}

function tagClass(verdict: string): string {
  if (verdict === '正常') {
    return 'tag-ok'
  }
  if (verdict === '超上限' || verdict === '超限') {
    return 'tag-bad'
  }
  return 'tag-warn'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('turbine')
}

function flash(message: string, ok = false) {
  errorMessage.value = ok ? '' : message
  okMessage.value = ok ? message : ''
}

function reload() {
  rows.value = listTurbineRows(filters.value)
  total.value = rows.value.length
  rules.value = listRules()
}

function runAction(action: string, row: TurbineRow) {
  const result = applyTurbineAction(row.id, action)
  flash(result.message, result.ok)
  reload()
}

// ── 登记 ──
const today = new Date().toISOString().slice(0, 10)
const formOpen = ref(false)
const form = ref({ unitNo: UNIT_SPECS[0].unitNo, speed: 3000, power: 12, online: 600, aux: 60, shift: '白班', date: today })
const liveRule = computed(() => ruleAt(rules.value, form.value.date || today))
const livePreview = computed<TurbineJudge | undefined>(() => {
  if (!form.value.unitNo) {
    return undefined
  }
  try {
    return evaluateTurbine({
      unitNo: form.value.unitNo,
      speed: Number(form.value.speed),
      online: Number(form.value.online),
      aux: Number(form.value.aux),
      rule: liveRule.value,
    })
  } catch {
    return undefined
  }
})

function openCreate() {
  form.value = { unitNo: UNIT_SPECS[0].unitNo, speed: 3000, power: 12, online: 600, aux: 60, shift: '白班', date: today }
  formOpen.value = true
}

function submitForm() {
  const result = submitTurbine({
    unitNo: form.value.unitNo,
    speed: Number(form.value.speed),
    power: Number(form.value.power),
    online: Number(form.value.online),
    aux: Number(form.value.aux),
    shift: form.value.shift,
    date: form.value.date,
  })
  if (!result.ok) {
    flash(result.message)
    return
  }
  flash(result.message, true)
  formOpen.value = false
  reload()
}

// ── 明细 ──
const detailRow = ref<TurbineRow | undefined>(undefined)

function openDetail(id: number) {
  detailRow.value = getTurbineRow(id)
}

// ── 口径管理 ──
const ruleOpen = ref(false)
const ruleForm = ref({
  effectiveDate: today,
  speedTolerancePct: 2,
  auxRateMin: 5,
  auxRateMax: 18,
  note: '',
})
const publishResult = ref<(ActionResultLike & { result?: PublishResult }) | null>(null)
type ActionResultLike = { ok: boolean; message: string }

function openRulebook() {
  rules.value = listRules()
  const latest = latestRule(rules.value)
  ruleForm.value = {
    effectiveDate: today,
    speedTolerancePct: Math.round(latest.speedTolerance * 100),
    auxRateMin: latest.auxRateMin,
    auxRateMax: latest.auxRateMax,
    note: '',
  }
  publishResult.value = null
  ruleOpen.value = true
}

function publish() {
  const result = publishRule({
    effectiveDate: ruleForm.value.effectiveDate,
    speedTolerance: Number(ruleForm.value.speedTolerancePct) / 100,
    auxRateMin: Number(ruleForm.value.auxRateMin),
    auxRateMax: Number(ruleForm.value.auxRateMax),
    note: ruleForm.value.note,
  })
  publishResult.value = result
  rules.value = listRules()
  syncAuxTodos()
  reload()
}

onMounted(reload)
</script>
