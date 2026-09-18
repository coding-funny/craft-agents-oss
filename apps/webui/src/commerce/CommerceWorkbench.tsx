import React, { useEffect, useMemo, useState } from 'react'
import { commerceClient } from './client'

type View = 'cases' | 'investigate' | 'report' | 'approval' | 'execution' | 'feedback'
type TaskSummary = { taskId: string; version: number; input: { question: string }; resolvedScope?: { shopId: string; skuIds: string[] }; status?: string; reportId?: string; updatedAt: string; completionReason?: string; error?: { message?: string } }
type Proposal = { proposalId: string; status: string; contentHash: string; actionType: string; targetId: string; parameters: Record<string, unknown>; riskLevel: string; expectedImpact: string; rollbackPlan: string; expiresAt: string; targetVersion: number; reviewStatus: string }
type ReportClaim = { factId?: string; hypothesisId?: string; recommendationId?: string; statement?: string; action?: string }
type Report = { reportId: string; generatedAt: string; executiveSummary: { statement: string }; anomalies: ReportClaim[]; hypotheses: ReportClaim[]; unknowns: Array<{ statement: string }>; recommendations: ReportClaim[]; evidence: Array<{ evidenceId: string; summary: string; source: string; asOf: string }> }
type Snapshot = { snapshotVersion: string; task: TaskSummary; run?: { status: string; reportId?: string; clarification?: { question: string; fields: string[] }; error?: { message: string }; completionReason?: string; manifest?: { usage?: { costMicros: number } } }; events: Array<{ eventId: string; sequence: number; type: string; createdAt: string }>; report?: Report; reportVersion?: string; proposals: Proposal[]; executions: Array<{ requestId: string; proposalId: string; status: string; externalOperationId?: string; lastError?: string; updatedAt: string }> }

const views: Array<[View, string]> = [['cases', '案例'], ['investigate', '调查'], ['report', '报告与证据'], ['approval', '审批'], ['execution', '执行结果'], ['feedback', '反馈']]
const statusColor: Record<string, string> = { REPORT_READY: 'bg-emerald-100 text-emerald-800', APPLIED: 'bg-emerald-100 text-emerald-800', FAILED: 'bg-red-100 text-red-800', REJECTED: 'bg-red-100 text-red-800', UNKNOWN: 'bg-amber-100 text-amber-800', MANUAL_REVIEW: 'bg-amber-100 text-amber-800', WAITING_INPUT: 'bg-blue-100 text-blue-800' }

function Badge({ value }: { value?: string }) { return <span className={`rounded-full px-2 py-0.5 text-xs ${statusColor[value ?? ''] ?? 'bg-slate-100 text-slate-700'}`}>{value ?? '尚未运行'}</span> }
function Card({ title, children }: { title: string; children: React.ReactNode }) { return <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><h2 className="mb-3 text-sm font-semibold text-slate-800">{title}</h2>{children}</section> }

