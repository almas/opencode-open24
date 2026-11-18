import { appendFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

/**
 * open24 — 24/7 自動継続プラグイン
 *
 * - シェル実行のタイムアウトを引き上げる（既定 24 時間）
 * - セッションが止まったら一定時間後に自動で続行プロンプトを送る
 * - 失敗時は次のモデル（フルモデル → ローカル）へ切り替えて再開する
 * - `/open24 on|off|status|full` コマンドで制御
 */

type FallbackModel = { providerID: string; modelID: string }

interface Settings {
  enabled: boolean
  armByDefault: boolean
  armOnToolUse: boolean
  delaySeconds: number
  backoffFactor: number
  maxDelaySeconds: number
  shellTimeoutMs: number
  fallbackModels: FallbackModel[]
  continuePrompt: string
  idleToken: string
  noToolSoftLimit: number
  retryBaseDelayMs: number
}

const IDLE_TOKEN_DEFAULT = "[[OPEN24-IDLE]]"

const DEFAULTS: Settings = {
  enabled: true,
  armByDefault: false,
  armOnToolUse: true,
  delaySeconds: 20,
  backoffFactor: 2,
  maxDelaySeconds: 600,
  shellTimeoutMs: 86_400_000,
  fallbackModels: [
    { providerID: "opencode", modelID: "deepseek-v4.1-flash" },
    { providerID: "strata", modelID: "qwen3.8-flash-next-unsloth-q8_0" },
  ],
  continuePrompt:
    "前回のターンで未完了の作業が残っている場合のみ、その続きを実行してください。" +
    "新しい作業を始めないでください。" +
    "作業が残っていない場合は、ツールを呼ばずに " +
    IDLE_TOKEN_DEFAULT +
    " とだけ出力してください。",
  idleToken: IDLE_TOKEN_DEFAULT,
  noToolSoftLimit: 8,
  retryBaseDelayMs: 15_000,
}

interface SessionState {
  timer?: ReturnType<typeof setTimeout>
  armed?: boolean
  noTool: number
  failures: number
  modelCursor: number
  sent: number
  lastCompleteAt?: number
}

function readSettings(raw: Readonly<Record<string, any>>): Settings {
  const num = (v: unknown, fallback: number, min: number): number => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
    return Number.isFinite(n) && n >= min ? n : fallback
  }
  const models: FallbackModel[] = Array.isArray(raw.fallbackModels)
    ? raw.fallbackModels
        .filter((m: any) => m && typeof m.providerID === "string" && typeof m.modelID === "string")
        .map((m: any) => ({ providerID: m.providerID, modelID: m.modelID }))
    : DEFAULTS.fallbackModels
  return {
    enabled: raw.enabled !== false,
    armByDefault: raw.armByDefault === true,
    armOnToolUse: raw.armOnToolUse !== false,
    delaySeconds: num(raw.delaySeconds, DEFAULTS.delaySeconds, 0),
    backoffFactor: num(raw.backoffFactor, DEFAULTS.backoffFactor, 1),
    maxDelaySeconds: num(raw.maxDelaySeconds, DEFAULTS.maxDelaySeconds, 1),
    shellTimeoutMs: num(raw.shellTimeoutMs, DEFAULTS.shellTimeoutMs, 0),
    fallbackModels: models,
    continuePrompt: typeof raw.continuePrompt === "string" ? raw.continuePrompt : DEFAULTS.continuePrompt,
    idleToken: typeof raw.idleToken === "string" ? raw.idleToken : DEFAULTS.idleToken,
    noToolSoftLimit: num(raw.noToolSoftLimit, DEFAULTS.noToolSoftLimit, 0),
    retryBaseDelayMs: num(raw.retryBaseDelayMs, DEFAULTS.retryBaseDelayMs, 0),
  }
}

