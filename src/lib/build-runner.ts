import { agentConfig, streamBuildTask } from '@/lib/agent'
import { claimRecentMap } from '@/lib/agent-claim'
import { signTaskToken } from '@/lib/auth'
import { MAX_STEPS, type BuildStep } from '@/lib/build-task'
import { prisma } from '@/lib/prisma'

/**
 * 建合集任务的后台执行器。
 *
 * 它**不挂在 HTTP 请求上**：会话层的 `POST /api/agent/build` 建完任务就返回 202，
 * 由这里在进程内继续跑，进度写库。浏览器随时可以走，回来再看库里的状态。
 *
 * 为什么可以这样：自建 `next start` 是单进程长驻，模块级 Map 活得比任何请求都长。
 * 进程重启会丢跟踪 —— 那是 `reapStaleTasks()` 负责的事，不是这里的职责。
 *
 * 为什么不能 abort 掉 Agent：Agent 跑在内网工作站上，是独立进程。平台断开会话
 * 只是不再"看"，它照旧跑完并回写平台。所以除了用户显式取消，这里从不主动掐流。
 */

/** 进度落库的合并间隔。一轮任务实测几十条事件，逐条 UPDATE 没必要，1.5s 一次足够 */
const FLUSH_MS = 1500

/** 存活心跳间隔。必须明显小于 build-task 的 STALE_AFTER_MS（6 分钟） */
const TOUCH_MS = 45 * 1000

interface RunningTask {
  ctl: AbortController
  /** 用户主动点了「中断」。收尾时必须写 CANCELED，不能写成失败 */
  canceled: boolean
}

/**
 * 正在执行的任务。key 是 BuildTask.id。
 *
 * 只在**进程内存**里，因为它唯一的作用是「同一任务别跑两遍」和「让取消能找到
 * 那个 AbortController」。任务状态的真相在库里，不在这里。
 */
const running = new Map<string, RunningTask>()

export function isTaskRunning(taskId: string): boolean {
  return running.has(taskId)
}

/** 用户点「中断」：停止追踪，写 CANCELED。Agent 侧的子进程不保证随之回收。 */
export function cancelBuildTask(taskId: string): boolean {
  const entry = running.get(taskId)
  if (!entry) return false
  entry.canceled = true
  entry.ctl.abort()
  return true
}

/**
 * 起一轮任务。**不要 await 它** —— 函数立刻返回，任务在后台跑。
 *
 * 重复调用同一个 taskId 是安全的（比如两个 tab 同时点恢复），第二次直接忽略。
 */