export default function CommerceWorkbench() {
  const [view, setView] = useState<View>('cases')
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const reloadTasks = async () => {
    try { setTasks((await commerceClient.get<{ items: TaskSummary[] }>('/api/v1/tasks?limit=50')).items); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  useEffect(() => { void reloadTasks(); const timer = window.setInterval(() => void reloadTasks(), 10_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    if (!selectedId) { setSnapshot(undefined); return }
    let active = true
    const load = async () => { try { const value = await commerceClient.get<Snapshot>(`/api/v1/tasks/${encodeURIComponent(selectedId)}/snapshot`); if (active) { setSnapshot(value); setError('') } } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)) } }
    void load(); const timer = window.setInterval(() => void load(), 3_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [selectedId])

  const selectedProposal = snapshot?.proposals[0]
  const select = (taskId: string, next: View = 'investigate') => { setSelectedId(taskId); setView(next) }
  const act = async (work: () => Promise<unknown>) => { setLoading(true); try { await work(); if (selectedId) setSnapshot(await commerceClient.get(`/api/v1/tasks/${encodeURIComponent(selectedId)}/snapshot`)); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <header className="border-b border-slate-200 bg-slate-950 px-6 py-4 text-white"><div className="mx-auto flex max-w-7xl items-center justify-between"><div><p className="text-xs uppercase tracking-[0.24em] text-cyan-300">Commerce Operations</p><h1 className="text-xl font-semibold">经营异常调查工作台</h1></div><a className="text-sm text-slate-300 hover:text-white" href="/">返回 Agent</a></div></header>
    <div className="mx-auto grid max-w-7xl gap-5 p-5 lg:grid-cols-[220px_1fr]">
      <aside className="space-y-2">{views.map(([id, label]) => <button key={id} onClick={() => setView(id)} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${view === id ? 'bg-cyan-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'}`}>{label}</button>)}</aside>
      <main className="space-y-4">{error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {view === 'cases' && <CaseList tasks={tasks} onSelect={select} />}
        {view === 'investigate' && <Investigation snapshot={snapshot} loading={loading} onCreated={async id => { await reloadTasks(); select(id) }} />}
        {view === 'report' && <ReportView snapshot={snapshot} />}
        {view === 'approval' && <ApprovalView proposal={selectedProposal} loading={loading} onDecision={(decision, reason) => act(() => commerceClient.post(`/api/v1/proposals/${selectedProposal!.proposalId}/${decision}`, { reason, confirmHash: selectedProposal!.contentHash }))} />}
        {view === 'execution' && <ExecutionView snapshot={snapshot} />}
        {view === 'feedback' && <FeedbackView snapshot={snapshot} loading={loading} onSubmit={body => act(() => commerceClient.post('/api/v1/feedback', body))} />}
      </main>
    </div>
  </div>
}

function CaseList({ tasks, onSelect }: { tasks: TaskSummary[]; onSelect: (id: string, view?: View) => void }) {
  return <Card title="案例列表（服务端权限过滤）"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th className="p-2">店铺 / 对象</th><th>问题</th><th>状态</th><th>更新时间</th></tr></thead><tbody>{tasks.map(task => <tr key={task.taskId} onClick={() => onSelect(task.taskId)} className="cursor-pointer border-t hover:bg-slate-50"><td className="p-2">{task.resolvedScope?.shopId ?? '待补充'}<div className="text-xs text-slate-400">{task.resolvedScope?.skuIds?.join(', ')}</div></td><td className="max-w-lg p-2">{task.input.question}</td><td><Badge value={task.status} /></td><td className="whitespace-nowrap text-xs text-slate-500">{new Date(task.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>{tasks.length === 0 && <p className="p-8 text-center text-sm text-slate-500">当前权限范围内没有案例。</p>}</div></Card>
}

function Investigation({ snapshot, loading, onCreated }: { snapshot?: Snapshot; loading: boolean; onCreated: (id: string) => Promise<void> }) {
  const [question, setQuestion] = useState('为什么这个 SKU 最近销量下降？')
  const [shopId, setShopId] = useState('demo-shop'); const [skuId, setSkuId] = useState('SKU-A')
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const currentEnd = new Date(); const currentStart = new Date(currentEnd.getTime() - 7 * 864e5); const baselineStart = new Date(currentStart.getTime() - 7 * 864e5)
    const task = await commerceClient.post<{ taskId: string }>('/api/v1/tasks', { input: { schemaVersion: 1, question, scope: { shopId, skuIds: [skuId], currency: 'CNY', baselineWindow: { start: baselineStart.toISOString(), end: currentStart.toISOString(), timezone: 'Asia/Shanghai' }, currentWindow: { start: currentStart.toISOString(), end: currentEnd.toISOString(), timezone: 'Asia/Shanghai' } } } }, crypto.randomUUID()); await onCreated(task.taskId) }
  return <div className="grid gap-4 xl:grid-cols-2"><Card title="发起调查"><form onSubmit={submit} className="space-y-3"><textarea value={question} onChange={e => setQuestion(e.target.value)} className="min-h-24 w-full rounded-lg border p-2 text-sm" /><div className="grid grid-cols-2 gap-2"><input value={shopId} onChange={e => setShopId(e.target.value)} className="rounded-lg border p-2 text-sm" aria-label="店铺"/><input value={skuId} onChange={e => setSkuId(e.target.value)} className="rounded-lg border p-2 text-sm" aria-label="SKU"/></div><button disabled={loading} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm text-white disabled:opacity-50">创建持久调查</button></form></Card><Card title="调查状态">{snapshot ? <div className="space-y-3 text-sm"><Badge value={snapshot.run?.status} /><p>{snapshot.run?.clarification?.question ?? snapshot.run?.completionReason ?? '任务已持久化，等待 Worker。'}</p>{snapshot.run?.error && <p className="text-red-700">{snapshot.run.error.message}</p>}<ol className="max-h-64 space-y-1 overflow-auto text-xs text-slate-500">{snapshot.events.map(event => <li key={event.eventId}>#{event.sequence} {event.type} · {new Date(event.createdAt).toLocaleString()}</li>)}</ol></div> : <p className="text-sm text-slate-500">从案例列表选择任务；刷新页面不会重新创建任务。</p>}</Card></div>
}

function ReportView({ snapshot }: { snapshot?: Snapshot }) { const report = snapshot?.report; const evidence = report?.evidence ?? []; return <div className="space-y-4"><Card title="结论、反证与未知项">{report ? <div className="space-y-3 text-sm"><p className="text-base font-medium">{report.executiveSummary.statement}</p><div><b>假设：</b>{report.hypotheses.map(item => item.statement).join('；')}</div><div><b>未知项：</b>{report.unknowns.map(item => item.statement).join('；') || '无'}</div><p className="text-xs text-slate-500">数据时间：{report.generatedAt}</p></div> : <p className="text-sm text-slate-500">尚无通过质量门禁的报告。</p>}</Card><Card title="证据与口径"><div className="space-y-2">{evidence.map(item => <details key={item.evidenceId} className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">{item.summary}</summary><p className="mt-2 text-xs text-slate-500">{item.evidenceId} · {item.source} · as of {item.asOf}</p></details>)}</div></Card></div> }

function ApprovalView({ proposal, loading, onDecision }: { proposal?: Proposal; loading: boolean; onDecision: (decision: 'approve' | 'reject', reason: string) => void }) { const [reason, setReason] = useState('已核对报告、证据和目标版本'); return <Card title="人工审批">{proposal ? <div className="space-y-3 text-sm"><div className="flex items-center gap-2"><Badge value={proposal.status}/><span>风险 {proposal.riskLevel} · 目标版本 {proposal.targetVersion}</span></div><p>{proposal.actionType} / {proposal.targetId}</p><pre className="overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(proposal.parameters, null, 2)}</pre><p><b>预期：</b>{proposal.expectedImpact}</p><p><b>回滚：</b>{proposal.rollbackPlan}</p><p className="break-all text-xs text-slate-500">页面内容 Hash：{proposal.contentHash}</p><input value={reason} onChange={e => setReason(e.target.value)} className="w-full rounded-lg border p-2"/><div className="flex gap-2"><button disabled={loading || proposal.status !== 'PENDING_APPROVAL'} onClick={() => onDecision('approve', reason)} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-40">批准</button><button disabled={loading || proposal.status !== 'PENDING_APPROVAL'} onClick={() => onDecision('reject', reason)} className="rounded-lg bg-red-600 px-4 py-2 text-white disabled:opacity-40">拒绝</button></div></div> : <p className="text-sm text-slate-500">当前案例没有待审批动作。</p>}</Card> }

function ExecutionView({ snapshot }: { snapshot?: Snapshot }) { return <Card title="执行与人工处理">{snapshot?.executions.length ? <div className="space-y-2">{snapshot.executions.map(item => <div key={item.requestId} className="rounded-lg border p-3 text-sm"><Badge value={item.status}/><p className="mt-2">{item.externalOperationId ? `平台操作：${item.externalOperationId}` : item.lastError ?? '等待可靠执行器返回结果'}</p><p className="mt-1 text-xs text-slate-500">重复操作会复用提案幂等键；UNKNOWN 不表示成功。</p></div>)}</div> : <p className="text-sm text-slate-500">尚无执行记录。</p>}</Card> }

function FeedbackView({ snapshot, loading, onSubmit }: { snapshot?: Snapshot; loading: boolean; onSubmit: (body: unknown) => void }) { const [kind, setKind] = useState('ACCEPT_RECOMMENDATION'); const [notes, setNotes] = useState('结论与当前经营情况一致'); const claims = useMemo(() => [...(snapshot?.report?.anomalies ?? []), ...(snapshot?.report?.hypotheses ?? []), ...(snapshot?.report?.recommendations ?? [])], [snapshot]); const [claimId, setClaimId] = useState(''); return <Card title="运营反馈（不会直接修改 Prompt 或 holdout）">{snapshot?.report && snapshot.reportVersion ? <div className="space-y-3 text-sm"><select value={kind} onChange={e => setKind(e.target.value)} className="w-full rounded-lg border p-2"><option value="ACCEPT_RECOMMENDATION">接受建议</option><option value="REJECT_RECOMMENDATION">拒绝建议</option><option value="INCORRECT_CONCLUSION">结论错误</option><option value="MISSING_DATA">缺少数据</option><option value="CORRECTION">人工纠正</option></select><select value={claimId} onChange={e => setClaimId(e.target.value)} className="w-full rounded-lg border p-2"><option value="">整份报告</option>{claims.map(item => { const id = item.factId ?? item.hypothesisId ?? item.recommendationId; return id ? <option key={id} value={id}>{id}</option> : null })}</select><textarea value={notes} onChange={e => setNotes(e.target.value)} className="min-h-24 w-full rounded-lg border p-2"/><button disabled={loading} onClick={() => onSubmit({ taskId: snapshot.task.taskId, reportId: snapshot.report!.reportId, reportVersion: snapshot.reportVersion, claimId: claimId || undefined, kind, notes, idempotencyKey: crypto.randomUUID() })} className="rounded-lg bg-cyan-600 px-4 py-2 text-white disabled:opacity-40">提交反馈</button></div> : <p className="text-sm text-slate-500">报告就绪后才能提交绑定版本的反馈。</p>}</Card> }
