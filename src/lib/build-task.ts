import type { BuildStatus, BuildTask, Prisma, Visibility } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { claimRecentMap } from '@/lib/agent-claim'

/**
 * 自动建合集任务的持久层。
 *
 * 这里存在的理由只有一个：**任务状态不能挂在浏览器的那条连接上**。
 * 之前的实现里，一次任务 = 一次 SSE 请求，用户切后台被系统丢弃标签页、刷新、
 * 跳到别的路由、或者 Clash/NAT 把长连接掐了，状态就永久消失；而 Agent 在内网工作站上
 * 照旧跑完并入库。用户看到 network error，实际上合集已经建好了 —— 连续三次报障都是这个。
 *
 * 现在任务一创建就落库，浏览器只是「看」它：断连只是少看几帧进度。
 */

/**
 * 多久没有进度更新就认为「失去跟踪」。
 *
 * 取值依据：实测一轮 1–7 分钟，其中最长的一段静默是 ASR 拉流，实测 252s 没有任何事件。
 * 因此阈值必须明显大于 252s，否则会把正在安静转写的任务误判成死任务。
 * 取 6 分钟：比最长静默多留 1 分钟余量，同时又不至于让用户对着一个已经死掉的任务干等。
 */
export const STALE_AFTER_MS = 6 * 60 * 1000

/** 进页面时愿意自动接回的任务年龄上限。再久就是历史记录，不该突然弹出来 */
export const RESUME_WINDOW_MS = 30 * 60 * 1000

export interface BuildStep {
  /** 相对任务开始的秒数 */
  t: number
  message: string
}

export interface CreateBuildInput {
  userId: string
  source: string
  city?: string
  title?: string
  visibility?: Visibility
}

/** 前端拿到的时间线步骤上限。超过就丢弃最早的，避免 JSON 字段无限膨胀 */
export const MAX_STEPS = 400

export async function createBuildTask(input: CreateBuildInput): Promise<BuildTask> {
  return prisma.buildTask.create({
    data: {
      userId: input.userId,
      source: input.source,
      city: input.city ?? null,
      title: input.title ?? null,
      visibility: input.visibility ?? 'UNLISTED',
      status: 'RUNNING',
    },
  })
}

/** 同一用户当前正在跑的任务。有就复用，不让用户重复点出第二条并发任务。 */
export async function findRunningTask(userId: string): Promise<BuildTask | null> {
  return prisma.buildTask.findFirst({
    where: { userId, status: 'RUNNING' },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getBuildTask(id: string, userId: string): Promise<BuildTask | null> {
  return prisma.buildTask.findFirst({ where: { id, userId } })
}

/**
 * 直接标成「已中断」。
 *
 * 正常路径是执行器收到 abort 后自己写 CANCELED；这里额外写一次是为了**立刻**给前端
 * 反馈 —— 执行器要等 for-await 退出才收尾，中间可能隔几秒。两边都写 CANCELED，
 * 谁后写都无所谓（执行器那份会带上 Agent 的最后一句原话）。
 *
 * 进程重启过的情况则只能靠这里：内存里已经没有对应执行器了。
 */
export async function markTaskCanceled(id: string): Promise<BuildTask | null> {
  return prisma.buildTask
    .update({
      where: { id },
      data: {
        status: 'CANCELED',
        error: '你中断了这轮任务。平台已停止追踪，但 Agent 侧的任务不保证随之停止。',
        finishedAt: new Date(),
      },
    })
    .catch(() => null)
}

/**
 * 进入页面时该接回哪个任务：优先「还在跑」，其次「刚结束不久」。
 *
 * 后者是有用的：用户很可能就是想回来看看「我那个到底成没成」，而不是重新发一次。
 * 超过 RESUME_WINDOW_MS 就不给了 —— 那是我的合集该管的事，不是这个面板。
 */
export async function findResumableTask(userId: string): Promise<BuildTask | null> {
  const running = await findRunningTask(userId)
  if (running) return running
  return prisma.buildTask.findFirst({
    where: {
      userId,
      status: { in: ['COMPLETED', 'FAILED', 'STALE'] },
      createdAt: { gte: new Date(Date.now() - RESUME_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * 回收「进程重启后没人管」的任务。
 *
 * Next.js 自建 next start 是单进程长驻，执行器（build-runner）把任务挂在模块级 Map 里。
 * 一旦进程重启，那些任务就再没人写状态了，会永远停在 RUNNING，前端会一直转。
 *
 * 所以查询路径上顺手做一次惰性回收：超过 STALE_AFTER_MS 没更新，就判定失去跟踪。
 * 回收时**仍然要试着把产物找回来** —— Agent 不在这个进程里，它多半已经建好了，
 * 判据与断流兜底完全一致（ownerId + createdAt >= 任务开始时刻）。
 */
export async function reapStaleTasks(userId: string): Promise<number> {
  const stale = await prisma.buildTask.findMany({
    where: {
      userId,
      status: 'RUNNING',
      updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  let reaped = 0
  for (const t of stale) {
    let data: Prisma.BuildTaskUpdateInput
    try {
      const claimed = await claimRecentMap(userId, t.createdAt.getTime())
      data = claimed
        ? {
            status: 'COMPLETED',
            mapId: claimed.mapId,
            result: {
              mapId: claimed.mapId,
              title: claimed.title,
              city: claimed.city,
              added: claimed.added,
              visibility: claimed.visibility,
              recovered: true,
            },
            message: `平台在这轮任务结束前就重启了，但它在失去跟踪之后仍然建好了：${claimed.title}`,
            finishedAt: new Date(),
          }
        : {
            status: 'STALE',
            error: '平台重启后失去了这轮任务的跟踪，也没找到对应产物。先去「我的合集」确认，再决定要不要重试。',
            finishedAt: new Date(),
          }
    } catch {
      data = {
        status: 'STALE',
        error: '平台重启后失去了这轮任务的跟踪（回收时查库失败）。',
        finishedAt: new Date(),
      }
    }
    await prisma.buildTask
      .update({ where: { id: t.id }, data })
      .catch(() => undefined)
    reaped += 1
  }
  return reaped
}

export interface SerializedBuildTask {
  id: string
  status: BuildStatus
  source: string
  city: string | null
  title: string | null
  visibility: Visibility
  progress: string | null
  steps: BuildStep[]
  result: Record<string, unknown> | null
  mapId: string | null
  message: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  /** 已运行的毫秒数：前端恢复计时器靠它，不用自己猜 */
  elapsedMs: number
}

/** DB 行 → 前端可用的 JSON（Date 转 ISO，Json 字段兜底成 null） */
export function serializeTask(t: BuildTask): SerializedBuildTask {
  const end = t.finishedAt ?? new Date()
  return {
    id: t.id,
    status: t.status,
    source: t.source,
    city: t.city,
    title: t.title,
    visibility: t.visibility,
    progress: t.progress,
    steps: Array.isArray(t.steps) ? (t.steps as unknown as BuildStep[]) : [],
    result: (t.result as Record<string, unknown> | null) ?? null,
    mapId: t.mapId,
    message: t.message,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
    elapsedMs: end.getTime() - t.createdAt.getTime(),
  }
}