export function launchBuildTask(taskId: string): void {
  if (running.has(taskId)) return
  const entry: RunningTask = { ctl: new AbortController(), canceled: false }
  running.set(taskId, entry)
  void execute(taskId, entry)
    .catch((e) => {
      // 执行器自身出错不能静默：否则任务永远停在 RUNNING，前端一直转
      console.error(
        JSON.stringify({ evt: 'build_task_crash', taskId, error: String(e).slice(0, 300) }),
      )
      return prisma.buildTask
        .update({
          where: { id: taskId },
          data: {
            status: 'FAILED',
            error: '服务端执行任务时出了意外错误：' + String(e).slice(0, 200),
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined)
    })
    .finally(() => {
      running.delete(taskId)
    })
}

async function execute(taskId: string, entry: RunningTask): Promise<void> {
  const task = await prisma.buildTask.findUnique({
    where: { id: taskId },
    include: { user: { select: { id: true, email: true } } },
  })
  if (!task) return

  const startedAt = task.createdAt.getTime()
  const steps: BuildStep[] = []

  // 串行写入链：进度是高频事件，并发 UPDATE 会乱序，而且没必要。
  // 所有写入排队，收尾时 await 一次就能保证「终态一定是最后写的」。
  let chain: Promise<void> = Promise.resolve()
  let dirty = false

  const flush = () => {
    if (!dirty) return
    dirty = false
    const snapshot = steps.slice()
    const progress = snapshot.length > 0 ? snapshot[snapshot.length - 1].message : null
    chain = chain
      .then(() =>
        prisma.buildTask
          .update({
            where: { id: taskId },
            // steps 是 Json 列，Prisma 要的是 InputJsonValue；结构由 BuildStep 保证
            data: { steps: snapshot as unknown as object[], progress },
          })
          .then(() => undefined),
      )
      .catch(() => undefined)
  }

  const timer = setInterval(flush, FLUSH_MS)

  /**
   * 存活心跳：每 45 秒无条件碰一下 updatedAt。
   *
   * 没有它，「失去跟踪」的判据会退化成「多久没进度」—— 而 ASR 转写阶段实测能静默
   * 252 秒一条事件都没有，那个判据就不可靠了。有了它，updatedAt 衡量的是
   * **执行器进程还活着吗**，reapStaleTasks 的 6 分钟阈值才有意义。
   */
  const heartbeat = setInterval(() => {
    chain = chain
      .then(() =>
        prisma.buildTask
          .update({ where: { id: taskId }, data: { updatedAt: new Date() } })
          .then(() => undefined),
      )
      .catch(() => undefined)
  }, TOUCH_MS)

  let finalState = 'stream_open'
  let finalMessage = ''
  let artifact: Record<string, unknown> | null = null
  let transportError: string | null = null

  const cfg = agentConfig()
  if (!cfg) {
    clearInterval(timer)
    clearInterval(heartbeat)
    await finish(taskId, {
      status: 'FAILED',
      error: 'Agent 未接入：缺少 AGENT_A2A_BASE_URL / AGENT_A2A_TOKEN',
    })
    return
  }

  const data: Record<string, unknown> = {
    userId: task.userId,
    accessToken: signTaskToken(task.user),
  }
  if (task.city) data.city = task.city
  if (task.title) data.title = task.title
  if (task.visibility) data.visibility = task.visibility

  try {
    for await (const ev of streamBuildTask(
      cfg,
      { source: task.source, data },
      entry.ctl.signal,
    )) {
      if (ev.type === 'progress') {
        steps.push({ t: Math.round((Date.now() - startedAt) / 1000), message: ev.message })
        if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS)
        dirty = true
      } else if (ev.type === 'artifact') {
        artifact = ev.data
      } else if (ev.type === 'done') {
        finalState = ev.state
        finalMessage = ev.message
      } else if (ev.type === 'error') {
        transportError = ev.message
        finalState = 'stream_error'
      }
    }
  } catch (e) {
    finalState = 'throw'
    transportError = e instanceof Error ? e.message : String(e)
  } finally {
    clearInterval(timer)
    clearInterval(heartbeat)
  }

  // 中断判定要在写终态之前：cancelBuildTask 会把 abort 打进来，
  // 上面的 for-await 会以错误结束，但那不是失败，是用户让它停的。
  if (entry.canceled) {
    await flushThenFinish(taskId, chain, {
      status: 'CANCELED',
      message: finalMessage || null,
      error: '你中断了这轮任务。平台已停止追踪，但 Agent 侧的任务不保证随之停止。',
    })
    logEnd(taskId, startedAt, 'canceled', Boolean(artifact), null, finalMessage)
    return
  }

  // 1) Agent 给了产出 —— 成功，无论它最后那句话说了什么
  if (artifact) {
    const mapId = typeof artifact.mapId === 'string' ? artifact.mapId : null
    await flushThenFinish(taskId, chain, {
      status: 'COMPLETED',
      result: artifact as object,
      mapId,
      message: finalMessage || null,
      error: null,
    })
    logEnd(taskId, startedAt, finalState, true, mapId, finalMessage)
    return
  }

  // 2) 明确的终态但没有产出
  if (finalState === 'rejected' || finalState === 'input-required' || finalState === 'failed' || finalState === 'completed') {
    const error =
      finalMessage ||
      (finalState === 'input-required'
        ? 'Agent 还缺一点信息（比如城市），补上后再试一次。'
        : finalState === 'rejected'
          ? 'Agent 拒绝了这类内容。换一条链接，或者改用「手动填写」。'
          : 'Agent 结束了这轮任务，但没有产出合集。')
    await flushThenFinish(taskId, chain, { status: 'FAILED', message: finalMessage || null, error })
    logEnd(taskId, startedAt, finalState, false, null, finalMessage)
    return
  }

  // 3) 传输层断了 / 抛错 / EOF 没终态 —— 断的是平台↔Agent 的连接。
  //    Agent 那边的任务不受影响，很可能已经建好了，用硬约束把产物认领回来。
  let recoveredId: string | null = null
  try {
    const claimed = await claimRecentMap(task.userId, startedAt)
    if (claimed) {
      recoveredId = claimed.mapId
      await flushThenFinish(taskId, chain, {
        status: 'COMPLETED',
        result: {
          mapId: claimed.mapId,
          title: claimed.title,
          city: claimed.city,
          added: claimed.added,
          visibility: claimed.visibility,
          recovered: true,
        },
        mapId: claimed.mapId,
        message: `平台没收到 Agent 的回复，但它在断流之后仍然建好了：${claimed.title}`,
        error: null,
      })
      logEnd(taskId, startedAt, 'recovered', true, recoveredId, finalMessage)
      return
    }
  } catch (e) {
    console.error(
      JSON.stringify({ evt: 'build_task_recover_failed', taskId, error: String(e).slice(0, 200) }),
    )
  }

  const err = transportError || '连接结束了，但没收到最终结果'
  await flushThenFinish(taskId, chain, {
    status: 'FAILED',
    message: finalMessage || null,
    error: `${err}（Agent 那边可能仍在跑。先去「我的合集」确认，别急着重试。）`,
  })
  logEnd(taskId, startedAt, finalState, false, null, transportError || finalMessage)
}

interface FinishPatch {
  status: 'COMPLETED' | 'FAILED' | 'CANCELED'
  result?: object
  mapId?: string | null
  message?: string | null
  error?: string | null
}

/** 先等排队的进度写完，再写终态：保证终态不会被一条迟到的进度覆盖 */
async function flushThenFinish(
  taskId: string,
  chain: Promise<void>,
  patch: FinishPatch,
): Promise<void> {
  await chain.catch(() => undefined)
  await finish(taskId, patch)
}

async function finish(taskId: string, patch: FinishPatch): Promise<void> {
  await prisma.buildTask
    .update({
      where: { id: taskId },
      data: {
        status: patch.status,
        result: (patch.result as object | undefined) ?? undefined,
        mapId: patch.mapId ?? undefined,
        message: patch.message ?? undefined,
        error: patch.error ?? undefined,
        finishedAt: new Date(),
      },
    })
    .catch((e) => {
      console.error(
        JSON.stringify({ evt: 'build_task_finish_failed', taskId, error: String(e).slice(0, 200) }),
      )
    })
}

/**
 * 一行结构化日志收尾。journalctl 里 `grep build_task` 就能对上用户报的时间点：
 * 之前这里是完全静默的，用户说「生成失败了」时服务器上一点痕迹都没有。
 */
function logEnd(
  taskId: string,
  startedAt: number,
  state: string,
  hasResult: boolean,
  mapId: string | null,
  message: string,
): void {
  console.log(
    JSON.stringify({
      evt: 'agent_task_end',
      taskId,
      ms: Date.now() - startedAt,
      state,
      hasArtifact: hasResult,
      mapId,
      message: (message || '').slice(0, 300),
    }),
  )
}