export default Plugin.define({
  id: "open24",
  async setup(ctx) {
    const cfg = readSettings(ctx.options)
    if (!cfg.enabled) {
      console.log("[open24] disabled by options")
      return
    }

    const states = new Map<string, SessionState>()
    const stateOf = (sessionID: string): SessionState => {
      let state = states.get(sessionID)
      if (!state) {
        state = { noTool: 0, failures: 0, modelCursor: 0, sent: 0 }
        states.set(sessionID, state)
      }
      return state
    }

    const log = (...args: unknown[]) => console.log("[open24]", ...args)
    const trace = (...args: unknown[]) => {
      try {
        appendFileSync("/tmp/open24.log", `${new Date().toISOString()} ${args.map(String).join(" ")}\n`)
      } catch {}
    }
    trace("setup", JSON.stringify({ delaySeconds: cfg.delaySeconds, armByDefault: cfg.armByDefault }))

    const armedKey = (sessionID: string) => `armed/${sessionID}`

    const explicitArmed = async (sessionID: string): Promise<boolean | undefined> => {
      const state = stateOf(sessionID)
      if (state.armed !== undefined) return state.armed
      try {
        const stored = await ctx.storage.get(armedKey(sessionID))
        if (typeof stored === "boolean") state.armed = stored
      } catch {}
      return state.armed
    }

    const sessionHasTools = async (sessionID: string): Promise<boolean> => {
      try {
        const messages = await ctx.session.context({ sessionID })
        return messages.some(
          (message: any) =>
            message?.type === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((part: any) => part?.type === "tool"),
        )
      } catch {
        return false
      }
    }

    const isArmed = async (sessionID: string): Promise<boolean> => {
      const explicit = await explicitArmed(sessionID)
      if (explicit !== undefined) return explicit
      if (cfg.armByDefault) return true
      if (cfg.armOnToolUse) return await sessionHasTools(sessionID)
      return false
    }

    const setArmed = async (sessionID: string, on: boolean) => {
      const state = stateOf(sessionID)
      state.armed = on
      if (!on) cancel(state)
      try {
        await ctx.storage.set(armedKey(sessionID), on)
      } catch (error) {
        log("storage set failed", String(error))
      }
    }

    const cancel = (state: SessionState) => {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }

    const delayMs = (state: SessionState, mode: "idle" | "failure"): number => {
      const base = cfg.delaySeconds * 1000
      const exponent = mode === "failure" ? state.failures : Math.max(0, state.noTool - 1)
      const factor = Math.pow(cfg.backoffFactor, Math.min(exponent, 8))
      return Math.min(base * factor, cfg.maxDelaySeconds * 1000)
    }

    const notify = async (sessionID: string, text: string) => {
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch (error) {
        log("synthetic failed", String(error))
      }
    }

    const schedule = (sessionID: string, mode: "idle" | "failure") => {
      const state = stateOf(sessionID)
      cancel(state)
      const wait = delayMs(state, mode)
      log(`schedule ${mode} for ${sessionID} in ${Math.round(wait / 1000)}s`)
      state.timer = setTimeout(() => {
        state.timer = undefined
        void (async () => {
          try {
            if (!(await isArmed(sessionID))) return
            state.sent += 1
            await ctx.session.prompt({
              sessionID,
              text: cfg.continuePrompt,
              delivery: "queue",
            })
          } catch (error) {
            log("continue prompt failed", String(error))
            state.failures += 1
            if (await isArmed(sessionID)) schedule(sessionID, "failure")
          }
        })()
      }, wait)
    }

    const switchModel = async (sessionID: string) => {
      if (cfg.fallbackModels.length === 0) return undefined
      const state = stateOf(sessionID)
      const next = cfg.fallbackModels[state.modelCursor % cfg.fallbackModels.length]
      state.modelCursor = (state.modelCursor + 1) % cfg.fallbackModels.length
      try {
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: next.providerID, id: next.modelID },
        })
        log(`switch model ${sessionID} -> ${next.providerID}/${next.modelID}`)
        return next
      } catch (error) {
        log("switch model failed", String(error))
        return undefined
      }
    }

    const lastAssistant = async (sessionID: string): Promise<any | undefined> => {
      try {
        const messages = await ctx.session.context({ sessionID })
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index] as any
          if (message?.type === "assistant") return message
        }
      } catch (error) {
        log("context read failed", String(error))
      }
      return undefined
    }

    const onComplete = async (sessionID: string) => {
      const state = stateOf(sessionID)
      const now = Date.now()
      if (state.lastCompleteAt && now - state.lastCompleteAt < 1500) return
      state.lastCompleteAt = now
      cancel(state)
      if (!(await isArmed(sessionID))) return
      const last = await lastAssistant(sessionID)
      if (!last) return
      const content: any[] = Array.isArray(last.content) ? last.content : []
      const text = content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
      if (text.includes(cfg.idleToken)) {
        await setArmed(sessionID, false)
        trace("disarmed by idle token", sessionID)
        return
      }
      const usedTool = content.some((part) => part?.type === "tool")
      if (usedTool) {
        state.noTool = 0
        state.failures = 0
        state.modelCursor = 0
        state.sent = 0
      } else {
        state.noTool += 1
        if (cfg.noToolSoftLimit > 0 && state.noTool === cfg.noToolSoftLimit) {
          trace("no-tool soft limit reached", sessionID)
        }
      }
      if (state.failures > 0 && last.finish && last.finish !== "error") {
        state.failures = 0
      }
      schedule(sessionID, "idle")
    }

    // シェル実行タイムアウトの引き上げ
    if (cfg.shellTimeoutMs > 0) {
      await ctx.shell.hook("create.before", (event) => {
        event.timeout = Math.max(event.timeout ?? 0, cfg.shellTimeoutMs)
      })
    }

    // 失敗時は短い間隔で再試行（OpenCode 側の試行上限はそのまま）
    await ctx.session.hook("retry", (event) => {
      const status = event.error.status ?? 0
      const text = `${event.error.type} ${event.error.message}`
      const retryable =
        status === 408 ||
        status === 409 ||
        status === 425 ||
        status === 429 ||
        status >= 500 ||
        /timeout|timed out|stream|socket|network|econn|abort|overload|rate.?limit|unavailable/i.test(text)
      if (retryable) {
        const wait = Math.min(cfg.retryBaseDelayMs * Math.max(1, event.attempt - 1), 120_000)
        event.decision = { retry: true, delay: wait }
      }
    })

    // セッション状態の監視
    const controller = new AbortController()
    const types = [
      "session.idle",
      "session.execution.succeeded",
      "session.execution.started",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.deleted",
    ] as const

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: [...types], signal: controller.signal })) {
          const sessionID = (event as any)?.data?.sessionID as string | undefined
          trace("event", event.type, sessionID ?? "-")
          if (!sessionID) continue
          const state = stateOf(sessionID)

          if (event.type === "session.execution.started") {
            cancel(state)
            continue
          }

          if (event.type === "session.deleted") {
            cancel(state)
            states.delete(sessionID)
            continue
          }

          if (event.type === "session.execution.interrupted") {
            // ユーザーによる明示的な停止は尊重する
            cancel(state)
            continue
          }

          if (event.type === "session.execution.failed") {
            cancel(state)
            if (!(await isArmed(sessionID))) continue
            state.failures += 1
            state.noTool += 1
            await switchModel(sessionID)
            schedule(sessionID, "failure")
            continue
          }

          if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
            await onComplete(sessionID)
            continue
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log("event stream ended", String(error))
      }
    })()

    // 制御コマンド
    await ctx.command.transform((editor) => {
      editor.add({
        name: "open24",
        description:
          "24/7 自動継続の制御: on=有効 / off=無効 / status=状態 / full=フルモデルへ切替",
        execute: async ({ sessionID, prompt }) => {
          const arg = (prompt.text ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "status"
          const state = stateOf(sessionID)
          if (arg === "on") {
            await setArmed(sessionID, true)
            await notify(sessionID, "▶️ 自動継続を有効にしました。")
            schedule(sessionID, "idle")
            return
          }
          if (arg === "off") {
            await setArmed(sessionID, false)
            await notify(sessionID, "⏹ 自動継続を停止しました。")
            return
          }
          if (arg === "full") {
            const model = await switchModel(sessionID)
            await notify(
              sessionID,
              model
                ? `🧠 ${model.providerID}/${model.modelID} に切り替えました。`
                : "⚠️ 切替先モデルが設定されていません。",
            )
            return
          }
          const armed = await isArmed(sessionID)
          const wait = delayMs(state, "idle")
          await notify(
            sessionID,
            [
              `open24: ${armed ? "有効" : "停止中"}`,
              `待機: ${Math.round(wait / 1000)} 秒`,
              `連続送信: ${state.sent} 回`,
              `直近の失敗: ${state.failures} 回`,
              `シェル上限: ${Math.round(cfg.shellTimeoutMs / 1000)} 秒`,
            ].join(" / "),
          )
        },
      })
    })

    log("ready", {
      delaySeconds: cfg.delaySeconds,
      maxDelaySeconds: cfg.maxDelaySeconds,
      shellTimeoutMs: cfg.shellTimeoutMs,
      fallbackModels: cfg.fallbackModels,
    })

    return () => {
      controller.abort()
      for (const state of states.values()) cancel(state)
      states.clear()
    }
  },
})
